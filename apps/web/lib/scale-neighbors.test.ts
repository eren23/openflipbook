import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";

import { selectNeighbors } from "./scale-neighbors";

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

// A University frame ("u") with three room-tier buildings + an object-tier prop,
// plus a same-tier entity under a DIFFERENT parent.
const geos: WorldEntityGeo[] = [
  geo({ id: "u", scale_tier: "place" }),
  geo({ id: "tower", parent_id: "u", pos: { x: 10, y: 10 }, scale_tier: "room", label: "Tower of Art" }),
  geo({ id: "library", parent_id: "u", pos: { x: 30, y: 10 }, scale_tier: "room", label: "Library" }),
  geo({ id: "hall", parent_id: "u", pos: { x: 10, y: 40 }, scale_tier: "room", label: "Great Hall" }),
  geo({ id: "well", parent_id: "u", pos: { x: 20, y: 20 }, scale_tier: "object", label: "Well" }),
  geo({ id: "other", parent_id: "city", pos: { x: 0, y: 0 }, scale_tier: "room", label: "Elsewhere" }),
];

describe("selectNeighbors (B2 AROUND)", () => {
  it("returns same-parent same-tier siblings with bearings, excluding the rest", () => {
    const out = selectNeighbors("tower", geos);
    expect(out.tier).toBe("room");
    // Well (object tier) + Elsewhere (different parent) excluded; sorted by label.
    expect(out.known).toEqual(["Great Hall", "Library"]);
    const lib = out.neighbors.find((n) => n.label === "Library")!;
    expect(lib.bearing).toBeCloseTo(0, 6); // due east of the tower
    const hall = out.neighbors.find((n) => n.label === "Great Hall")!;
    expect(hall.bearing).toBeCloseTo(Math.PI / 2, 6); // due south (y grows down)
  });

  it("honours an explicit tier hint over the focus's own rung", () => {
    expect(selectNeighbors("tower", geos, "object").known).toEqual(["Well"]);
  });

  it("is empty for a focus with no same-scale siblings, or an unknown focus", () => {
    expect(selectNeighbors("well", geos).known).toEqual([]); // the only object-tier
    expect(selectNeighbors("missing", geos).known).toEqual([]);
  });
});
