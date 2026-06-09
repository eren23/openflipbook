import { describe, expect, it } from "vitest";

import {
  SCALE_LADDER,
  SCALE_TIER_METERS,
  tierMetricMultiplier,
  tierStep,
  tierTransitionValid,
} from "@openflipbook/config";

// B2 keystone: the scale ladder must be ordered + metric-conserving (INV-2), so
// OUTWARD always grows the span and DEEPER always shrinks it. Pure + golden.
describe("scale ladder (B2 keystone)", () => {
  it("is ordered coarsest -> finest, 11 rungs", () => {
    expect(SCALE_LADDER.length).toBe(11);
    expect(SCALE_LADDER[0]).toBe("universe");
    expect(SCALE_LADDER[SCALE_LADDER.length - 1]).toBe("object");
  });

  it("metric anchors never grow going finer (world == planet by design)", () => {
    for (let i = 0; i < SCALE_LADDER.length - 1; i += 1) {
      const a = SCALE_LADDER[i];
      const b = SCALE_LADDER[i + 1];
      if (!a || !b) continue;
      expect(SCALE_TIER_METERS[a]).toBeGreaterThanOrEqual(SCALE_TIER_METERS[b]);
    }
    expect(SCALE_TIER_METERS.planet).toBe(SCALE_TIER_METERS.world); // the one equal pair
  });

  it("tierStep: DEEPER is +, OUTWARD is -", () => {
    expect(tierStep("city", "district")).toBe(1); // deeper (finer)
    expect(tierStep("city", "region")).toBe(-1); // outward (coarser)
  });

  it("tierMetricMultiplier: city->region grows ~20x; region->city shrinks", () => {
    expect(tierMetricMultiplier("city", "region")).toBeCloseTo(20, 0);
    expect(tierMetricMultiplier("region", "city")).toBeCloseTo(0.05, 2);
  });

  it("INV-2: every adjacent transition is metric-monotonic, both directions", () => {
    for (let i = 0; i < SCALE_LADDER.length - 1; i += 1) {
      const a = SCALE_LADDER[i];
      const b = SCALE_LADDER[i + 1];
      if (!a || !b) continue;
      expect(tierTransitionValid(a, b)).toBe(true);
      expect(tierTransitionValid(b, a)).toBe(true);
    }
    // world<->planet (the deliberately-equal pair) is legal both ways.
    expect(tierTransitionValid("world", "planet")).toBe(true);
    expect(tierTransitionValid("planet", "world")).toBe(true);
  });
});
