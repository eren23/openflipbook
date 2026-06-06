import { describe, expect, it } from "vitest";

import type { EntityBBox, ObserverPose, SceneView } from "@openflipbook/config";

import {
  estimateGeoFromBBox,
  project,
  type ProjectInput,
} from "./world-geometry";

const ASPECT = 16 / 9;

// The seeding bridge must be the inverse of the projection engine — proving the
// world map can populate from extraction bboxes and round-trip back to a render.
describe("estimateGeoFromBBox (seeding bridge)", () => {
  it("map level: a bbox maps straight into the world crop", () => {
    const view: SceneView = {
      node_id: "n",
      level: "map",
      observer: null,
      map_crop: { x: 0, y: 0, w: 100, h: 60 },
    };
    const bbox: EntityBBox = { x_pct: 0.4, y_pct: 0.4, w_pct: 0.2, h_pct: 0.2 };
    const g = estimateGeoFromBBox(bbox, view, ASPECT);
    expect(g.pos.x).toBeCloseTo(50);
    expect(g.pos.y).toBeCloseTo(30);
    expect(g.footprint.w).toBeCloseTo(20);
    expect(g.footprint.d).toBeCloseTo(12);
  });

  it("map level: an offset crop shifts the recovered position", () => {
    const view: SceneView = {
      node_id: "n",
      level: "map",
      observer: null,
      map_crop: { x: 200, y: 100, w: 50, h: 50 },
    };
    const g = estimateGeoFromBBox(
      { x_pct: 0.0, y_pct: 0.0, w_pct: 0.2, h_pct: 0.2 },
      view,
      ASPECT,
    );
    expect(g.pos.x).toBeCloseTo(200 + 0.1 * 50); // centre of a top-left box
    expect(g.pos.y).toBeCloseTo(100 + 0.1 * 50);
  });

  it("perspective: round-trips an entity's position (project → bbox → estimate)", () => {
    const obs: ObserverPose = {
      pos: { x: 5, y: -3 },
      eye_height: 1.7,
      gaze: 0.4,
      fov: Math.PI / 2,
    };
    const view: SceneView = { node_id: "n", level: "eye", observer: obs, map_crop: null };
    // footprint.w = 6 == the estimator's DEFAULT_FOOTPRINT → distance recovers
    // exactly too, so the full position round-trips.
    const entity: ProjectInput = {
      id: "e",
      label: "e",
      pos: { x: 60, y: 20 },
      height: 8,
      footprint: { w: 6, d: 6 },
    };
    const p = project(entity, obs, ASPECT)!;
    const bbox: EntityBBox = {
      x_pct: p.x_pct - p.w_pct / 2,
      y_pct: p.y_pct - p.h_pct / 2,
      w_pct: p.w_pct,
      h_pct: p.h_pct,
    };
    const g = estimateGeoFromBBox(bbox, view, ASPECT);
    expect(g.pos.x).toBeCloseTo(60, 4);
    expect(g.pos.y).toBeCloseTo(20, 4);
  });
});
