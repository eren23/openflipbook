import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trace", () => ({
  emit: vi.fn(),
  nowMs: vi.fn(() => 42),
}));

import { emit } from "@/lib/trace";

import { type MorphFx, useImageMorph } from "./useImageMorph";

function baseFx(overrides: Partial<MorphFx> = {}): MorphFx {
  return {
    ox: 0,
    oy: 0,
    prevImg: null,
    nextImg: null,
    phase: "wait",
    isFinal: true,
    startedAt: 0,
    reduceMotion: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useImageMorph", () => {
  it("returns { morphFx: null, setMorphFx } initially", () => {
    const { result } = renderHook(() => useImageMorph(null));
    expect(result.current.morphFx).toBeNull();
    expect(typeof result.current.setMorphFx).toBe("function");
  });

  it("no morphFx → effect is a no-op (decode not called)", () => {
    const decodeSpy = vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
    renderHook(() => useImageMorph("data:image/jpeg;base64,X"));
    expect(decodeSpy).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("phase='reveal' → no-op", () => {
    const decodeSpy = vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageMorph("data:image/jpeg;base64,X"));
    act(() => {
      result.current.setMorphFx(baseFx({ phase: "reveal" }));
    });
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it("phase='wait' but isFinal=false → no-op", () => {
    const decodeSpy = vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageMorph("data:image/jpeg;base64,X"));
    act(() => {
      result.current.setMorphFx(baseFx({ isFinal: false }));
    });
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it("prevImg === currentImageDataUrl (no change) → no-op", () => {
    const decodeSpy = vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
    const url = "data:image/jpeg;base64,SAME";
    const { result } = renderHook(() => useImageMorph(url));
    act(() => {
      result.current.setMorphFx(baseFx({ prevImg: url }));
    });
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it("happy path: decode resolves → phase flips to 'reveal' with nextImg + emits image:decode", async () => {
    const decodeSpy = vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
    const url = "data:image/jpeg;base64,NEW";
    const { result } = renderHook(() => useImageMorph(url));
    await act(async () => {
      result.current.setMorphFx(baseFx());
    });
    // Flush the resolved decode microtask.
    await act(async () => {
      await Promise.resolve();
    });

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(result.current.morphFx?.phase).toBe("reveal");
    expect(result.current.morphFx?.nextImg).toBe(url);
    expect(emit).toHaveBeenCalledWith("image:decode", expect.objectContaining({ ms: expect.any(Number) }));
  });

  it("catch path: decode rejects → still transitions to 'reveal' (finish runs in catch)", async () => {
    const decodeSpy = vi.spyOn(Image.prototype, "decode").mockRejectedValue(new Error("boom"));
    const url = "data:image/jpeg;base64,REJECT";
    const { result } = renderHook(() => useImageMorph(url));
    await act(async () => {
      result.current.setMorphFx(baseFx());
    });
    // Flush both the rejected promise and the .catch continuation.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(result.current.morphFx?.phase).toBe("reveal");
    expect(result.current.morphFx?.nextImg).toBe(url);
    expect(emit).toHaveBeenCalledWith("image:decode", expect.objectContaining({ ms: expect.any(Number) }));
  });
});
