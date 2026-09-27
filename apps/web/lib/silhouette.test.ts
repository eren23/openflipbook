import type { ObserverPose, WorldEntityGeo } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import { renderLayoutControl } from "./layout-control";
import { compareMasks, maskForVisible, maskFromGray, maskStats } from "./silhouette";

const W = 64;
const H = 48;

/** A filled rectangle in frame pixels, as a mask. */
function rect(x0: number, y0: number, w: number, h: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let j = y0; j < y0 + h; j++) for (let i = x0; i < x0 + w; i++) m[j * W + i] = 1;
  return m;
}

const geo = (label: string, x: number, y: number, w: number, d: number, height: number) =>
  ({ id: `geo_${label}`, entity_id: null, kind: "place", label, pos: { x, y }, footprint: { w, d },
     height, visual: "", state: {}, confidence: 1, source: "extracted", updated_at: "" }) as unknown as WorldEntityGeo;

// The live Lantern Quay town, the same fixture the route and carve tests use.
const TOWN = [
  geo("The Copper Kettle", 36.9, 28.38, 16.2, 13.31, 6.1),
  geo("Central Public Well", 52.3, 28.38, 8.9, 7.31, 5.4),
  geo("Bellfounder Hall", 67.4, 32.16, 19.8, 16.26, 7.2),
  geo("Ropewalk Store", 43.7, 41.16, 15.5, 12.7, 5.6),
];
const OBSERVER: ObserverPose = { pos: { x: 20, y: 34 }, gaze: 0.1, eye_height: 1.7, fov: Math.PI / 2 };

describe("mask metrics", () => {
  it("scores an identical mask as exact", () => {
    const m = rect(10, 10, 20, 20);
    const got = compareMasks(m, m, W, H)!;
    expect(got.iou).toBe(1);
    expect(got.widthRatio).toBe(1);
    expect(got.centreDx).toBe(0);
    expect(got.areaRatio).toBe(1);
  });

  it("scores a disjoint mask as zero overlap without dividing by zero", () => {
    const got = compareMasks(rect(0, 0, 10, 10), rect(40, 30, 10, 10), W, H)!;
    expect(got.iou).toBe(0);
    expect(got.widthRatio).toBe(1); // same size, wrong place: width alone cannot see it
    expect(got.centreDx).toBeGreaterThan(0.5); // ...the centre can
  });

  it("catches a building painted wider than its plot -- the merge failure", () => {
    const truth = rect(10, 10, 20, 20);
    const merged = rect(10, 10, 40, 20); // twice as wide, same left edge
    const got = compareMasks(truth, merged, W, H)!;
    expect(got.widthRatio).toBeCloseTo(2, 6);
    expect(got.areaRatio).toBeCloseTo(2, 6);
    expect(got.iou).toBeCloseTo(0.5, 6);
  });

  it("does not punish a roof above the box top on width", () => {
    // A pitched roof rises past the proxy box: honest IoU loss, no width drift.
    const truth = rect(10, 20, 20, 20);
    const withRoof = rect(10, 10, 20, 30);
    const got = compareMasks(truth, withRoof, W, H)!;
    expect(got.widthRatio).toBe(1);
    expect(got.centreDx).toBe(0);
    expect(got.iou).toBeCloseTo(20 / 30, 6);
  });

  it("has no opinion when either mask is empty", () => {
    expect(compareMasks(rect(1, 1, 4, 4), new Uint8Array(W * H), W, H)).toBeNull();
    expect(maskStats(new Uint8Array(W * H), W, H)).toBeNull();
  });

  it("reads a segmenter's grayscale mask at the stated threshold", () => {
    const gray = new Uint8Array([0, 127, 128, 255]);
    expect(Array.from(maskFromGray(gray))).toEqual([0, 0, 1, 1]);
    expect(Array.from(maskFromGray(gray, 200))).toEqual([0, 0, 0, 1]);
  });
});

describe("the id buffer", () => {
  it("gives every named block its own pixels, and agrees with the reported count", () => {
    const control = renderLayoutControl(TOWN, OBSERVER, 160, 120, null);
    expect(control.ids).toHaveLength(160 * 120);
    expect(control.visible.length).toBeGreaterThan(0);
    for (const [k, v] of control.visible.entries()) {
      const mask = maskForVisible(control.ids, k);
      const stats = maskStats(mask, 160, 120)!;
      // The renderer's own pixel count is the mask's, or the measurement and
      // the picture disagree about what was drawn.
      expect(stats.pixels).toBe(v.pixels);
    }
    // Every id is either -1 or a real index: no pixel belongs to a block that
    // was never reported.
    for (const id of control.ids) expect(id).toBeLessThan(control.visible.length);
  });

  it("is exact against itself -- the measurement is sound before it judges a painting", () => {
    // Research 34 made the same check before trusting its numbers: scoring a
    // render against its own mask must come back 1.0, or the metric is lying.
    const a = renderLayoutControl(TOWN, OBSERVER, 160, 120, null);
    const b = renderLayoutControl(TOWN, OBSERVER, 160, 120, null);
    const inn = a.visible.findIndex((v) => v.label === "The Copper Kettle");
    expect(inn).toBeGreaterThanOrEqual(0);
    const got = compareMasks(maskForVisible(a.ids, inn), maskForVisible(b.ids, inn), 160, 120)!;
    expect(got.iou).toBe(1);
    expect(got.widthRatio).toBe(1);
  });

  it("moves the mask when the camera moves, and not otherwise", () => {
    const here = renderLayoutControl(TOWN, OBSERVER, 160, 120, null);
    const closer = renderLayoutControl(
      TOWN, { ...OBSERVER, pos: { x: 26, y: 34 } }, 160, 120, null,
    );
    const i0 = here.visible.findIndex((v) => v.label === "The Copper Kettle");
    const i1 = closer.visible.findIndex((v) => v.label === "The Copper Kettle");
    const got = compareMasks(maskForVisible(here.ids, i0), maskForVisible(closer.ids, i1), 160, 120)!;
    // Six units closer: the inn must grow. If this ever reads 1.0 the buffer
    // is stale rather than rendered.
    expect(got.widthRatio).toBeGreaterThan(1.1);
    expect(got.areaRatio).toBeGreaterThan(1.1);
  });
});
