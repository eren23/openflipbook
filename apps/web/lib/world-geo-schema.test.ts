import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  MapCrop,
  ObserverPose,
  ProjectedEntity,
  SceneView,
  WorldEntityGeo,
  WorldMapSnapshot,
  WorldVec2,
} from "@openflipbook/config";

// P0 schema-parity gate (TS side). The Python twin
// (apps/modal-backend/tests/test_geo_schema.py) validates the Pydantic mirrors
// against the SAME shared fixture, so together they lock TS↔Py drift.
const fixture = JSON.parse(
  readFileSync(
    // vitest runs with cwd = apps/web (pnpm -C apps/web test).
    path.resolve(process.cwd(), "../../packages/config/src/world-geo-fixture.json"),
    "utf8",
  ),
) as { keys: Record<string, string[]>; samples: Record<string, unknown> };

// Typed witnesses — tsc FAILS THE BUILD if any required interface field is
// missing/renamed. Each must deep-equal its shared fixture sample (the same JSON
// the Python gate validates), which ties the TS interfaces to the wire shape.
const worldVec2: WorldVec2 = { x: 10, y: 20 };
const observerPose: ObserverPose = {
  pos: { x: 0, y: 0 },
  eye_height: 1.7,
  gaze: 0,
  pitch: 0,
  fov: 1.2,
};
const mapCrop: MapCrop = { x: 0, y: 0, w: 100, h: 60 };
const sceneView: SceneView = {
  node_id: "n1",
  level: "eye",
  observer: observerPose,
  map_crop: null,
  focus_id: "g1",
};
const projectedEntity: ProjectedEntity = {
  id: "g1",
  label: "Lighthouse",
  x_pct: 0.5,
  y_pct: 0.4,
  w_pct: 0.2,
  h_pct: 0.6,
  depth: 30,
  h_pos: "center",
  v_pos: "mid",
  size: "large",
};
const worldEntityGeo: WorldEntityGeo = {
  id: "g1",
  entity_id: "e1",
  kind: "place",
  label: "Lighthouse",
  pos: { x: 10, y: 20 },
  height: 12,
  elevation: 0,
  footprint: { w: 4, d: 4 },
  heading: 0,
  visual: "red-and-white striped tower",
  state: { lit: true },
  confidence: 0.9,
  source: "user",
  updated_at: "2026-06-06T00:00:00Z",
};
const worldMapSnapshot: WorldMapSnapshot = {
  session_id: "s1",
  entities: [],
  bounds: mapCrop,
  schema_version: 1,
  updated_at: "2026-06-06T00:00:00Z",
};

const witnesses: Record<string, unknown> = {
  WorldVec2: worldVec2,
  ObserverPose: observerPose,
  MapCrop: mapCrop,
  SceneView: sceneView,
  ProjectedEntity: projectedEntity,
  WorldEntityGeo: worldEntityGeo,
  WorldMapSnapshot: worldMapSnapshot,
};

describe("geometric-world schema parity", () => {
  const shapes = Object.keys(fixture.keys);

  it.each(shapes)("%s: typed witness deep-equals the shared fixture", (shape) => {
    expect(witnesses[shape]).toEqual(fixture.samples[shape]);
  });

  it.each(shapes)("%s: witness keys match the fixture key set", (shape) => {
    expect(
      Object.keys(witnesses[shape] as Record<string, unknown>).sort(),
    ).toEqual([...(fixture.keys[shape] ?? [])].sort());
  });
});
