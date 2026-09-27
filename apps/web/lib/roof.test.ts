import type { ObserverPose, WorldEntityGeo } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import { renderLayoutControl } from "./layout-control";
import { roofEntry, roofFor } from "./roof";

describe("roofFor", () => {
  it("gives a long building a ridge down its length", () => {
    const r = roofFor(20, 8, 6);
    expect(r.kind).toBe("gable");
    expect(r.ridgeAlongX).toBe(true); // w > d: the ridge runs along x
    expect(r.rise).toBeCloseTo(8 * 0.45, 6);
  });

  it("turns the ridge when the building is deeper than it is wide", () => {
    const r = roofFor(8, 20, 6);
    expect(r.kind).toBe("gable");
    expect(r.ridgeAlongX).toBe(false);
  });

  it("gives a squat building a point, because a ridge has nowhere to run", () => {
    expect(roofFor(10, 9, 6).kind).toBe("pyramid");
  });

  it("never lets the roof swamp the building", () => {
    // A wide, low shed: pitch would want 0.45 * 20 = 9, taller than the walls.
    const r = roofFor(30, 20, 3);
    expect(r.rise).toBeCloseTo(3 * 0.6, 6);
    expect(r.rise).toBeLessThan(3);
  });

  it("refuses to roof a degenerate footprint", () => {
    for (const bad of [roofFor(0, 10, 5), roofFor(10, 0, 5), roofFor(10, 10, 0), roofFor(NaN, 10, 5)]) {
      expect(bad.kind).toBe("flat");
      expect(bad.rise).toBe(0);
    }
  });
});

describe("roofEntry", () => {
  // A 20x8 building, walls to z=6, gable ridge along x rising 3.6 to z=9.6.
  const R = roofFor(20, 8, 6);
  const hw = 10, hd = 4, z1 = 6;

  it("is hit by a ray aimed at the ridge and missed by one above it", () => {
    // Straight down the middle from 30 units away, at ridge height.
    const atRidge = roofEntry(R.kind, R.rise, R.ridgeAlongX, hw, hd, z1, 0, -30, z1 + R.rise / 2, 0, 1, 0, 0.05, Infinity);
    expect(atRidge).toBeLessThan(Infinity);
    const aboveApex = roofEntry(R.kind, R.rise, R.ridgeAlongX, hw, hd, z1, 0, -30, z1 + R.rise + 1, 0, 1, 0, 0.05, Infinity);
    expect(aboveApex).toBe(Infinity);
  });

  it("never reports a hit below the wall top -- that is the wall's job", () => {
    const belowEaves = roofEntry(R.kind, R.rise, R.ridgeAlongX, hw, hd, z1, 0, -30, z1 - 2, 0, 1, 0, 0.05, Infinity);
    expect(belowEaves).toBe(Infinity);
  });

  it("finds the pitch on the way down and reports where it entered", () => {
    // From above and to the side, angled down at the slope.
    const t = roofEntry(R.kind, R.rise, R.ridgeAlongX, hw, hd, z1, 0, -10, 20, 0, 1, -1, 0.05, Infinity);
    expect(t).toBeLessThan(Infinity);
    const z = 20 - t; // dz = -1
    expect(z).toBeGreaterThanOrEqual(z1 - 1e-9);
    expect(z).toBeLessThanOrEqual(z1 + R.rise + 1e-9);
  });

  it("has nothing to hit when the roof is flat", () => {
    expect(roofEntry("flat", 0, true, hw, hd, z1, 0, -30, 7, 0, 1, 0, 0.05, Infinity)).toBe(Infinity);
  });
});

describe("roofs in the render", () => {
  const geo = (label: string, x: number, y: number, w: number, d: number, height: number) =>
    ({ id: `geo_${label}`, entity_id: null, kind: "place", label, pos: { x, y }, footprint: { w, d },
       height, visual: "", state: {}, confidence: 1, source: "extracted", updated_at: "" }) as unknown as WorldEntityGeo;
  const TOWN = [geo("hall", 40, 30, 20, 8, 6), geo("tower", 60, 30, 9, 9, 10)];
  const OBS: ObserverPose = { pos: { x: 20, y: 30 }, gaze: 0, eye_height: 1.7, fov: Math.PI / 2 };

  it("is off unless asked, so no existing depth map moves", () => {
    const flat = renderLayoutControl(TOWN, OBS, 120, 90, null);
    const same = renderLayoutControl(TOWN, OBS, 120, 90, null, 0, false);
    expect(Array.from(same.depth)).toEqual(Array.from(flat.depth));
  });

  it("adds building above the walls without taking any away", () => {
    const flat = renderLayoutControl(TOWN, OBS, 160, 120, null, 0, false);
    const roofed = renderLayoutControl(TOWN, OBS, 160, 120, null, 0, true);
    const solid = (c: { depth: Float32Array }) => c.depth.reduce((n, z) => n + (Number.isFinite(z) ? 1 : 0), 0);
    // A roof only ever fills sky: every pixel the flat render called building
    // is still building, and there are more of them.
    expect(solid(roofed)).toBeGreaterThan(solid(flat));
    for (let i = 0; i < flat.depth.length; i++) {
      if (Number.isFinite(flat.depth[i]!)) expect(Number.isFinite(roofed.depth[i]!)).toBe(true);
    }
    // ...and it is nearer than the sky it replaced, never behind the wall.
    const hall = roofed.visible.find((v) => v.label === "hall")!;
    const flatHall = flat.visible.find((v) => v.label === "hall")!;
    expect(hall.pixels).toBeGreaterThan(flatHall.pixels);
  });
});
