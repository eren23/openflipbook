// The scale ladder is the ONE axis every zoom feature (OUTWARD/AROUND/DEEPER,
// interiors' "room" stamp, the geo frames) hangs off — these invariants are
// the contract both the TS and Python sides assume. 969 lines of wire types
// had zero tests until the 2026-07-18 coverage pass.
import { describe, expect, it } from "vitest";

import {
  finerTier,
  SCALE_LADDER,
  SCALE_TIER_METERS,
  type ScaleTier,
  tierIndex,
  tierMetricMultiplier,
  tierStep,
  tierTransitionValid,
} from "./index";

describe("SCALE_LADDER invariants", () => {
  it("has exactly 11 unique rungs, universe→object", () => {
    expect(SCALE_LADDER).toHaveLength(11);
    expect(new Set(SCALE_LADDER).size).toBe(11);
    expect(SCALE_LADDER[0]).toBe("universe");
    expect(SCALE_LADDER[SCALE_LADDER.length - 1]).toBe("object");
  });

  it("metric anchors are monotonically non-increasing along the ladder", () => {
    for (let i = 1; i < SCALE_LADDER.length; i++) {
      const coarser = SCALE_TIER_METERS[SCALE_LADDER[i - 1] as ScaleTier];
      const finer = SCALE_TIER_METERS[SCALE_LADDER[i] as ScaleTier];
      expect(finer).toBeLessThanOrEqual(coarser);
    }
  });

  it("world and planet share an anchor BY DESIGN (a world is a planet-surface framing)", () => {
    expect(SCALE_TIER_METERS.world).toBe(SCALE_TIER_METERS.planet);
  });

  it("every rung has a positive metric anchor", () => {
    for (const t of SCALE_LADDER) {
      expect(SCALE_TIER_METERS[t]).toBeGreaterThan(0);
    }
  });
});

describe("tierIndex / tierStep", () => {
  it("tierIndex matches ladder position for every rung", () => {
    SCALE_LADDER.forEach((t, i) => expect(tierIndex(t)).toBe(i));
  });

  it("tierStep is signed: DEEPER (toward object) is +, OUTWARD is −, and antisymmetric", () => {
    expect(tierStep("city", "district")).toBe(1);
    expect(tierStep("district", "city")).toBe(-1);
    expect(tierStep("place", "place")).toBe(0);
    for (const a of SCALE_LADDER) {
      for (const b of SCALE_LADDER) {
        // sum form dodges the Object.is(-0, 0) trap on the diagonal
        expect(tierStep(a, b) + tierStep(b, a)).toBe(0);
      }
    }
  });
});

describe("tierMetricMultiplier", () => {
  it("OUTWARD grows (>1), DEEPER shrinks (<1), reciprocal both ways", () => {
    expect(tierMetricMultiplier("city", "region")).toBeGreaterThan(1);
    expect(tierMetricMultiplier("city", "district")).toBeLessThan(1);
    for (const a of SCALE_LADDER) {
      for (const b of SCALE_LADDER) {
        expect(tierMetricMultiplier(a, b) * tierMetricMultiplier(b, a)).toBeCloseTo(1, 9);
      }
    }
  });
});

describe("tierTransitionValid (INV-2: metric moves with the rung step)", () => {
  it("holds for every adjacent pair on the real ladder, both directions", () => {
    for (let i = 1; i < SCALE_LADDER.length; i++) {
      const coarser = SCALE_LADDER[i - 1] as ScaleTier;
      const finer = SCALE_LADDER[i] as ScaleTier;
      expect(tierTransitionValid(coarser, finer)).toBe(true); // DEEPER
      expect(tierTransitionValid(finer, coarser)).toBe(true); // OUTWARD
    }
  });

  it("same-rung transitions are trivially valid", () => {
    for (const t of SCALE_LADDER) expect(tierTransitionValid(t, t)).toBe(true);
  });

  it("the deliberately-equal world/planet hop is valid in both directions (the ==1 carve-out)", () => {
    expect(tierTransitionValid("planet", "world")).toBe(true);
    expect(tierTransitionValid("world", "planet")).toBe(true);
  });
});

describe("finerTier", () => {
  it("steps one rung toward object and clamps at object", () => {
    expect(finerTier("city")).toBe("district");
    expect(finerTier("room")).toBe("object");
    expect(finerTier("object")).toBe("object"); // the clamp
  });

  it("round-trips with tierStep(+1) everywhere except the clamp", () => {
    for (const t of SCALE_LADDER.slice(0, -1)) {
      expect(tierStep(t, finerTier(t))).toBe(1);
    }
  });
});
