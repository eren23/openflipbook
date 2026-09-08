import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpatialFrame } from "@/lib/spatial-transition";
import { decodeSpatialImage, useSpatialNavigation } from "./useSpatialNavigation";

const from: SpatialFrame = { id: "p", parentId: null, image: "parent.jpg" };
const to: SpatialFrame = { id: "c", parentId: "p", image: "child.jpg", click: { x_pct: .9, y_pct: .2 } };
const image = { naturalWidth: 1600, naturalHeight: 900 } as HTMLImageElement;
let callbacks: Map<number, FrameRequestCallback>;
let sequence: number;
function frame(time: number) { act(() => { const queue = [...callbacks.values()]; callbacks.clear(); queue.forEach(fn => fn(time)); }); }
beforeEach(() => {
  callbacks = new Map(); sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++sequence, fn); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("spatial navigation lifecycle", () => {
  it("waits for decode, reframes, holds, then commits once at the cut", async () => {
    let resolve!: (image: HTMLImageElement) => void;
    const decode = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(image);
    const commit = vi.fn();
    const { result } = renderHook(() => useSpatialNavigation(decode));
    let done!: Promise<boolean>;
    act(() => { done = result.current.navigate(from, to, commit); });
    expect(result.current.pending).toBe(true);
    expect(result.current.motion).toBeNull(); expect(commit).not.toHaveBeenCalled();
    await act(async () => { resolve(image); });
    expect(result.current.motion?.progress).toBe(0);
    frame(0); frame(450); expect(commit).not.toHaveBeenCalled();
    frame(549); expect(commit).not.toHaveBeenCalled();
    await act(async () => { frame(550); expect(await done).toBe(true); });
    expect(commit).toHaveBeenCalledTimes(1); expect(result.current.motion).toBeNull(); expect(result.current.pending).toBe(false);
  });
  it("cuts to cropped parent before reversing, without a second commit", async () => {
    const commit = vi.fn(); const decode = vi.fn().mockResolvedValue(image);
    const { result } = renderHook(() => useSpatialNavigation(decode));
    await act(async () => { void result.current.navigate(to, from, commit); });
    expect(commit).toHaveBeenCalledTimes(1); expect(result.current.motion?.progress).toBe(1);
    frame(0); frame(225); expect(result.current.motion?.progress).toBe(.5);
    await act(async () => { frame(550); });
    expect(commit).toHaveBeenCalledTimes(1); expect(result.current.motion).toBeNull();
  });
  it("retains source on destination failure and retries without generation", async () => {
    const decode = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(image);
    const commit = vi.fn(); const { result } = renderHook(() => useSpatialNavigation(decode));
    await act(async () => { expect(await result.current.navigate(from, { ...to, parentId: null }, commit)).toBe(false); });
    expect(result.current.error).toContain("Try again"); expect(commit).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.retry()).toBe(true); });
    expect(commit).toHaveBeenCalledTimes(1); expect(result.current.error).toBeNull();
  });
  it("cancels stale decodes, animation callbacks, and retry state", async () => {
    let resolve!: (image: HTMLImageElement) => void;
    const decode = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(image);
    const old = vi.fn(); const latest = vi.fn();
    const { result } = renderHook(() => useSpatialNavigation(decode));
    act(() => { void result.current.navigate(from, to, old); });
    await act(async () => { await result.current.navigate(from, { ...to, parentId: null }, latest); resolve(image); });
    expect(old).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1);
    let done!: Promise<boolean>;
    await act(async () => { done = result.current.navigate(from, to, old); });
    act(() => result.current.cancel()); frame(1000);
    expect(await done).toBe(false); expect(old).not.toHaveBeenCalled(); expect(result.current.retry()).toBeUndefined();
  });
  it("cuts for reduced motion or unavailable source pixels", async () => {
    const decode = vi.fn().mockResolvedValueOnce(image).mockRejectedValueOnce(new Error("source"));
    const commit = vi.fn(); const { result } = renderHook(() => useSpatialNavigation(decode));
    await act(async () => { expect(await result.current.navigate(from, to, commit)).toBe(true); });
    expect(commit).toHaveBeenCalledTimes(1);
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    decode.mockResolvedValue(image);
    await act(async () => { expect(await result.current.navigate(from, to, commit)).toBe(true); });
    expect(result.current.motion).toBeNull(); expect(commit).toHaveBeenCalledTimes(2);
  });
  it("unmount prevents any late commit", async () => {
    let resolve!: (image: HTMLImageElement) => void;
    const decode = () => new Promise<HTMLImageElement>(r => { resolve = r; }); const commit = vi.fn();
    const { result, unmount } = renderHook(() => useSpatialNavigation(decode));
    act(() => { void result.current.navigate(from, to, commit); });
    unmount(); await act(async () => { resolve(image); }); expect(commit).not.toHaveBeenCalled();
  });
  it("decode rejects empty images and bounds hangs", async () => {
    vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
    await expect(decodeSpatialImage("empty.jpg")).rejects.toThrow("Empty image");
    vi.spyOn(Image.prototype, "naturalWidth", "get").mockReturnValue(100);
    vi.spyOn(Image.prototype, "naturalHeight", "get").mockReturnValue(100);
    await expect(decodeSpatialImage("good.jpg")).resolves.toBeInstanceOf(Image);
    vi.useFakeTimers(); vi.mocked(Image.prototype.decode).mockImplementation(() => new Promise(() => {}));
    const hung = expect(decodeSpatialImage("hung.jpg")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15000); await hung;
  });
});
