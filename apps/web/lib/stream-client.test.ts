import { describe, expect, it, vi } from "vitest";

import {
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
