import { describe, expect, it } from "vitest";

import { cropBox, diveOriginPx, orderedRefs, REGION_FRAC, regionUpscale } from "./image-condition";

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

describe("regionUpscale (the anti-postage-stamp reference)", () => {
  it("tiny crops hit the upscale cap", () => {
    expect(regionUpscale(200)).toBe(3); // 1024/200 > 3 → capped
  });
  it("mid crops scale to the target width", () => {
    expect(regionUpscale(512)).toBeCloseTo(2, 6); // 1024/512
  });
  it("big crops never shrink", () => {
    expect(regionUpscale(1024)).toBe(1);
    expect(regionUpscale(2000)).toBe(1);
  });
  it("degenerate width is a no-op", () => {
    expect(regionUpscale(0)).toBe(1);
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

describe("buildConditionRefs regionWhole (transition tap)", () => {
  it("the parent IS the region — no canvas pass, no duplicate parent role", async () => {
    const { buildConditionRefs } = await import("./image-condition");
    const refs = await buildConditionRefs({
      parentDataUrl: "data:image/jpeg;base64,UEFSRU5U",
      styleDataUrl: "data:image/jpeg;base64,U1RZTEU=",
      regionWhole: true,
    });
    expect(refs.roles).toEqual(["region", "style"]);
    expect(refs.urls[0]).toBe("data:image/jpeg;base64,UEFSRU5U");
  });
});

describe("diveOriginPx (the dive's convergence point)", () => {
  const content = { offsetX: 10, offsetY: 20, width: 1000, height: 500 };

  it("centred tap: origin = the tap itself, in element px", () => {
    const o = diveOriginPx(0.5, 0.5, REGION_FRAC, content);
    expect(o.x).toBeCloseTo(10 + 0.5 * 1000);
    expect(o.y).toBeCloseTo(20 + 0.5 * 500);
  });

  it("edge tap: origin is the CLAMPED crop centre, not the raw tap", () => {
    // Tap at the very corner — cropBox clamps to [0, frac], so its centre is
    // frac/2 in from the edge; the arrival renders that crop, so the dive
    // must aim there.
    const o = diveOriginPx(0, 0, REGION_FRAC, content);
    expect(o.x).toBeCloseTo(10 + (REGION_FRAC / 2) * 1000);
    expect(o.y).toBeCloseTo(20 + (REGION_FRAC / 2) * 500);
  });

  it("REGION_FRAC is the conditioning default", () => {
    expect(REGION_FRAC).toBe(0.42);
  });
});
