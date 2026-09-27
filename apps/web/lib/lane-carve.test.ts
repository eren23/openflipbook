import type { WorldEntityGeo } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import { LANE_GAP, carveLanes, standable, tightestGap } from "./lane-carve";

const geo = (label: string, x: number, y: number, w: number, d: number, height = 6) =>
  ({ id: `geo_${label}`, entity_id: null, kind: "place", label, pos: { x, y }, footprint: { w, d }, height,
     visual: "", state: {}, confidence: 1, source: "extracted", updated_at: "" }) as unknown as WorldEntityGeo;

// The live Lantern Quay map, as the extractor left it: ten places over 32% of
// the map, eight pairs intersecting.
const TOWN = [
  geo("Lantern Quay", 14.7, 7.32, 25.3, 20.78, 6.7),
  geo("The Copper Kettle", 36.9, 28.38, 16.2, 13.31, 6.1),
  geo("Central Public Well", 52.3, 28.38, 8.9, 7.31, 5.4),
  geo("Bellfounder Hall", 67.4, 32.16, 19.8, 16.26, 7.2),
  geo("Lantern Watch", 57.4, 40.32, 16.1, 13.2, 6.5),
  geo("Blue Shutter Bakery", 71.6, 20.64, 13.2, 10.8, 5.3),
  geo("Tideglass Apothecary", 45.1, 17.82, 11.6, 9.5, 4.7),
  geo("Mapmaker House", 58.9, 18.18, 12.1, 9.9, 4.9),
  geo("Ropewalk Store", 43.7, 41.16, 15.5, 12.7, 5.6),
  geo("Candleworkss", 34.7, 18.3, 11.4, 9.3, 4.6),
];

describe("carveLanes", () => {
  it("opens daylight between buildings that were drawn inside each other", () => {
    expect(tightestGap(TOWN)).toBeLessThan(0); // they intersect as extracted
    const carved = carveLanes(TOWN);
    expect(tightestGap(carved)).toBeGreaterThanOrEqual(LANE_GAP - 1e-6);
  });

  it("never moves a place", () => {
    for (const [i, b] of carveLanes(TOWN).entries()) {
      expect(b.pos).toEqual(TOWN[i]!.pos);
      expect(b.height).toBe(TOWN[i]!.height);
      expect(b.label).toBe(TOWN[i]!.label);
    }
  });

  it("only ever narrows, and not past the floor", () => {
    for (const [i, b] of carveLanes(TOWN).entries()) {
      expect(b.footprint.w).toBeLessThanOrEqual(TOWN[i]!.footprint.w + 1e-9);
      expect(b.footprint.d).toBeLessThanOrEqual(TOWN[i]!.footprint.d + 1e-9);
      expect(Math.min(b.footprint.w, b.footprint.d)).toBeGreaterThanOrEqual(Math.min(3, Math.min(TOWN[i]!.footprint.w, TOWN[i]!.footprint.d)) - 1e-9);
      // A footprint keeps its shape: width and depth give way together.
      expect(b.footprint.w / b.footprint.d).toBeCloseTo(TOWN[i]!.footprint.w / TOWN[i]!.footprint.d, 9);
    }
  });

  it("gives the town somewhere to stand", () => {
    // The point the failed walk tried to reach: between the inn and the store.
    const between = { x: 40, y: 35 };
    expect(standable(TOWN, between)).toBe(false);
    expect(standable(carveLanes(TOWN), between)).toBe(true);
  });

  it("leaves a town that is already clear alone", () => {
    const spread = [geo("a", 10, 10, 6, 6), geo("b", 30, 10, 6, 6), geo("c", 10, 30, 6, 6)];
    expect(carveLanes(spread)).toEqual(spread);
  });

  it("settles: carving twice changes nothing the second time", () => {
    const once = carveLanes(TOWN);
    const twice = carveLanes(once);
    for (const [i, b] of twice.entries()) {
      expect(b.footprint.w).toBeCloseTo(once[i]!.footprint.w, 9);
      expect(b.footprint.d).toBeCloseTo(once[i]!.footprint.d, 9);
    }
  });

  it("clears a pair where only one of them can give way", () => {
    // A kiosk beside a hall: the kiosk hits the floor at once, so the hall has
    // to absorb the whole of the shrinking. Sharing it evenly instead only
    // approaches the answer, and stops wherever the passes run out (measured:
    // 2.4988 of daylight, and a second carve moved it again).
    const kiosk = geo("kiosk", 0, 0, 10, 10);
    const hall = geo("hall", 8, 0, 100, 100);
    const once = carveLanes([kiosk, hall]);
    expect(tightestGap(once)).toBeGreaterThanOrEqual(LANE_GAP - 1e-9);
    const twice = carveLanes(once);
    for (const [i, b] of twice.entries()) expect(b.footprint.w).toBeCloseTo(once[i]!.footprint.w, 9);
  });

  it("gives way as far as it can when a pair cannot be parted at all", () => {
    // Centres closer together than the gap: no amount of narrowing separates
    // these. Both go to the floor, which is the least overlap available, and
    // the answer does not wander on a second pass.
    const a = geo("a", 20, 20, 12, 12);
    const b = geo("b", 21, 20, 12, 12);
    const once = carveLanes([a, b]);
    expect(Math.min(...once.map((x) => x.footprint.w))).toBeCloseTo(3, 9);
    const twice = carveLanes(once);
    for (const [i, x] of twice.entries()) expect(x.footprint.w).toBeCloseTo(once[i]!.footprint.w, 9);
  });

  it("handles a town of one, and of none", () => {
    expect(carveLanes([])).toEqual([]);
    const one = [geo("only", 20, 20, 12, 9)];
    expect(carveLanes(one)).toEqual(one);
    expect(tightestGap(one)).toBe(Infinity);
  });

  it("does not divide by zero on a footprint with no size", () => {
    const flat = [geo("flat", 20, 20, 0, 0), geo("real", 21, 20, 10, 8)];
    const carved = carveLanes(flat);
    expect(carved.every((b) => Number.isFinite(b.footprint.w) && Number.isFinite(b.footprint.d))).toBe(true);
  });
});
