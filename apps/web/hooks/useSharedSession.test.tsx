// Read-along shared sessions: presence heartbeat → viewer count, the feed's
// node_added → incoming chip (own pages filtered out), the standalone-Mongo
// `unsupported` degrade, and teardown. EventSource is faked so tests drive
// the feed by hand.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSharedSession } from "./useSharedSession";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(evt: unknown) {
    this.onmessage?.({ data: JSON.stringify(evt) });
  }
  emitRaw(data: string) {
    this.onmessage?.({ data });
  }
}

function stubFetch(viewers: number | null = 1) {
  const fn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
    ok: viewers !== null,
    json: async () => ({ viewers }),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const feed = () => FakeEventSource.instances.at(-1)!;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSharedSession", () => {
  it("does nothing without a session id", async () => {
    const fn = stubFetch();
    const { result } = renderHook(() => useSharedSession(null, new Set<string>()));
    await tick();
    expect(fn).not.toHaveBeenCalled();
    expect(FakeEventSource.instances.length).toBe(0);
    expect(result.current.viewers).toBeNull();
  });

  it("heartbeats presence with a stable viewer_id and reads the count back", async () => {
    const fn = stubFetch(3);
    const { result } = renderHook(() => useSharedSession("s 1", new Set<string>()));
    await waitFor(() => expect(result.current.viewers).toBe(3));
    expect(String(fn.mock.calls[0]![0])).toBe("/api/session/s%201/presence");
    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    ) as { viewer_id: string };
    expect(body.viewer_id.length).toBeGreaterThan(0);
    // ...and the feed subscription targets the same (encoded) session.
    expect(feed().url).toBe("/api/session/s%201/events");
  });

  it("updates viewers from hello/presence feed frames", async () => {
    stubFetch(null); // heartbeat degraded; the feed carries the count
    const { result } = renderHook(() => useSharedSession("s1", new Set<string>()));
    act(() => feed().emit({ type: "hello", viewers: 2 }));
    expect(result.current.viewers).toBe(2);
    act(() => feed().emit({ type: "presence", viewers: 5 }));
    expect(result.current.viewers).toBe(5);
  });

  it("surfaces another viewer's node as incoming, and clearIncoming resets it", () => {
    stubFetch();
    const { result } = renderHook(() =>
      useSharedSession("s1", new Set<string>(["mine"])),
    );
    const node = { id: "theirs", parent_id: null, title: "Their page" };
    act(() => feed().emit({ type: "node_added", node }));
    expect(result.current.incoming).toEqual(node);
    act(() => result.current.clearIncoming());
    expect(result.current.incoming).toBeNull();
  });

  it("never echoes this tab's own pages back as incoming", () => {
    stubFetch();
    const known = new Set<string>(["mine"]);
    const { result, rerender } = renderHook(
      ({ ids }) => useSharedSession("s1", ids),
      { initialProps: { ids: known } },
    );
    act(() =>
      feed().emit({
        type: "node_added",
        node: { id: "mine", parent_id: null, title: "Mine" },
      }),
    );
    expect(result.current.incoming).toBeNull();

    // knownNodeIds is read through a live ref: a page added AFTER mount is
    // filtered too, without resubscribing.
    rerender({ ids: new Set<string>(["mine", "fresh"]) });
    expect(FakeEventSource.instances.length).toBe(1);
    act(() =>
      feed().emit({
        type: "node_added",
        node: { id: "fresh", parent_id: null, title: "Fresh" },
      }),
    );
    expect(result.current.incoming).toBeNull();
  });

  it("closes the feed on `unsupported` (standalone Mongo) and stays silent", () => {
    stubFetch();
    const { result } = renderHook(() => useSharedSession("s1", new Set<string>()));
    act(() => feed().emit({ type: "unsupported" }));
    expect(feed().closed).toBe(true);
    expect(result.current.viewers).toBeNull();
  });

  it("skips malformed frames without dying", () => {
    stubFetch();
    const { result } = renderHook(() => useSharedSession("s1", new Set<string>()));
    act(() => feed().emitRaw("not json{{"));
    act(() => feed().emit({ type: "presence", viewers: 4 }));
    expect(result.current.viewers).toBe(4);
  });

  it("tears down the feed and heartbeat on unmount", () => {
    stubFetch();
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = renderHook(() => useSharedSession("s1", new Set<string>()));
    const es = feed();
    unmount();
    expect(es.closed).toBe(true);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
