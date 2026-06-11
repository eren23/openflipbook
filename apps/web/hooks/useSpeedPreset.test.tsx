import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  PRESET_BUNDLES,
  presetFor,
  useLoopKnobs,
  wireFields,
} from "./useSpeedPreset";

afterEach(() => {
  window.localStorage.clear();
});

describe("preset → bundle map", () => {
  it("balanced puts NOTHING on the wire — the byte-identity stop", () => {
    expect(wireFields(PRESET_BUNDLES.balanced)).toEqual({});
  });

  it("fast asks for one un-judged shot", () => {
    expect(wireFields(PRESET_BUNDLES.fast)).toEqual({
      max_attempts: 1,
      verify: false,
    });
  });

  it("quality asks for the deeper judged pass, verify omitted (it's the default)", () => {
    expect(wireFields(PRESET_BUNDLES.quality)).toEqual({ max_attempts: 3 });
  });

  it("each bundle round-trips through presetFor", () => {
    for (const preset of ["fast", "balanced", "quality"] as const) {
      const { tier, ...knobs } = PRESET_BUNDLES[preset];
      expect(presetFor(tier, knobs)).toBe(preset);
    }
  });

  it("a hand-flipped knob or tier reads as custom", () => {
    expect(presetFor("balanced", { maxAttempts: 1, verify: true })).toBe(
      "custom",
    );
    expect(presetFor("pro", { maxAttempts: 2, verify: true })).toBe("custom");
  });
});

describe("useLoopKnobs", () => {
  it("defaults to the balanced bundle", () => {
    const { result } = renderHook(() => useLoopKnobs());
    expect(result.current[0]).toEqual({ maxAttempts: 2, verify: true });
  });

  it("hydrates from localStorage on mount", () => {
    window.localStorage.setItem(
      "openflipbook.loopKnobs",
      JSON.stringify({ maxAttempts: 1, verify: false }),
    );
    const { result } = renderHook(() => useLoopKnobs());
    expect(result.current[0]).toEqual({ maxAttempts: 1, verify: false });
  });

  it("ignores garbage and out-of-range stored values", () => {
    window.localStorage.setItem("openflipbook.loopKnobs", "not json");
    expect(renderHook(() => useLoopKnobs()).result.current[0]).toEqual({
      maxAttempts: 2,
      verify: true,
    });
    window.localStorage.setItem(
      "openflipbook.loopKnobs",
      JSON.stringify({ maxAttempts: 99, verify: false }),
    );
    expect(renderHook(() => useLoopKnobs()).result.current[0]).toEqual({
      maxAttempts: 2,
      verify: true,
    });
  });

  it("writes back on change but not on the first mount", () => {
    window.localStorage.setItem(
      "openflipbook.loopKnobs",
      JSON.stringify({ maxAttempts: 3, verify: true }),
    );
    const { result } = renderHook(() => useLoopKnobs());
    expect(
      window.localStorage.getItem("openflipbook.loopKnobs"),
    ).toContain('"maxAttempts":3');
    act(() => result.current[1]({ maxAttempts: 1, verify: false }));
    expect(
      JSON.parse(window.localStorage.getItem("openflipbook.loopKnobs") ?? ""),
    ).toEqual({ maxAttempts: 1, verify: false });
  });
});
