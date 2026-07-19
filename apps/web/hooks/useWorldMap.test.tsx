// World-map hydration: fetch-on-mount, the empty-map fallback (never a null
// snapshot while a session exists), best-effort error handling, and refetch.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorldMapSnapshot } from "@openflipbook/config";

import { useWorldMap } from "./useWorldMap";

const SNAP: WorldMapSnapshot = {
  session_id: "s1",
  entities: [
    {
      id: "g1",
      entity_id: "e1",
      kind: "place",
      label: "Fort",
      pos: { x: 10, y: 20 },
      height: 5,
      footprint: { w: 4, d: 4 },
      visual: "stone fort",
      state: {},
      confidence: 0.9,
      source: "extracted",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  bounds: { x: 0, y: 0, w: 100, h: 60 },
  schema_version: 1,
  updated_at: "2026-01-01T00:00:00.000Z",
};

function stubFetch(payload: unknown = SNAP, ok = true) {
  const fn = vi.fn(async (_url: RequestInfo | URL) => ({
    ok,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useWorldMap", () => {
  it("hydrates the snapshot from /api/world/{sid}/map", async () => {
    const fn = stubFetch();
    const { result } = renderHook(() => useWorldMap("s1"));
    await waitFor(() => expect(result.current.snapshot).toEqual(SNAP));
    expect(String(fn.mock.calls[0]![0])).toBe("/api/world/s1/map");
    expect(result.current.entities).toEqual(SNAP.entities);
    expect(result.current.bounds).toEqual(SNAP.bounds);
    expect(result.current.loading).toBe(false);
  });

  it("null session: no fetch, null snapshot, empty derived state", async () => {
    const fn = stubFetch();
    const { result } = renderHook(() => useWorldMap(null));
    await tick();
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.entities).toEqual([]);
    expect(result.current.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("serves the empty-map fallback (not null) while the route says no", async () => {
    stubFetch({}, false);
    const { result } = renderHook(() => useWorldMap("s1"));
    await tick();
    expect(result.current.snapshot).toMatchObject({
      session_id: "s1",
      entities: [],
      bounds: { x: 0, y: 0, w: 0, h: 0 },
    });
    expect(result.current.loading).toBe(false);
  });

  it("a network error keeps the prior snapshot (best-effort refetch)", async () => {
    stubFetch();
    const { result } = renderHook(() => useWorldMap("s1"));
    await waitFor(() => expect(result.current.entities.length).toBe(1));

    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", boom);
    await act(() => result.current.refetch());
    expect(boom).toHaveBeenCalled();
    expect(result.current.entities.length).toBe(1); // prior snapshot survives
    expect(result.current.loading).toBe(false);
  });

  it("refetch pulls fresh geometry after a generation", async () => {
    const fn = stubFetch();
    const { result } = renderHook(() => useWorldMap("s1"));
    await waitFor(() => expect(result.current.entities.length).toBe(1));

    stubFetch({ ...SNAP, entities: [], updated_at: "2026-01-02T00:00:00.000Z" });
    await act(() => result.current.refetch());
    expect(result.current.entities).toEqual([]);
    expect(result.current.snapshot?.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(fn).toHaveBeenCalledTimes(1); // the first stub saw only the mount fetch
  });

  it("clearing the session resets the snapshot to null via refetch", async () => {
    stubFetch();
    const { result, rerender } = renderHook(({ sid }) => useWorldMap(sid), {
      initialProps: { sid: "s1" as string | null },
    });
    await waitFor(() => expect(result.current.entities.length).toBe(1));
    rerender({ sid: null });
    await waitFor(() => expect(result.current.snapshot).toBeNull());
  });
});
