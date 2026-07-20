import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable MSE seam: `supported` stays false by default so the existing
// degraded-fallback test keeps exercising the real no-MediaSource path; the
// socket-driven suite flips it on and reads the controller call counters.
const mse = vi.hoisted(() => {
  const calls = { append: 0, end: 0, destroy: 0 };
  return {
    supported: false,
    calls,
    controller: {
      appendPacket: async () => {
        calls.append += 1;
      },
      endOfStream: () => {
        calls.end += 1;
      },
      destroy: () => {
        calls.destroy += 1;
      },
    },
  };
});

vi.mock("./mse-player", () => ({
  canPlayLTXStream: () => mse.supported,
  attachMSE: () => mse.controller,
}));

import {
  getWSUrl,
  MAX_RECONNECTS,
  packetPlan,
  reconnectDelayMs,
  startLTXStream,
} from "./stream-client";

describe("packetPlan (resume dedup / sequence path)", () => {
  it("fresh media packet appends and advances the sequence", () => {
    expect(packetPlan({ sequence: 0 }, -1)).toEqual({
      append: true,
      end: false,
      nextLastSequence: 0,
    });
    expect(packetPlan({ sequence: 5 }, 3)).toEqual({
      append: true,
      end: false,
      nextLastSequence: 5,
    });
  });

  it("replayed duplicate after a resume is skipped, sequence unchanged", () => {
    expect(packetPlan({ sequence: 3 }, 3)).toEqual({
      append: false,
      end: false,
      nextLastSequence: 3,
    });
    // out-of-order stale packet — also skipped, never rewinds
    expect(packetPlan({ sequence: 1 }, 3)).toEqual({
      append: false,
      end: false,
      nextLastSequence: 3,
    });
  });

  it("a duplicate carrying `final` still ends the stream", () => {
    expect(packetPlan({ sequence: 3, final: true }, 3)).toEqual({
      append: false,
      end: true,
      nextLastSequence: 3,
    });
  });

  it("init segments always append and never advance the media sequence", () => {
    // A re-dial needs the codec init again even when its sequence looks stale.
    expect(packetPlan({ sequence: 0, is_init_segment: true }, 7)).toEqual({
      append: true,
      end: false,
      nextLastSequence: 7,
    });
  });

  it("final on a fresh packet appends AND ends", () => {
    expect(packetPlan({ sequence: 9, final: true }, 8)).toEqual({
      append: true,
      end: true,
      nextLastSequence: 9,
    });
  });
});

describe("reconnectDelayMs", () => {
  it("backs off 500ms → 1s → 2s, capped at 4s", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(5)).toBe(4000);
    expect(MAX_RECONNECTS).toBeGreaterThan(0);
  });
});

describe("startLTXStream degraded fallback", () => {
  it("no MediaSource (this test env) → degraded_to_image immediately, no socket", () => {
    const onStatus = vi.fn();
    const onError = vi.fn();
    const client = startLTXStream({
      wsUrl: "ws://nowhere.invalid",
      video: document.createElement("video"),
      prompt: "p",
      startImageDataUrl: "data:image/jpeg;base64,x",
      onStatus,
      onError,
    });
    expect(client.status).toBe("degraded_to_image");
    expect(onStatus).toHaveBeenCalledWith("degraded_to_image");
    expect(onError).toHaveBeenCalled();
    client.close(); // noop, must not throw
  });
});

// ── Hand-driven socket harness (FakeEventSource pattern, WS flavour) ─────────

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  binaryType = "";
  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  private listeners = new Map<string, ((ev: never) => unknown)[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: never) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  /** Drive a listener set by hand; awaits async handlers (the message path). */
  async fire(type: string, ev: unknown = {}): Promise<void> {
    for (const fn of this.listeners.get(type) ?? []) {
      await (fn as (e: unknown) => unknown)(ev);
    }
  }
  async open(): Promise<void> {
    this.readyState = 1;
    await this.fire("open");
  }
  startMessage(): { action: string; position: number; session_id: string } {
    return JSON.parse(this.sent[0]!) as never;
  }
}

/** Build a real binary LTXF frame ("LTXF" + BE header length + JSON + payload)
 *  so the parse path runs for real instead of being mocked. */
function ltxfFrame(header: Record<string, unknown>, payloadLen = 4): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(8 + json.length + payloadLen);
  buf.set([0x4c, 0x54, 0x58, 0x46], 0); // "LTXF"
  new DataView(buf.buffer).setUint32(4, json.length);
  buf.set(json, 8);
  return buf.buffer;
}

describe("startLTXStream over a hand-driven fake socket", () => {
  const media = (sequence: number, extra: Record<string, unknown> = {}) =>
    ltxfFrame({ media_type: "video/mp4", sequence, ...extra });

  let onStatus: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let plays: number;

  function start() {
    const video = document.createElement("video");
    (video as { play: () => Promise<void> }).play = () => {
      plays += 1;
      return Promise.resolve();
    };
    return startLTXStream({
      wsUrl: "ws://worker.test/stream",
      video,
      prompt: "a windmill",
      startImageDataUrl: "data:image/jpeg;base64,abc",
      onStatus,
      onError,
    });
  }
  const ws = (i = 0) => FakeWebSocket.instances[i]!;

  beforeEach(() => {
    mse.supported = true;
    mse.calls.append = 0;
    mse.calls.end = 0;
    mse.calls.destroy = 0;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    onStatus = vi.fn();
    onError = vi.fn();
    plays = 0;
  });
  afterEach(() => {
    mse.supported = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("dials, sends the start message on open, and waits for the first chunk", async () => {
    const client = start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws().url).toBe("ws://worker.test/stream");
    expect(ws().binaryType).toBe("arraybuffer");
    await ws().open();
    const msg = JSON.parse(ws().sent[0]!);
    expect(msg.action).toBe("start");
    expect(msg.position).toBe(0); // fresh stream
    expect(msg.prompt).toBe("a windmill");
    expect(msg.session_id).toMatch(/^ltx_stream_/);
    expect(msg.loopy_mode).toBe(true);
    expect(client.status).toBe("waiting_for_first_chunk");
  });

  it("appends packets, flips to playing once, skips dups, ends on final", async () => {
    const client = start();
    await ws().open();
    await ws().fire("message", { data: ltxfFrame({ media_type: "video/mp4", sequence: 0, is_init_segment: true }) });
    expect(mse.calls.append).toBe(1); // init always appends
    expect(client.status).toBe("playing");
    expect(plays).toBe(1);
    await ws().fire("message", { data: media(0) });
    await ws().fire("message", { data: media(1) });
    expect(mse.calls.append).toBe(3);
    expect(plays).toBe(1); // playing latched — no re-play per packet
    await ws().fire("message", { data: media(1) }); // resume replay dup
    expect(mse.calls.append).toBe(3);
    await ws().fire("message", { data: "not-binary" }); // ignored
    expect(mse.calls.append).toBe(3);
    await ws().fire("message", { data: media(2, { final: true }) });
    expect(mse.calls.append).toBe(4);
    expect(mse.calls.end).toBe(1);
    // The close that follows `final` neither re-dials nor double-ends.
    await ws().fire("close", { code: 1006 });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mse.calls.end).toBe(1);
    expect(client.status).toBe("playing");
  });

  it("a clean 1000 close without final ends playback gracefully", async () => {
    start();
    await ws().open();
    await ws().fire("message", { data: media(0) });
    await ws().fire("close", { code: 1000 });
    expect(mse.calls.end).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("corrupt frame → error status, and the following close does not retry", async () => {
    const client = start();
    await ws().open();
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer; // wrong magic
    await ws().fire("message", { data: bad });
    expect(client.status).toBe("error");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("LTXF"));
    await ws().fire("close", { code: 1006 });
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect on corrupt data
  });

  it("a dropped socket re-dials after backoff and resumes the SAME session", async () => {
    const client = start();
    await ws().open();
    await ws().fire("message", { data: media(0) });
    await ws().fire("message", { data: media(1) });
    await ws().fire("close", { code: 1006 });
    expect(FakeWebSocket.instances).toHaveLength(1); // not before the timer
    vi.advanceTimersByTime(reconnectDelayMs(0));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await ws(1).open();
    const resumed = ws(1).startMessage();
    expect(resumed.position).toBe(2); // lastSequence + 1
    expect(resumed.session_id).toBe(ws(0).startMessage().session_id);
    // Mid-stream resume must not regress the visible status to "waiting".
    expect(client.status).toBe("playing");
  });

  it("gives up after MAX_RECONNECTS drops with a friendly error", async () => {
    const client = start();
    await ws().open();
    for (let attempt = 0; attempt < MAX_RECONNECTS; attempt += 1) {
      await ws(attempt).fire("close", { code: 1006 });
      vi.advanceTimersByTime(reconnectDelayMs(attempt));
      expect(FakeWebSocket.instances).toHaveLength(attempt + 2);
      await ws(attempt + 1).open();
    }
    await ws(MAX_RECONNECTS).fire("close", { code: 1006 });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(MAX_RECONNECTS + 1);
    expect(client.status).toBe("error");
    expect(onError).toHaveBeenCalledWith("Stream dropped and could not be resumed.");
  });

  it("close() tears down: cancels the pending re-dial, destroys MSE, closes 1000", async () => {
    const client = start();
    await ws().open();
    await ws().fire("close", { code: 1006 }); // reconnect now pending
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // timer cancelled
    expect(mse.calls.destroy).toBe(1);

    // An OPEN socket gets the clean close code on user close.
    const client2 = start();
    await ws(1).open();
    client2.close();
    expect(ws(1).closedWith).toBe(1000);
    await ws(1).fire("close", { code: 1000 }); // browser follows up — no retry
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("getWSUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the configured worker URL, or null when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_LTX_WS_URL", "ws://worker.example/ltx");
    expect(getWSUrl()).toBe("ws://worker.example/ltx");
    vi.stubEnv("NEXT_PUBLIC_LTX_WS_URL", "");
    expect(getWSUrl()).toBeNull();
  });
});
