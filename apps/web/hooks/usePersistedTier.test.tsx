import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useImageTier, useVideoTier } from "./usePersistedTier";

afterEach(() => {
  window.localStorage.clear();
});

describe("useImageTier", () => {
  it("defaults to 'balanced' when nothing is stored", () => {
    const { result } = renderHook(() => useImageTier());
    expect(result.current[0]).toBe("balanced");
  });

  it("hydrates from localStorage on mount", () => {
    window.localStorage.setItem("openflipbook.tier", "fast");
    const { result } = renderHook(() => useImageTier());
    expect(result.current[0]).toBe("fast");
  });

  it("ignores invalid stored values", () => {
    window.localStorage.setItem("openflipbook.tier", "ultra");
    const { result } = renderHook(() => useImageTier());
    expect(result.current[0]).toBe("balanced");
  });

  it("writes back on change but not on the first mount (avoids clobbering hydration)", () => {
    window.localStorage.setItem("openflipbook.tier", "pro");
    const { result } = renderHook(() => useImageTier());
    // first-run guard: even though the effect for `tier` re-fires after
    // hydration, it should not overwrite localStorage with the default.
    expect(window.localStorage.getItem("openflipbook.tier")).toBe("pro");
    act(() => result.current[1]("fast"));
    expect(window.localStorage.getItem("openflipbook.tier")).toBe("fast");
  });
});

describe("useVideoTier", () => {
  it("defaults to 'fast'", () => {
    const { result } = renderHook(() => useVideoTier());
    expect(result.current[0]).toBe("fast");
  });

  it("round-trips a value via localStorage", () => {
    const { result } = renderHook(() => useVideoTier());
    act(() => result.current[1]("pro"));
    expect(window.localStorage.getItem("openflipbook.videoTier")).toBe("pro");
  });
});
