import { describe, expect, it } from "vitest";

import type { EntityBBox, SceneView } from "@openflipbook/config";

import { estimateGeoFromBBox } from "./world-geometry";

const ASPECT = 16 / 9;

// FIX A regression eval — entity size <-> map alignment. On an oblique map an
// entity's seeded footprint must track the detection box WIDTH (a wide building
// seeds a wide footprint), instead of collapsing to the old flat 6x6 default.
// Guards apps/web/lib/world-geometry.ts estimateGeoFromBBox.

const obliqueMap = (): SceneView => ({
  node_id: "n",
  level: "map",
  observer: null,
  map_crop: { x: 0, y: 0, w: 100, h: 60 },
});

const bbox = (wPct: number): EntityBBox => ({
  x_pct: 0.5 - wPct / 2,
  y_pct: 0.4,
  w_pct: wPct,
  h_pct: 0.3,
});

// Footprint width for an oblique (-60deg) seed of a box `wPct` of the 100-wide crop.
const fw = (wPct: number) =>
  estimateGeoFromBBox(bbox(wPct), obliqueMap(), ASPECT, "oblique", -60).footprint.w;

describe("FIX A — oblique footprints track box width (size/map alignment)", () => {
  it("footprint width is monotonic in the detection box width", () => {
    expect(fw(0.05)).toBeLessThan(fw(0.1));
    expect(fw(0.1)).toBeLessThan(fw(0.3));
  });

  it("a wide building seeds a wide footprint — not the old flat 6x6", () => {
    expect(fw(0.05)).toBeCloseTo(5); // 0.05 * crop.w(100)
    expect(fw(0.1)).toBeCloseTo(10);
    expect(fw(0.3)).toBeCloseTo(30);
    // varied inputs -> varied footprints (the bug was a uniform 6 for all).
    expect(new Set([fw(0.05), fw(0.1), fw(0.3)]).size).toBe(3);
  });

  it("depth is damped off the width by cos(pitch)", () => {
    const g = estimateGeoFromBBox(bbox(0.1), obliqueMap(), ASPECT, "oblique", -60);
    // -60deg -> cos 0.5 -> d = w(10) * (0.5 + 0.5*0.5) = 7.5
    expect(g.footprint.w).toBeCloseTo(10);
    expect(g.footprint.d).toBeCloseTo(7.5);
  });

  it("clamps to [0.5, 40] so a near-frame box can't blow up the map", () => {
    expect(fw(0.9)).toBe(40); // 90 -> clamped high
    expect(fw(0.002)).toBe(0.5); // 0.2 -> floored low
  });
});
