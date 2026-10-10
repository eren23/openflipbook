import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ANIMATION_TIMEOUT_MS, useAnimationClip } from "./useAnimationClip";

const callbacks = () => ({ onStart: vi.fn(), onReady: vi.fn(), onError: vi.fn() });
function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("makes one request with the unchanged animation payload and returns the clip", async () => {
  const handlers = callbacks(), body = { image_data_url: "page.jpg", prompt: "Trees sway", video_tier: "fast" };
  vi.mocked(fetch).mockResolvedValue(Response.json({ video_url: "https://fal.media/clip.mp4" }));
  const { result } = renderHook(() => useAnimationClip("world:node:page.jpg", handlers));
  await act(async () => { expect(await result.current.request(body)).toBe("https://fal.media/clip.mp4"); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("/api/animate", expect.objectContaining({ method: "POST", body: JSON.stringify(body), signal: expect.any(AbortSignal) }));
  expect(handlers.onStart).toHaveBeenCalledTimes(1); expect(handlers.onReady).toHaveBeenCalledTimes(1);
  expect(handlers.onError).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("stop settles a hung transport without a timeout error or late playback", async () => {
  const handlers = callbacks(), response = pendingResponse();
  vi.mocked(fetch).mockReturnValue(response.promise);
  const { result } = renderHook(() => useAnimationClip("node", handlers));
  let done!: Promise<string | null>;
  act(() => { done = result.current.request({}); });
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  await act(async () => { result.current.cancel(); expect(await done).toBeNull(); });
  expect(signal.aborted).toBe(true); expect(handlers.onError).not.toHaveBeenCalled();
  await act(async () => { response.resolve(Response.json({ video_url: "late.mp4" })); });
  expect(handlers.onReady).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("a superseded request cannot overwrite the latest request's status or clip", async () => {
  const handlers = callbacks(), old = pendingResponse();
  vi.mocked(fetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ video_url: "latest.mp4" }));
  const { result } = renderHook(() => useAnimationClip("node", handlers));
  let previous!: Promise<string | null>;
  act(() => { previous = result.current.request({ prompt: "old" }); });
  await act(async () => { expect(await result.current.request({ prompt: "new" })).toBe("latest.mp4"); });
  expect(await previous).toBeNull();
  await act(async () => { old.resolve(Response.json({ error: "Old failure" }, { status: 500 })); });
  expect(handlers.onReady.mock.calls).toEqual([["latest.mp4"]]); expect(handlers.onError).not.toHaveBeenCalled();
});

it("navigation fences a response already received while its JSON body is pending", async () => {
  const handlers = callbacks(); let finish!: (data: unknown) => void;
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: () => new Promise(r => { finish = r; }) } as Response);
  const { result, rerender } = renderHook(({ binding }) => useAnimationClip(binding, handlers), { initialProps: { binding: "page-a" } });
  let done!: Promise<string | null>;
  await act(async () => { done = result.current.request({}); });
  rerender({ binding: "page-b" });
  await act(async () => { finish({ video_url: "old-page.mp4" }); expect(await done).toBeNull(); });
  expect(handlers.onReady).not.toHaveBeenCalled(); expect(handlers.onError).not.toHaveBeenCalled();
});

it("unmount cancels a paid response's UI work and clears its timeout", async () => {
  const handlers = callbacks(), response = pendingResponse(); vi.mocked(fetch).mockReturnValue(response.promise);
  const { result, unmount } = renderHook(() => useAnimationClip("page", handlers));
  let done!: Promise<string | null>;
  act(() => { done = result.current.request({}); }); unmount();
  await act(async () => { response.resolve(Response.json({ video_url: "late.mp4" })); expect(await done).toBeNull(); });
  expect(handlers.onReady).not.toHaveBeenCalled(); expect(handlers.onError).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("reports only the active request's timeout, even if fetch ignores abort", async () => {
  const handlers = callbacks(), response = pendingResponse(); vi.mocked(fetch).mockReturnValue(response.promise);
  const { result } = renderHook(() => useAnimationClip("page", handlers));
  let done!: Promise<string | null>;
  act(() => { done = result.current.request({}); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ANIMATION_TIMEOUT_MS); expect(await done).toBeNull(); });
  expect(handlers.onError).toHaveBeenCalledTimes(1); expect(handlers.onError).toHaveBeenCalledWith(expect.stringMatching(/timed out after 3 minutes/));
  await act(async () => { response.resolve(Response.json({ video_url: "late.mp4" })); });
  expect(handlers.onReady).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("reports a current provider failure without accepting a missing clip", async () => {
  const handlers = callbacks(); vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Provider unavailable" }, { status: 503 }));
  const { result } = renderHook(() => useAnimationClip("page", handlers));
  await act(async () => { expect(await result.current.request({})).toBeNull(); });
  expect(handlers.onError).toHaveBeenCalledWith("Provider unavailable"); expect(handlers.onReady).not.toHaveBeenCalled();
});
