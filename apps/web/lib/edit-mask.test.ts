import { describe, expect, it } from "vitest";

import {
  dragToRegion,
  regionToDisplayRect,
  regionToPixelRect,
} from "./edit-mask";

// A 16:9 box (800x450) showing a 1600x900 natural image — content fills the
// box exactly (no letterbox), so display px map 1:2 onto natural px.
const BOX = { w: 800, h: 450, nw: 1600, nh: 900 };

describe("dragToRegion", () => {
  it("normalizes a plain drag to natural-image space", () => {
    const r = dragToRegion(
      { x: 80, y: 45 },
      { x: 400, y: 225 },
      BOX.w,
      BOX.h,
      BOX.nw,
      BOX.nh
    );
    expect(r).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });

  it("accepts drags in any direction", () => {
    const r = dragToRegion(
      { x: 400, y: 225 },
      { x: 80, y: 45 },
      BOX.w,
      BOX.h,
      BOX.nw,
      BOX.nh
    );
    expect(r).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });

  it("returns null for a click (degenerate drag)", () => {
    const r = dragToRegion(
      { x: 100, y: 100 },
      { x: 104, y: 103 },
      BOX.w,
      BOX.h,
      BOX.nw,
      BOX.nh
    );
    expect(r).toBeNull();
  });

  it("clamps letterbox-margin points onto the content edge", () => {
    // A 1:1 natural image in the 16:9 box pillarboxes left/right: content is
    // 450px wide, offset (800-450)/2 = 175. A drag starting in the left
    // margin clamps to x=0 of the content.
    const r = dragToRegion(
      { x: 10, y: 45 },
      { x: 400, y: 225 },
      BOX.w,
      BOX.h,
      900,
      900
    );
    expect(r).not.toBeNull();
    expect(r!.x).toBe(0);
    expect(r!.x + r!.w).toBeCloseTo((400 - 175) / 450, 5);
    expect(r!.y).toBeCloseTo(0.1, 5);
  });

  it("returns null when dimensions are unknown", () => {
    expect(dragToRegion({ x: 0, y: 0 }, { x: 50, y: 50 }, 0, 0, 0, 0)).toBeNull();
  });
});

describe("regionToPixelRect", () => {
  it("rounds to natural pixels", () => {
    const r = regionToPixelRect({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, 1600, 900);
    expect(r).toEqual({ sx: 160, sy: 90, sw: 640, sh: 360 });
  });

  it("clamps an edge-hugging box inside the frame", () => {
    const r = regionToPixelRect({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, 1600, 900);
    expect(r.sx + r.sw).toBeLessThanOrEqual(1600);
    expect(r.sy + r.sh).toBeLessThanOrEqual(900);
    expect(r.sw).toBeGreaterThan(0);
    expect(r.sh).toBeGreaterThan(0);
  });
});

describe("regionToDisplayRect", () => {
  it("places the box on the letterboxed content, not the wrapper", () => {
    const content = { offsetX: 175, offsetY: 0, width: 450, height: 450 };
    const r = regionToDisplayRect({ x: 0.5, y: 0.25, w: 0.2, h: 0.1 }, content);
    expect(r).toEqual({ left: 400, top: 112.5, width: 90, height: 45 });
  });
});
