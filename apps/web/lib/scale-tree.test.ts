import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";
import { tierMetricMultiplier } from "@openflipbook/config";

import { reparent } from "./scale-tree";
import { type FrameNode, resolveAbsolutePos } from "./world-geometry";

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
