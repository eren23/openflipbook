import { describe, expect, it } from "vitest";

import type { Entity, SceneView } from "@openflipbook/config";

import { sceneCloseupSpec } from "./scene-closeup";

function entity(id: string, name: string, bbox?: { x_pct: number; y_pct: number; w_pct: number; h_pct: number }): Entity {
  return {
    id,
    kind: "place",
    name,
    aliases: [],
    appearance: "stone building",
    reference_image_url: null,
    facts: [],
    state: {},
    first_seen_node_id: "n1",
    last_seen_node_id: "n1",
    appears_on_node_ids: ["n1"],
    appearance_bboxes: bbox ? { n1: bbox } : {},
    pinned_by_user: false,
    confidence: 0.8,
    updated_at: "t",
  };
}

const sceneView = (over: Partial<SceneView> = {}): SceneView => ({
  node_id: "n1",
  level: "building",
  observer: {
    pos: { x: 60, y: 38 },
    eye_height: 1.7,
    gaze: -1.2,
    pitch: 0.2,
    fov: Math.PI / 2,
  },
  map_crop: null,
  focus_id: "geo_palace",
  scale_tier: "place",
  ...over,
});

describe("sceneCloseupSpec (the ladder inside entered scenes)", () => {
  const hall = entity("hall", "The Great Hall", {
    x_pct: 0.4,
    y_pct: 0.3,
    w_pct: 0.2,
    h_pct: 0.25,
  });

  it("a tap on a localized entity → closeup with a padded, clamped box", () => {
    const spec = sceneCloseupSpec([hall], "n1", { x_pct: 0.5, y_pct: 0.4 }, sceneView());
    expect(spec).not.toBeNull();
    if (spec?.kind !== "closeup") throw new Error("expected closeup");
    expect(spec.name).toBe("The Great Hall");
    // padded ×1.6 around the bbox centre
    expect(spec.regionBox.w).toBeCloseTo(0.32, 5);
    expect(spec.regionBox.h).toBeCloseTo(0.4, 5);
    expect(spec.regionBox.x + spec.regionBox.w / 2).toBeCloseTo(0.5, 5);
    // the scene_view keeps the scene's register + descends one rung
    expect(spec.sceneView.level).toBe("building");
    expect(spec.sceneView.closeup).toBe(true);
    expect(spec.sceneView.focus_id).toBe("geo_hall");
    expect(spec.sceneView.scale_tier).toBe("room");
  });

  it("the tap on the entity whose closeup you are ON → transition", () => {
    const spec = sceneCloseupSpec(
      [hall],
      "n1",
      { x_pct: 0.5, y_pct: 0.4 },
      sceneView({ closeup: true, focus_id: "geo_hall" }),
    );
    expect(spec).toEqual({ kind: "transition", name: "The Great Hall" });
  });

  it("a frame-filling bbox skips the rung → transition", () => {
    const big = entity("keep", "The Keep", {
      x_pct: 0.05,
      y_pct: 0.05,
      w_pct: 0.9,
      h_pct: 0.9,
    });
    const spec = sceneCloseupSpec([big], "n1", { x_pct: 0.5, y_pct: 0.5 }, sceneView());
    expect(spec).toEqual({ kind: "transition", name: "The Keep" });
  });

  it("null on map frames, missed taps, and unlocalized entities", () => {
    expect(
      sceneCloseupSpec([hall], "n1", { x_pct: 0.5, y_pct: 0.4 }, sceneView({ level: "map" })),
    ).toBeNull();
    expect(
      sceneCloseupSpec([hall], "n1", { x_pct: 0.05, y_pct: 0.05 }, sceneView()),
    ).toBeNull();
    expect(
      sceneCloseupSpec([entity("ghost", "Unlocalized")], "n1", { x_pct: 0.5, y_pct: 0.4 }, sceneView()),
    ).toBeNull();
  });

  it("tiny entities get the minimum context fraction", () => {
    const well = entity("well", "The Well", {
      x_pct: 0.48,
      y_pct: 0.48,
      w_pct: 0.04,
      h_pct: 0.04,
    });
    const spec = sceneCloseupSpec([well], "n1", { x_pct: 0.5, y_pct: 0.5 }, sceneView());
    if (spec?.kind !== "closeup") throw new Error("expected closeup");
    expect(spec.regionBox.w).toBeCloseTo(0.18, 5);
    expect(spec.regionBox.h).toBeCloseTo(0.18, 5);
  });
});
