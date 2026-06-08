import { describe, expect, it } from "vitest";

import type { SceneView, WorldEntityGeo } from "@openflipbook/config";

import { anchorForTile } from "./atlas-anchors";

function geo(
  id: string,
  x: number,
  y: number,
  opts: Partial<WorldEntityGeo> = {},
): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label: id,
    pos: { x, y },
    height: 4,
    footprint: { w: 6, d: 6 },
    visual: "",
    state: {},
    confidence: 1,
    source: "derived",
    updated_at: "t",
    ...opts,
  };
}

const geoMap = {
  entities: [
    geo("uu", 30, 18),
    geo("tower", 0, 0, { parent_id: "uu" }), // child, local pos
    geo("palace", 35, 20),
    geo("bridge", 80, 50),
  ],
};

function sv(over: Partial<SceneView> = {}): SceneView {
  return {
    node_id: "n",
    level: "building",
    observer: {
      pos: { x: 40, y: 25 },
      eye_height: 1.7,
      gaze: 1.1,
      fov: Math.PI / 2,
      pitch: 0,
    },
    map_crop: null,
    focus_id: "uu",
    ...over,
  };
}

describe("anchorForTile", () => {
  it("a scene view → focus coords + gaze + nearest neighbours", () => {
    const a = anchorForTile(sv(), geoMap)!;
    expect(a).not.toBeNull();
    expect(a.gazeAngle).toBe(1.1);
    expect(a.focusWorldPos).toEqual({ x: 30, y: 18 });
    // palace (35,20) is the nearest to uu (30,18); bridge is far
    expect(a.neighbors[0]!.id).toBe("palace");
    expect(a.neighbors.length).toBeLessThanOrEqual(3);
  });

  it("a map view has no gaze tick", () => {
    const a = anchorForTile(sv({ level: "map", observer: null }), geoMap)!;
    expect(a.gazeAngle).toBeNull();
  });

  it("null sceneView or an unknown focus → null (classic/pre-geo tiles)", () => {
    expect(anchorForTile(null, geoMap)).toBeNull();
    expect(anchorForTile(sv({ focus_id: "nope" }), geoMap)).toBeNull();
  });
});
