import { describe, expect, it } from "vitest";

import type { MapCrop, WorldEntityGeo } from "@openflipbook/config";

import { geoTapRequest } from "./geo-tap";

function geo(
  id: string,
  label: string,
  x: number,
  y: number,
  opts: Partial<WorldEntityGeo> = {},
): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label,
    pos: { x, y },
    height: 4,
    footprint: { w: 8, d: 8 },
    visual: "",
    state: {},
    confidence: 1,
    source: "user",
    updated_at: "t",
    ...opts,
  };
}

const CROP: MapCrop = { x: 0, y: 0, w: 100, h: 80 };

describe("geoTapRequest (close the geometric tap loop)", () => {
  it("tapping a place → scene_view (observer) + an expected_layout with the focus", () => {
    const map = {
      entities: [
        geo("clock", "clock tower", 60, 30, { height: 18 }),
        geo("lh", "lighthouse", 45, 15, { height: 25 }),
      ],
      bounds: CROP,
    };
    const t = geoTapRequest(map, "n1", { x_pct: 60 / 100, y_pct: 30 / 80 }, 16 / 9);
    expect(t).not.toBeNull();
    expect(t!.focus_id).toBe("clock");
    expect(t!.scene_view.level).toBe("building"); // tall → building
    expect(t!.scene_view.observer).not.toBeNull();
    expect(t!.expected_layout.some((p) => p.id === "clock")).toBe(true);
  });

  it("P7b — scene_view carries the focus geo id (anchors the child frame)", () => {
    const map = {
      entities: [geo("clock", "clock tower", 60, 30, { height: 18 })],
      bounds: CROP,
    };
    const t = geoTapRequest(map, "n1", { x_pct: 60 / 100, y_pct: 30 / 80 }, 16 / 9);
    expect(t!.scene_view.focus_id).toBe("clock");
  });

  it("P7c — a place with a saved interior steers by its sub-entities, not the city", () => {
    const map = {
      entities: [
        geo("uu", "Unseen University", 30, 18, { height: 15 }),
        // children carry parent_id + a LOCAL pos; (0,0) sits at the parent.
        geo("tower", "Tower of Art", 0, 0, { parent_id: "uu", height: 14 }),
        geo("lib", "Library", 4, 2, { parent_id: "uu", height: 7 }),
        geo("palace", "Palace", 80, 70), // unrelated city entity
      ],
      bounds: CROP,
    };
    const t = geoTapRequest(map, "n1", { x_pct: 30 / 100, y_pct: 18 / 80 }, 16 / 9);
    expect(t).not.toBeNull();
    expect(t!.scene_view.focus_id).toBe("uu");
    const ids = t!.expected_layout.map((p) => p.id);
    // The interior (children) drives the layout…
    expect(ids).toContain("tower");
    // …the parent isn't part of its own interior, and unrelated city entities
    // (the Palace) don't leak in.
    expect(ids).not.toContain("uu");
    expect(ids).not.toContain("palace");
  });

  it("empty world → null (caller keeps the existing World Mode path)", () => {
    expect(
      geoTapRequest({ entities: [], bounds: CROP }, "n1", { x_pct: 0.5, y_pct: 0.5 }, 16 / 9),
    ).toBeNull();
  });

  it("tap of empty area with no cluster → null (not an enterable scene)", () => {
    const map = { entities: [geo("a", "a", 90, 70)], bounds: CROP };
    expect(geoTapRequest(map, "n1", { x_pct: 0.05, y_pct: 0.05 }, 16 / 9)).toBeNull();
  });
});
