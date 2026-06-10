import { describe, expect, it } from "vitest";

import type { Entity, EntityBBox } from "@openflipbook/config";

import { entityAtPoint, padBox } from "./entity-hit";

function _entity(
  name: string,
  bboxes: Record<string, EntityBBox>
): Entity {
  return {
    id: name,
    kind: "place",
    name,
    aliases: [],
    appearance: "",
    reference_image_url: null,
    facts: [],
    state: {},
    first_seen_node_id: "n1",
    last_seen_node_id: "n1",
    appears_on_node_ids: Object.keys(bboxes),
    appearance_bboxes: bboxes,
    pinned_by_user: false,
    confidence: 1,
    updated_at: "",
  };
}

const HARBOR = _entity("harbor", {
  n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.8, h_pct: 0.8 },
});
const LIGHTHOUSE = _entity("lighthouse", {
  n1: { x_pct: 0.15, y_pct: 0.15, w_pct: 0.1, h_pct: 0.25 },
});

describe("entityAtPoint", () => {
  it("returns the entity whose bbox contains the point", () => {
    const hit = entityAtPoint([HARBOR], "n1", 0.5, 0.5);
    expect(hit?.entity.name).toBe("harbor");
  });

  it("prefers the smallest box when bboxes overlap", () => {
    const hit = entityAtPoint([HARBOR, LIGHTHOUSE], "n1", 0.2, 0.3);
    expect(hit?.entity.name).toBe("lighthouse");
  });

  it("ignores entities not localized on this node", () => {
    expect(entityAtPoint([HARBOR], "other-node", 0.5, 0.5)).toBeNull();
    expect(entityAtPoint([HARBOR], null, 0.5, 0.5)).toBeNull();
  });

  it("misses outside every bbox", () => {
    expect(entityAtPoint([LIGHTHOUSE], "n1", 0.9, 0.9)).toBeNull();
  });
});

describe("padBox", () => {
  it("grows the box by the pad on every side", () => {
    const r = padBox({ x_pct: 0.3, y_pct: 0.3, w_pct: 0.2, h_pct: 0.2 }, 0.05);
    expect(r.x).toBeCloseTo(0.25, 10);
    expect(r.y).toBeCloseTo(0.25, 10);
    expect(r.w).toBeCloseTo(0.3, 10);
    expect(r.h).toBeCloseTo(0.3, 10);
  });

  it("clamps at the frame edges", () => {
    const r = padBox({ x_pct: 0.0, y_pct: 0.9, w_pct: 0.15, h_pct: 0.1 }, 0.05);
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo(0.85, 5);
    expect(r.y + r.h).toBeCloseTo(1, 5);
  });
});
