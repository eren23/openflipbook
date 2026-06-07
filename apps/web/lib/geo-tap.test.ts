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
  it("tapping a place → scene_view (observer); a FIRST enter steers by nothing", () => {
    const map = {
      entities: [
        geo("clock", "clock tower", 60, 30, {
          height: 18,
          visual: "an ancient brass clock tower",
        }),
        geo("lh", "lighthouse", 45, 15, { height: 25 }),
      ],
      bounds: CROP,
    };
    const t = geoTapRequest(map, "n1", { x_pct: 60 / 100, y_pct: 30 / 80 }, 16 / 9);
    expect(t).not.toBeNull();
    expect(t!.focus_id).toBe("clock");
    expect(t!.focus_label).toBe("clock tower"); // drives the entered subject
    expect(t!.focus_visual).toBe("an ancient brass clock tower"); // identity anchor
    expect(t!.scene_view.level).toBe("building"); // tall → building
    expect(t!.scene_view.observer).not.toBeNull();
    // First enter — no saved interior → steer by NOTHING, so the OTHER city
    // landmark (the lighthouse) is NOT dragged into the clock-tower scene. The
    // child frame seeds from this scene's own extraction instead.
    expect(t!.expected_layout).toEqual([]);
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

  it("an observer/level override (from the detail popover) wins + re-projects", () => {
    const map = {
      entities: [
        geo("uu", "Unseen University", 30, 18, { height: 15 }),
        geo("tower", "Tower of Art", 0, 0, { parent_id: "uu", height: 14 }),
        geo("lib", "Library", 4, 2, { parent_id: "uu", height: 7 }),
      ],
      bounds: CROP,
    };
    const click = { x_pct: 30 / 100, y_pct: 18 / 80 };
    const def = geoTapRequest(map, "n1", click, 16 / 9)!;
    const custom = {
      ...def.scene_view.observer!,
      pos: { x: 31, y: 25 },
      gaze: -Math.PI / 2,
      pitch: 0.3,
    };
    const t = geoTapRequest(map, "n1", click, 16 / 9, {
      observer: custom,
      level: "eye",
    })!;
    // the popover's adjusted pose + level win over the synthesized ones
    expect(t.scene_view.observer).toEqual(custom);
    expect(t.scene_view.level).toBe("eye");
    // and the layout is re-projected from the overridden pose
    expect(t.expected_layout).not.toEqual(def.expected_layout);
  });

  it("tap on an empty cluster → submap (stay in map, crop the region)", () => {
    const map = {
      entities: [geo("a", "market", 45, 40), geo("b", "well", 58, 45)],
      bounds: { x: 0, y: 0, w: 100, h: 80 },
    };
    // (51,42) is empty (between the two) but the 40% window holds both → submap
    const t = geoTapRequest(map, "n1", { x_pct: 51 / 100, y_pct: 42 / 80 }, 16 / 9);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("submap");
    expect(t!.scene_view.level).toBe("map");
    expect(t!.scene_view.observer).toBeNull();
    expect(t!.scene_view.map_crop).not.toBeNull();
    // the cropped region carries its in-frame entities (for the minimap + steer)
    expect(t!.layout_entities.length).toBeGreaterThanOrEqual(2);
  });

  it("tapping a place still routes to a scene (not a submap)", () => {
    const map = {
      entities: [geo("clock", "clock tower", 60, 30, { height: 18 })],
      bounds: CROP,
    };
    const t = geoTapRequest(map, "n1", { x_pct: 60 / 100, y_pct: 30 / 80 }, 16 / 9);
    expect(t!.kind).toBe("scene");
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
