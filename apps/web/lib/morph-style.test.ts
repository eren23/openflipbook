import { describe, expect, it } from "vitest";

import type { MorphFx } from "@/hooks/useImageMorph";

import { inkMorphStyle } from "./morph-style";

const baseFx: MorphFx = {
  ox: 120,
  oy: 80,
  prevImg: "data:prev",
  nextImg: null,
  phase: "wait",
  isFinal: false,
  startedAt: 0,
  reduceMotion: false,
};

describe("inkMorphStyle", () => {
  it("returns undefined when morphFx is null", () => {
    expect(inkMorphStyle(null)).toBeUndefined();
  });

  it("during wait, mask-size collapses to 0 so the incoming page is hidden", () => {
    const s = inkMorphStyle(baseFx);
    expect(s).toBeDefined();
    expect(s?.maskSize).toBe("0% 0%");
    expect(s?.WebkitMaskSize).toBe("0% 0%");
  });

  it("during reveal, mask-size expands well past the viewport so the page fully shows", () => {
    const s = inkMorphStyle({ ...baseFx, phase: "reveal" });
    expect(s?.maskSize).toBe("280% 280%");
    expect(s?.WebkitMaskSize).toBe("280% 280%");
  });

  it("anchors the mask at the click coordinates", () => {
    const s = inkMorphStyle({ ...baseFx, ox: 42, oy: 99 });
    expect(s?.maskPosition).toBe("42px 99px");
    expect(s?.WebkitMaskPosition).toBe("42px 99px");
  });

  it("declares a radial-gradient mask with both prefixed and unprefixed properties", () => {
    const s = inkMorphStyle(baseFx);
    expect(s?.maskImage).toMatch(/radial-gradient/);
    expect(s?.WebkitMaskImage).toMatch(/radial-gradient/);
    expect(s?.maskRepeat).toBe("no-repeat");
    expect(s?.WebkitMaskRepeat).toBe("no-repeat");
  });

  it("animates mask-size with a tuned easing", () => {
    const s = inkMorphStyle(baseFx);
    expect(s?.transition).toMatch(/mask-size/);
    expect(s?.transition).toMatch(/cubic-bezier/);
  });

  it("under reduced motion, snap-cuts (no mask, instant opacity) regardless of phase", () => {
    const waitS = inkMorphStyle({ ...baseFx, reduceMotion: true });
    expect(waitS?.maskImage).toBeUndefined();
    expect(waitS?.maskSize).toBeUndefined();
    expect(waitS?.opacity).toBe(1);

    const revealS = inkMorphStyle({ ...baseFx, phase: "reveal", reduceMotion: true });
    expect(revealS?.maskImage).toBeUndefined();
    expect(revealS?.opacity).toBe(1);
  });
});
