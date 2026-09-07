import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.NEXT_PUBLIC_WORLD_IDENTITY_STRICT = "true"; });
import { useAscend } from "./useAscend";
const root = { nodeId: "root", query: "Town", imageDataUrl: "source", aspectRatio: "16:9" as const };
const ready = { type: "ascend_ready", page_title: "Region", image_data_url: "candidate", scale_tier: "region" };
function stream(event: unknown) { return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); c.close(); } }); }
afterEach(() => vi.unstubAllGlobals());
describe("strict OUTWARD publication", () => {
  it.each([undefined, { accepted: false }, { accepted: true, same_place: null, medium: 9, conformance: 9 }])("never persists an unverified candidate %j", async verdict => {
    const fetcher = vi.fn(async () => ({ ok: true, body: stream({ ...ready, view_verdict: verdict }) }));
    vi.stubGlobal("fetch", fetcher);
    const onAscended = vi.fn(); const { result } = renderHook(() => useAscend(onAscended, "root"));
    act(() => result.current.start("world", root));
    await waitFor(() => expect(result.current.candidate).toBe("candidate"));
    expect(onAscended).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    act(() => result.current.dismiss()); expect(result.current.candidate).toBeNull();
  });
  it("ignores a late result after navigating to a different node", async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise(r => { resolve = r; })); vi.stubGlobal("fetch", fetcher);
    const onAscended = vi.fn(); const { result, rerender } = renderHook(({ id }) => useAscend(onAscended, id), { initialProps: { id: "root" } });
    act(() => result.current.start("world", root));
    rerender({ id: "different" });
    await act(async () => resolve({ ok: true, body: stream({ ...ready, view_verdict: { accepted: true, same_place: 9, medium: 9, conformance: 9 } }) }));
    expect(fetcher).toHaveBeenCalledTimes(1); expect(onAscended).not.toHaveBeenCalled(); expect(result.current.pending).toBe(false);
  });
});
