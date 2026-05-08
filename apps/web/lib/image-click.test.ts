import { describe, expect, it } from "vitest";

import { normalizeClickOnImage, summarizeStroke } from "./image-click";

interface FakeImg {
  naturalWidth: number;
  naturalHeight: number;
  getBoundingClientRect: () => DOMRect;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function fakeImg(opts: {
  natW: number;
  natH: number;
  boxLeft: number;
  boxTop: number;
  boxW: number;
  boxH: number;
}): HTMLImageElement {
  const img: FakeImg = {
    naturalWidth: opts.natW,
    naturalHeight: opts.natH,
    getBoundingClientRect: () => rect(opts.boxLeft, opts.boxTop, opts.boxW, opts.boxH),
  };
  return img as unknown as HTMLImageElement;
}

function evt(clientX: number, clientY: number): MouseEvent {
  return { clientX, clientY } as MouseEvent;
}

describe("normalizeClickOnImage", () => {
  it("returns null when image has no intrinsic size", () => {
    const img = fakeImg({ natW: 0, natH: 0, boxLeft: 0, boxTop: 0, boxW: 100, boxH: 100 });
    expect(normalizeClickOnImage(evt(50, 50), img)).toBeNull();
  });

  it("returns null when bounding box has zero size", () => {
    const img = fakeImg({ natW: 100, natH: 100, boxLeft: 0, boxTop: 0, boxW: 0, boxH: 0 });
    expect(normalizeClickOnImage(evt(0, 0), img)).toBeNull();
  });

  it("maps centre click to roughly (0.5, 0.5)", () => {
    const img = fakeImg({
      natW: 100,
      natH: 100,
      boxLeft: 0,
      boxTop: 0,
      boxW: 100,
      boxH: 100,
    });
    const out = normalizeClickOnImage(evt(50, 50), img)!;
    expect(out.x_pct).toBeCloseTo(0.5, 5);
    expect(out.y_pct).toBeCloseTo(0.5, 5);
  });

  it("compensates for letterboxing when image is wider than box", () => {
    // 200x100 image rendered into a 200x200 box -> letterboxed top/bottom.
    const img = fakeImg({
      natW: 200,
      natH: 100,
      boxLeft: 0,
      boxTop: 0,
      boxW: 200,
      boxH: 200,
    });
    // Click at the centre column, halfway down the rendered image
    // (rendered height = 100, vertical offset = 50). clientY = 100 = centre.
    const out = normalizeClickOnImage(evt(100, 100), img)!;
    expect(out.x_pct).toBeCloseTo(0.5, 5);
    expect(out.y_pct).toBeCloseTo(0.5, 5);
  });

  it("returns null when click lands in the letterbox margin", () => {
    const img = fakeImg({
      natW: 200,
      natH: 100,
      boxLeft: 0,
      boxTop: 0,
      boxW: 200,
      boxH: 200,
    });
    // y=10 is in the letterbox (image starts at y=50).
    expect(normalizeClickOnImage(evt(100, 10), img)).toBeNull();
  });
});

describe("summarizeStroke", () => {
  it("returns null for under-threshold point counts", () => {
    expect(summarizeStroke([])).toBeNull();
    expect(summarizeStroke([{ x_pct: 0.5, y_pct: 0.5 }])).toBeNull();
  });

  it("computes bbox + centroid for a known stroke", () => {
    const result = summarizeStroke([
      { x_pct: 0.2, y_pct: 0.3 },
      { x_pct: 0.6, y_pct: 0.7 },
    ])!;
    expect(result.bbox.x).toBeCloseTo(0.2, 5);
    expect(result.bbox.y).toBeCloseTo(0.3, 5);
    expect(result.bbox.w).toBeCloseTo(0.4, 5);
    expect(result.bbox.h).toBeCloseTo(0.4, 5);
    expect(result.centroid.x_pct).toBeCloseTo(0.4, 5);
    expect(result.centroid.y_pct).toBeCloseTo(0.5, 5);
  });

  it("clamps centroid into [0,1] when inputs drift outside", () => {
    const result = summarizeStroke([
      { x_pct: -0.5, y_pct: -0.5 },
      { x_pct: -1, y_pct: -1 },
    ])!;
    expect(result.centroid.x_pct).toBe(0);
    expect(result.centroid.y_pct).toBe(0);
  });
});
