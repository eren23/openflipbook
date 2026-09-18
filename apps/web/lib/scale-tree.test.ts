import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";
import { tierMetricMultiplier } from "@openflipbook/config";

import { outwardFrame, parseSourceRect, reparent, reparentRoots } from "./scale-tree";
import {
  type FrameNode,
  resolveAbsoluteFrame,
  resolveAbsolutePos,
} from "./world-geometry";

// Build a WorldEntityGeo with sensible defaults; override what a test cares about.
function geo(over: Partial<WorldEntityGeo> & Pick<WorldEntityGeo, "id">): WorldEntityGeo {
  return {
    entity_id: over.id,
    kind: "place",
    label: over.id,
    pos: { x: 0, y: 0 },
    height: 4,
    footprint: { w: 6, d: 6 },
    visual: "",
    state: {},
    confidence: 0.9,
    source: "extracted",
    updated_at: "2026-06-09T00:00:00Z",
    parent_id: null,
    ...over,
  };
}

// A small frame tree rooted at the city C, with a learned interior scale and a
// grandchild — enough to exercise the affine compose at every depth.
function cityTree(): WorldEntityGeo[] {
  return [
    geo({ id: "c", pos: { x: 50, y: 30 }, footprint: { w: 40, d: 30 }, scale: 0.4, scale_tier: "city" }),
    geo({ id: "a", parent_id: "c", pos: { x: 10, y: 5 }, scale_tier: "place" }),
    geo({ id: "b", parent_id: "c", pos: { x: 80, y: 50 }, scale_tier: "place" }),
    geo({ id: "a1", parent_id: "a", pos: { x: 2, y: 3 } }),
  ];
}

function absMap(geos: WorldEntityGeo[]): Map<string, { x: number; y: number }> {
  const byId = new Map<string, FrameNode>(geos.map((g) => [g.id, g]));
  const out = new Map<string, { x: number; y: number }>();
  for (const g of geos) {
    const p = resolveAbsolutePos(g.id, byId);
    if (p) out.set(g.id, p);
  }
  return out;
}

const NOW = "2026-06-09T12:00:00Z";

describe("scale-tree reparent (B2 OUTWARD)", () => {
  it("INV-1: every entity's absolute position is conserved across the reparent", () => {
    const before = cityTree();
    const beforeAbs = absMap(before);

    // P is a region centred on C (so C lands at P's origin), one rung coarser.
    const region = geo({
      id: "p",
      label: "Region",
      pos: { x: 50, y: 30 },
      footprint: { w: 90, d: 60 },
      scale_tier: "region",
      source: "user",
    });
    const { geos: after, parentGeoId, learnedScale } = reparent(before, "c", region, NOW);
    const afterAbs = absMap(after);

    expect(parentGeoId).toBe("p");
    // pScale is the metric ratio meters(city)/meters(region).
    expect(learnedScale).toBeCloseTo(tierMetricMultiplier("region", "city"), 12);

    // Every original entity resolves to the SAME absolute coordinate it did before.
    for (const id of ["c", "a", "b", "a1"]) {
      expect(afterAbs.get(id)!.x).toBeCloseTo(beforeAbs.get(id)!.x, 9);
      expect(afterAbs.get(id)!.y).toBeCloseTo(beforeAbs.get(id)!.y, 9);
    }
  });

  it("INV-1 extends to footprints: absolute extents are conserved too", () => {
    // reExpressUnder divides the footprint by pScale alongside pos, so
    // pos + footprint stay ONE consistent parent-local frame — resolving
    // (footprint × unit) recovers the original absolute extent.
    const absFootprints = (geos: WorldEntityGeo[]) => {
      const byId = new Map<string, FrameNode>(geos.map((g) => [g.id, g]));
      const out = new Map<string, { w: number; d: number }>();
      for (const g of geos) {
        const f = resolveAbsoluteFrame(g.id, byId);
        if (f) out.set(g.id, { w: g.footprint.w * f.unit, d: g.footprint.d * f.unit });
      }
      return out;
    };
    const before = cityTree();
    const beforeFp = absFootprints(before);
    const region = geo({
      id: "p",
      pos: { x: 50, y: 30 },
      footprint: { w: 90, d: 60 },
      scale_tier: "region",
      source: "user",
    });
    const { geos: after } = reparent(before, "c", region, NOW);
    const afterFp = absFootprints(after);
    for (const id of ["c", "a", "b", "a1"]) {
      expect(afterFp.get(id)!.w).toBeCloseTo(beforeFp.get(id)!.w, 9);
      expect(afterFp.get(id)!.d).toBeCloseTo(beforeFp.get(id)!.d, 9);
    }
  });

  it("re-points C under P and stamps both source:user (protects the edge)", () => {
    const { geos } = reparent(cityTree(), "c", geo({ id: "p", scale_tier: "region", footprint: { w: 90, d: 60 } }), NOW);
    const c = geos.find((g) => g.id === "c")!;
    const p = geos.find((g) => g.id === "p")!;
    expect(c.parent_id).toBe("p");
    expect(c.source).toBe("user");
    expect(p.parent_id).toBeNull();
    expect(p.source).toBe("user");
    expect(p.updated_at).toBe(NOW);
  });

  it("conserves INV-1 even with no scale_tier (footprint÷extent fallback)", () => {
    const before = [
      geo({ id: "c", pos: { x: 20, y: 10 }, footprint: { w: 30, d: 20 }, scale: 0.5 }),
      geo({ id: "k", parent_id: "c", pos: { x: 4, y: 6 } }),
    ];
    const beforeAbs = absMap(before);
    const { geos: after } = reparent(
      before,
      "c",
      geo({ id: "p", pos: { x: 0, y: 0 }, footprint: { w: 80, d: 60 } }),
      NOW,
    );
    const afterAbs = absMap(after);
    for (const id of ["c", "k"]) {
      expect(afterAbs.get(id)!.x).toBeCloseTo(beforeAbs.get(id)!.x, 9);
      expect(afterAbs.get(id)!.y).toBeCloseTo(beforeAbs.get(id)!.y, 9);
    }
  });

  it("never poisons coords when the scale ratio is NaN (malformed footprint, no tier)", () => {
    const before = [
      geo({ id: "c", pos: { x: 10, y: 20 }, footprint: { w: NaN, d: NaN } }),
      geo({ id: "k", parent_id: "c", pos: { x: 1, y: 2 } }),
    ];
    const { geos, learnedScale } = reparent(
      before,
      "c",
      geo({ id: "p", footprint: { w: NaN, d: NaN } }),
      NOW,
    );
    expect(Number.isFinite(learnedScale)).toBe(true); // fell back to an identity frame
    const after = absMap(geos);
    for (const id of ["c", "k", "p"]) {
      expect(Number.isFinite(after.get(id)!.x)).toBe(true);
      expect(Number.isFinite(after.get(id)!.y)).toBe(true);
    }
  });

  it("rejects a double ascend (C is not a root)", () => {
    expect(() =>
      reparent(cityTree(), "a", geo({ id: "p" }), NOW),
    ).toThrow(/not a root/);
  });

  it("rejects an unknown root and a duplicate parent id", () => {
    expect(() => reparent(cityTree(), "nope", geo({ id: "p" }), NOW)).toThrow(/not in the entity set/);
    expect(() => reparent(cityTree(), "c", geo({ id: "a" }), NOW)).toThrow(/already exists/);
  });
});

describe("scale-tree reparentRoots (the multi-root geo store)", () => {
  it("re-points EVERY root under P, conserving all absolute positions", () => {
    // A map seeded as several top-level roots (its buildings), one with an interior.
    const before = [
      geo({ id: "b1", pos: { x: 10, y: 10 }, scale_tier: "city" }),
      geo({ id: "b2", pos: { x: 70, y: 40 }, scale: 0.3, scale_tier: "city" }),
      geo({ id: "b2i", parent_id: "b2", pos: { x: 5, y: 5 } }), // interior of b2
      geo({ id: "b3", pos: { x: 40, y: 55 }, scale_tier: "city" }),
    ];
    const beforeAbs = absMap(before);
    const region = geo({
      id: "p",
      pos: { x: 30, y: 25 },
      footprint: { w: 90, d: 60 },
      scale_tier: "region",
    });
    const { geos: after, learnedScale } = reparentRoots(before, region, NOW);

    expect(learnedScale).toBeCloseTo(tierMetricMultiplier("region", "city"), 12);
    for (const id of ["b1", "b2", "b3"]) {
      expect(after.find((g) => g.id === id)!.parent_id).toBe("p"); // every root -> P
    }
    expect(after.find((g) => g.id === "b2i")!.parent_id).toBe("b2"); // interior untouched
    const afterAbs = absMap(after);
    for (const id of ["b1", "b2", "b2i", "b3"]) {
      expect(afterAbs.get(id)!.x).toBeCloseTo(beforeAbs.get(id)!.x, 9);
      expect(afterAbs.get(id)!.y).toBeCloseTo(beforeAbs.get(id)!.y, 9);
    }
  });

  it("rejects when there are no roots or the parent id already exists", () => {
    expect(() =>
      reparentRoots([geo({ id: "x", parent_id: "missing" })], geo({ id: "p" }), NOW),
    ).toThrow(/no root/);
    expect(() => reparentRoots(cityTree(), geo({ id: "c" }), NOW)).toThrow(/already exists/);
  });

  it("derives the shared pScale from the MODAL rung, not an arbitrary first root", () => {
    // A district root listed FIRST, but the city rung is the majority (3 of 4).
    const before = [
      geo({ id: "d", pos: { x: 5, y: 5 }, scale_tier: "district" }),
      geo({ id: "c1", pos: { x: 10, y: 10 }, scale_tier: "city" }),
      geo({ id: "c2", pos: { x: 70, y: 40 }, scale_tier: "city" }),
      geo({ id: "c3", pos: { x: 40, y: 55 }, scale_tier: "city" }),
    ];
    const beforeAbs = absMap(before);
    const region = geo({
      id: "p",
      pos: { x: 30, y: 25 },
      footprint: { w: 90, d: 60 },
      scale_tier: "region",
    });
    const { learnedScale, geos: after } = reparentRoots(before, region, NOW);
    // The majority (city) sets the ratio — not the first root (district).
    expect(learnedScale).toBeCloseTo(tierMetricMultiplier("region", "city"), 12);
    expect(learnedScale).not.toBeCloseTo(tierMetricMultiplier("region", "district"), 6);
    // INV-1 still holds for EVERY root (incl. the minority district one).
    const afterAbs = absMap(after);
    for (const id of ["d", "c1", "c2", "c3"]) {
      expect(afterAbs.get(id)!.x).toBeCloseTo(beforeAbs.get(id)!.x, 9);
      expect(afterAbs.get(id)!.y).toBeCloseTo(beforeAbs.get(id)!.y, 9);
    }
  });
});

describe("outwardFrame (zoom-out keeps the geometry)", () => {
  it("scales the source frame up around where the source landed", () => {
    // Live Lantern Quay: the town map (0,0,100,60) sits at 0.44 of the wider view.
    const rect = parseSourceRect({ x_pct: 0.281, y_pct: 0.29, w_pct: 0.44, h_pct: 0.44, score: 0.74 })!;
    const frame = outwardFrame({ x: 0, y: 0, w: 100, h: 60 }, rect);
    // A town place maps to the same pixel it occupies in the wider image.
    const kettle = { x: 37, y: 29.1 };
    expect((kettle.x - frame.x) / frame.w).toBeCloseTo(0.281 + 0.37 * 0.44, 9);
    expect((kettle.y - frame.y) / frame.h).toBeCloseTo(0.29 + 0.485 * 0.44, 9);
    expect(frame.w).toBeCloseTo(227.27, 2);
  });

  it("keeps the source frame without a rect", () => {
    const f = { x: 0, y: 0, w: 100, h: 60 };
    expect(outwardFrame(f, null)).toEqual(f);
  });

  it("refuses a rect that would rewrite the world frame", () => {
    // The rect is client JSON and SCALES the frame, so an implausible one has
    // to bounce: it moves every place on the map.
    const ok = { x_pct: 0.25, y_pct: 0.25, w_pct: 0.5, h_pct: 0.5, score: 0.8 };
    expect(parseSourceRect(ok)).toEqual({ x_pct: 0.25, y_pct: 0.25, w_pct: 0.5, h_pct: 0.5 });
    const bad: unknown[] = [
      null,
      {},
      { ...ok, score: undefined }, // no measurement score
      { ...ok, score: 0.4 }, // below the locator's own gate
      { ...ok, w_pct: 0.05, h_pct: 0.05 }, // a 20x zoom-out
      { ...ok, w_pct: 0.6, h_pct: 0.2 }, // lopsided: not a camera pulling back
      { x_pct: 0.5, y_pct: 0.5, w_pct: 0.8, h_pct: 0.8, score: 0.8 }, // spills outside
      { ...ok, x_pct: NaN },
    ];
    for (const value of bad) expect(parseSourceRect(value)).toBeNull();
  });
});
