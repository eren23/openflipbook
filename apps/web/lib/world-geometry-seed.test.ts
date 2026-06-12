import { describe, expect, it } from "vitest";

import type { EntityBBox, ObserverPose, SceneView } from "@openflipbook/config";

import {
  estimateGeoFromBBox,
  mapPolygonToCrop,
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

  it("FIX A — oblique map: box width drives footprint, box height drives entity height", () => {
    const view: SceneView = {
      node_id: "n",
      level: "map",
      observer: null,
      map_crop: { x: 0, y: 0, w: 100, h: 60 },
    };
    const bbox: EntityBBox = { x_pct: 0.4, y_pct: 0.2, w_pct: 0.1, h_pct: 0.4 };
    const flat = estimateGeoFromBBox(bbox, view, ASPECT, "top_down");
    const oblique = estimateGeoFromBBox(bbox, view, ASPECT, "oblique");
    // same ground position…
    expect(oblique.pos.x).toBeCloseTo(flat.pos.x);
    expect(oblique.pos.y).toBeCloseTo(flat.pos.y);
    // …but a tall box → a tall entity (0.4 * 60 * 0.5 = 12), vs the flat default (4)
    expect(flat.height).toBe(4);
    expect(oblique.height).toBeCloseTo(12);
    // FIX A: width tracks the box (0.1 * 100 = 10), depth damped by cos(pitch)
    // at -60° → 10 * (0.5 + 0.5*0.5) = 7.5; no longer a flat 6×6 default.
    expect(oblique.footprint.w).toBeCloseTo(10);
    expect(oblique.footprint.d).toBeCloseTo(7.5);
  });

  it("codex #5 — camera pitch foreshortens height-from-extent", () => {
    const view: SceneView = {
      node_id: "n",
      level: "map",
      observer: null,
      map_crop: { x: 0, y: 0, w: 100, h: 60 },
    };
    const bbox: EntityBBox = { x_pct: 0.4, y_pct: 0.2, w_pct: 0.1, h_pct: 0.4 };
    // Near the horizon (pitch 0) the whole box extent reads as true height.
    const horizon = estimateGeoFromBBox(bbox, view, ASPECT, "oblique", 0);
    expect(horizon.height).toBeCloseTo(0.4 * 60); // cos(0) = 1 → 24
    // The classic -60° bird's-eye halves it — i.e. the old hand-tuned 0.5,
    // now derived from the estimated camera rather than hard-coded.
    const oblique60 = estimateGeoFromBBox(bbox, view, ASPECT, "oblique", -60);
    expect(oblique60.height).toBeCloseTo(12); // cos(60°) = 0.5
    // Looking straight down, the extent is roof footprint, not height → the
    // height-from-extent signal vanishes and we fall back to the default.
    const nadir = estimateGeoFromBBox(bbox, view, ASPECT, "oblique", -89);
    expect(nadir.height).toBe(4);
    // Omitting pitch keeps the legacy -60° default (back-compat).
    const legacy = estimateGeoFromBBox(bbox, view, ASPECT, "oblique");
    expect(legacy.height).toBeCloseTo(12);
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

describe("mapPolygonToCrop (B2 segmenter border -> frame coords)", () => {
  it("maps 0..1 image vertices through the same linear map a bbox centre takes", () => {
    const crop = { x: 0, y: 0, w: 100, h: 60 };
    const out = mapPolygonToCrop(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 0.5 },
      ],
      crop,
    );
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 30 },
    ]);
    // and through an offset submap crop
    const sub = mapPolygonToCrop([{ x: 0.5, y: 0.5 }], { x: 40, y: 20, w: 30, h: 20 });
    expect(sub).toEqual([{ x: 55, y: 30 }]);
  });
});
