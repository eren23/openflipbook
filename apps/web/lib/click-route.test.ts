import { describe, expect, it } from "vitest";

import type { MapCrop, ObserverPose, SceneView, WorldEntityGeo } from "@openflipbook/config";

import { entityCloseupCrop, routeClick, routeToFocus } from "./click-route";

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
    source: "user",
    updated_at: "t",
    ...opts,
  };
}

const ASPECT = 16 / 9;
const CROP: MapCrop = { x: 0, y: 0, w: 100, h: 100 };
const mapView = (crop: MapCrop): SceneView => ({
  node_id: "n",
  level: "map",
  observer: null,
  map_crop: crop,
});
const sceneView = (observer: ObserverPose): SceneView => ({
  node_id: "n",
  level: "street",
  observer,
  map_crop: null,
});

function norm(a: number): number {
  let v = a;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
}

describe("routeClick (P6 coordinate-driven mode detection)", () => {
  it("transition tap (on the place's own closeup) → enter a scene facing it", () => {
    const map = { entities: [geo("tower", 50, 50, { height: 20 })], bounds: CROP };
    const closeupView: SceneView = {
      ...mapView(CROP),
      map_crop: { x: 41, y: 41, w: 18, h: 18 },
      focus_id: "tower",
      closeup: true,
    };
    const r = routeClick(map, closeupView, { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("scene");
    if (r.kind === "scene") {
      expect(r.focus_id).toBe("tower");
      expect(r.level).toBe("building"); // tall → building level
      // the synthesized observer gazes AT the tower
      const dx = 50 - r.observer.pos.x;
      const dy = 50 - r.observer.pos.y;
      expect(Math.abs(norm(Math.atan2(dy, dx) - r.observer.gaze))).toBeLessThan(1e-9);
      // …and stands off it (not on top of it)
      expect(Math.hypot(r.observer.pos.x - 50, r.observer.pos.y - 50)).toBeGreaterThan(5);
    }
  });

  it("short place → street level on the transition tap, not building", () => {
    const map = { entities: [geo("hut", 50, 50, { height: 4 })], bounds: CROP };
    const closeupView: SceneView = {
      ...mapView(CROP),
      map_crop: { x: 41, y: 44, w: 18, h: 12 },
      focus_id: "hut",
      closeup: true,
    };
    const r = routeClick(map, closeupView, { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind === "scene" && r.level).toBe("street");
  });

  it("tap empty map area with ≥2 nearby entities → submap crop", () => {
    const map = { entities: [geo("a", 20, 20), geo("b", 30, 25)], bounds: CROP };
    const r = routeClick(map, mapView(CROP), { x_pct: 0.25, y_pct: 0.225 }, ASPECT);
    expect(r.kind).toBe("submap");
    if (r.kind === "submap") {
      expect(r.crop.w).toBeLessThan(CROP.w);
      // the crop actually frames the cluster
      expect(r.crop.x).toBeLessThanOrEqual(20);
      expect(r.crop.x + r.crop.w).toBeGreaterThanOrEqual(30);
    }
  });

  it("tap empty map area with no entities → explainer", () => {
    const map = { entities: [geo("a", 90, 90)], bounds: CROP };
    expect(routeClick(map, mapView(CROP), { x_pct: 0.1, y_pct: 0.1 }, ASPECT).kind).toBe(
      "explainer",
    );
  });

  it("tap a non-place entity (item) → explainer, but remembers the focus", () => {
    const map = { entities: [geo("sword", 50, 50, { kind: "item" })], bounds: CROP };
    const r = routeClick(map, mapView(CROP), { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("explainer");
    if (r.kind === "explainer") expect(r.focus_id).toBe("sword");
  });

  it("scene view: tap a projected place → enter it", () => {
    const observer: ObserverPose = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };
    const map = { entities: [geo("hut", 50, 0, { height: 5 })], bounds: CROP };
    const r = routeClick(map, sceneView(observer), { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("scene");
    if (r.kind === "scene") expect(r.focus_id).toBe("hut");
  });

  it("scene view: tap empty sky → explainer", () => {
    const observer: ObserverPose = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };
    const map = { entities: [geo("hut", 50, 0)], bounds: CROP };
    expect(
      routeClick(map, sceneView(observer), { x_pct: 0.02, y_pct: 0.02 }, ASPECT).kind,
    ).toBe("explainer");
  });

  it("minSubmapEntities: 0 → empty map area routes submap, never explainer (W1 degrade)", () => {
    // Same setup as the no-entities explainer case above; the override flips it.
    const map = { entities: [geo("a", 90, 90)], bounds: CROP };
    const r = routeClick(map, mapView(CROP), { x_pct: 0.1, y_pct: 0.1 }, ASPECT, {
      minSubmapEntities: 0,
    });
    expect(r.kind).toBe("submap");
    if (r.kind === "submap") {
      // The window is centred on the tap, not the far-away entity.
      expect(r.crop.x + r.crop.w / 2).toBeCloseTo(10, 5);
      expect(r.crop.y + r.crop.h / 2).toBeCloseTo(10, 5);
    }
  });
});

describe("routeToFocus (enter a place resolved by NAME)", () => {
  it("synthesizes the same scene route a footprint hit would", () => {
    const focus = geo("tower", 60, 30, { height: 18 });
    // The footprint hit's SCENE form fires on the transition tap (the
    // closeup frame of this same focus) — compare against that.
    const byHit = routeClick(
      { entities: [focus], bounds: CROP },
      { ...mapView(CROP), focus_id: "tower", closeup: true },
      { x_pct: 0.6, y_pct: 0.3 },
      ASPECT,
    );
    const byName = routeToFocus(focus, { x: 50, y: 50 });
    expect(byName.kind).toBe("scene");
    expect(byName.focus_id).toBe("tower");
    expect(byName.level).toBe("building"); // tall → building
    expect(byHit.kind).toBe("scene");
    if (byHit.kind === "scene") {
      // Same standoff distance from the focus (direction differs with `from`).
      const d = (o: ObserverPose) => Math.hypot(o.pos.x - 60, o.pos.y - 30);
      expect(d(byName.observer)).toBeCloseTo(d(byHit.observer), 5);
    }
  });

  it("short places enter at street level", () => {
    expect(routeToFocus(geo("hut", 10, 10, { height: 4 }), { x: 0, y: 0 }).level).toBe(
      "street",
    );
  });
});

describe("the descent ladder (closeup rung)", () => {
  it("first tap on a place → closeup crop, not enter", () => {
    const map = { entities: [geo("palace", 50, 50, { footprint: { w: 10, d: 8 }, height: 18 })], bounds: CROP };
    const r = routeClick(map, mapView(CROP), { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("closeup");
    if (r.kind === "closeup") {
      expect(r.focus_id).toBe("palace");
      // window centred on the entity, footprint x margin as a frame fraction
      expect(r.crop.x + r.crop.w / 2).toBeCloseTo(50, 5);
      expect(r.crop.y + r.crop.h / 2).toBeCloseTo(50, 5);
      expect(r.crop.w).toBeCloseTo(18, 3); // max(10*1.6/100, 8*1.6/100, 0.18) = 0.18 -> 18
    }
  });

  it("tap on the place whose closeup you are ON → transition (enter)", () => {
    const palace = geo("palace", 50, 50, { footprint: { w: 10, d: 8 }, height: 18 });
    const map = { entities: [palace], bounds: CROP };
    const closeupView: SceneView = {
      node_id: "n-close",
      level: "map",
      observer: null,
      map_crop: { x: 41, y: 41, w: 18, h: 18 },
      focus_id: "palace",
      closeup: true,
    };
    const r = routeClick(map, closeupView, { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("scene");
    if (r.kind === "scene") expect(r.focus_id).toBe("palace");
  });

  it("plain submap focus_id (no closeup flag) still closeups, never enters", () => {
    const palace = geo("palace", 50, 50, { footprint: { w: 10, d: 8 } });
    const map = { entities: [palace], bounds: CROP };
    const submapView: SceneView = {
      node_id: "n-sub",
      level: "map",
      observer: null,
      map_crop: { x: 30, y: 30, w: 40, h: 40 },
      focus_id: "palace", // nearest-entity bookkeeping, NOT a closeup
    };
    const r = routeClick(map, submapView, { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("closeup");
  });

  it("frame-filling place skips the rung (degenerate guard) → enter", () => {
    const huge = geo("realm", 50, 50, { footprint: { w: 90, d: 90 }, height: 18 });
    const map = { entities: [huge], bounds: CROP };
    const r = routeClick(map, mapView(CROP), { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("scene");
  });

  it("scene frames (observer set) keep entering directly", () => {
    const observer: ObserverPose = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };
    const map = { entities: [geo("hut", 50, 0, { height: 5 })], bounds: CROP };
    const r = routeClick(map, sceneView(observer), { x_pct: 0.5, y_pct: 0.5 }, ASPECT);
    expect(r.kind).toBe("scene");
  });
});

describe("entityCloseupCrop", () => {
  const frame = { x: 0, y: 0, w: 100, h: 60 };
  it("clamps to the frame for edge entities", () => {
    const c = entityCloseupCrop(geo("gate", 2, 2, { footprint: { w: 30, d: 6 } }), frame);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(100);
    expect(c.y + c.h).toBeLessThanOrEqual(60);
  });
  it("tiny entities get the min fraction (context for Kontext)", () => {
    const c = entityCloseupCrop(geo("well", 50, 30, { footprint: { w: 1, d: 1 } }), frame);
    expect(c.w).toBeCloseTo(18, 5);
    expect(c.h).toBeCloseTo(10.8, 5);
  });
  it("preserves the frame aspect (w/h ratio)", () => {
    const c = entityCloseupCrop(geo("uni", 40, 30, { footprint: { w: 20, d: 6 } }), frame);
    expect(c.w / c.h).toBeCloseTo(100 / 60, 5);
  });
});
