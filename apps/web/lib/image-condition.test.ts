import { describe, expect, it } from "vitest";

import { cropBox, orderedRefs } from "./image-condition";

/**
 * Pure core of the image-conditioning reference stack: where the region crop
 * sits (cropBox) and how the signals are ordered/weighted (orderedRefs). The
 * canvas crop + assembly orchestration are thin wrappers verified live.
 */

describe("cropBox", () => {
  it("centres the box on the click", () => {
    const b = cropBox(0.5, 0.5, 0.4);
    expect(b.w).toBeCloseTo(0.4, 6);
    expect(b.h).toBeCloseTo(0.4, 6);
    expect(b.x).toBeCloseTo(0.3, 6); // 0.5 - 0.4/2
    expect(b.y).toBeCloseTo(0.3, 6);
  });

  it("clamps the box inside the image at the corners", () => {
    const tl = cropBox(0, 0, 0.4);
    expect(tl.x).toBe(0);
    expect(tl.y).toBe(0);
    const br = cropBox(1, 1, 0.4);
    expect(br.x).toBeCloseTo(0.6, 6); // 1 - 0.4
    expect(br.y).toBeCloseTo(0.6, 6);
    // box always stays within [0,1]
    for (const b of [tl, br]) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("never produces a box bigger than the image (frac >= 1)", () => {
    const b = cropBox(0.5, 0.5, 2);
    expect(b.w).toBe(1);
    expect(b.x).toBe(0);
  });
});

describe("orderedRefs", () => {
  it("orders region → parent → anchor (weight by position)", () => {
    const { urls, roles } = orderedRefs({ region: "r", parent: "p", anchor: "a" });
    expect(urls).toEqual(["r", "p", "a"]);
    expect(roles).toEqual(["region", "parent", "anchor"]);
  });

  it("drops missing signals but keeps order", () => {
    expect(orderedRefs({ parent: "p", anchor: "a" }).roles).toEqual(["parent", "anchor"]);
    expect(orderedRefs({ region: "r", anchor: "a" }).roles).toEqual(["region", "anchor"]);
    expect(orderedRefs({ parent: "p" }).urls).toEqual(["p"]);
  });

  it("returns empty when there's nothing to condition on", () => {
    expect(orderedRefs({}).urls).toEqual([]);
    expect(orderedRefs({ region: null, parent: null, anchor: null }).roles).toEqual([]);
  });
});
