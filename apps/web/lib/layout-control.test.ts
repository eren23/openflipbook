import type { WorldEntityGeo } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import { routeToFocus } from "./click-route";
import { blockDistance, pointInBlock, renderLayoutControl, solidBlocks } from "./layout-control";

const geo = (label: string, x: number, y: number, w: number, d: number, height: number, extra: Partial<WorldEntityGeo> = {}) =>
  ({ id: `geo_${label}`, entity_id: null, kind: "place", label, pos: { x, y }, footprint: { w, d }, height, visual: "", state: {}, confidence: 1, source: "extracted", updated_at: "", ...extra }) as unknown as WorldEntityGeo;

// Lantern Quay as extracted from the painted map (live world, 2026-09-17).
const KETTLE = geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2);
const BELLFOUNDER = geo("Bellfounder Hall", 68.6, 32.6, 19.8, 16.3, 7.5);
const WELL = geo("Central Public Well", 52.3, 28.4, 8.2, 6.7, 4.7);
const LANTERN_QUAY = [
  KETTLE,
  BELLFOUNDER,
  WELL,
  geo("Lantern Watch", 57.6, 40.1, 12.8, 10.5, 6.2),
  geo("Blue Shutter Bakery", 71.9, 21.3, 13.4, 11, 5.6),
  geo("Mapmaker House", 58.9, 19, 13.8, 11.3, 5.7),
  geo("Tideglass Apothecary", 45.4, 18.5, 10.7, 8.8, 5),
  geo("Ropewalk Store", 43.4, 41.8, 15.5, 12.7, 6.1),
  geo("River Leven", 44.3, 51.2, 7.6, 6.2, 4),
  // The authored 3D-scene copy of the same inn, in another frame.
  geo("The Copper Kettle", -29.1, -2.4, 10, 12, 7.8, { id: "geo_scene_kettle", parent_id: "geo_scene" }),
];

describe("solidBlocks", () => {
  it("keeps top-level buildings and drops ground areas and nested scene copies", () => {
    const labels = solidBlocks(LANTERN_QUAY).map((b) => b.label);
    expect(labels).toContain("The Copper Kettle");
    expect(labels).not.toContain("River Leven");
    expect(solidBlocks(LANTERN_QUAY).filter((b) => b.label === "The Copper Kettle")).toHaveLength(1);
  });

  it("tests footprints in the block's own heading", () => {
    const rotated = geo("Rotated", 0, 0, 10, 2, 5, { heading: Math.PI / 2 });
    expect(pointInBlock(rotated, { x: 0, y: 4 })).toBe(true);
    expect(pointInBlock(rotated, { x: 4, y: 0 })).toBe(false);
  });
});

describe("blockDistance", () => {
  it("measures to the footprint edge: positive outside, negative inside", () => {
    expect(blockDistance(WELL, { x: WELL.pos.x, y: WELL.pos.y })).toBeCloseTo(-3.35, 2);
    expect(blockDistance(WELL, { x: WELL.pos.x + 4.1 + 5, y: WELL.pos.y })).toBeCloseTo(5, 6);
    // Diagonal: distance to the corner, not to a face.
    expect(blockDistance(WELL, { x: WELL.pos.x + 4.1 + 3, y: WELL.pos.y + 3.35 + 4 })).toBeCloseTo(5, 6);
  });
});

describe("enter camera placement", () => {
  const frameCentre = { x: 50, y: 30 };

  it("stands in the plaza facing the inn, not inside Bellfounder Hall", () => {
    const { observer } = routeToFocus(KETTLE, frameCentre, LANTERN_QUAY);
    // Buildings about as tall as the inn are walls; the low well square is ground.
    for (const wall of solidBlocks(LANTERN_QUAY).filter((b) => b.id !== KETTLE.id && b.height >= KETTLE.height * 0.8)) {
      expect(pointInBlock(wall, observer.pos, 1)).toBe(false);
    }
    expect(pointInBlock(BELLFOUNDER, observer.pos)).toBe(false);
    expect(pointInBlock(WELL, observer.pos)).toBe(true);
    const distance = Math.hypot(observer.pos.x - KETTLE.pos.x, observer.pos.y - KETTLE.pos.y);
    expect(distance).toBeLessThan(22); // was 29.3, inside Bellfounder Hall
    expect(Math.atan2(KETTLE.pos.y - observer.pos.y, KETTLE.pos.x - observer.pos.x)).toBeCloseTo(observer.gaze, 9);
  });

  it("keeps the requested bearing when nothing is in the way", () => {
    const { observer } = routeToFocus(KETTLE, frameCentre);
    const bearing = Math.atan2(observer.pos.y - KETTLE.pos.y, observer.pos.x - KETTLE.pos.x);
    expect(bearing).toBeCloseTo(Math.atan2(frameCentre.y - KETTLE.pos.y, frameCentre.x - KETTLE.pos.x), 9);
  });
});

describe("renderLayoutControl", () => {
  it("renders the entered place as the large centred block with exact boxes", () => {
    const { observer } = routeToFocus(KETTLE, { x: 50, y: 30 }, LANTERN_QUAY);
    const control = renderLayoutControl(LANTERN_QUAY, observer, 160, 90);
    expect(control.rgba).toHaveLength(160 * 90 * 4);
    const kettle = control.visible.find((v) => v.label === "The Copper Kettle")!;
    expect(kettle.color).toBe("red"); // largest visible block
    // Looking west from the plaza: Ropewalk (south) left, Tideglass (north) right.
    const x = (label: string) => control.visible.find((v) => v.label === label)!.x_pct;
    expect(x("Ropewalk Store")).toBeLessThan(kettle.x_pct);
    expect(x("Tideglass Apothecary")).toBeGreaterThan(kettle.x_pct);
    expect(kettle.x_pct).toBeGreaterThan(0.35);
    expect(kettle.x_pct).toBeLessThan(0.65);
    expect(kettle.w_pct).toBeGreaterThan(0.4);
    expect(control.visible.some((v) => v.label === "River Leven")).toBe(false);
    // Every visible box lies inside the frame.
    for (const v of control.visible) {
      expect(v.x_pct - v.w_pct / 2).toBeGreaterThanOrEqual(0);
      expect(v.x_pct + v.w_pct / 2).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("hides a block that sits fully behind a nearer, larger one", () => {
    const near = geo("Near", 10, 0, 4, 20, 10);
    const far = geo("Far", 30, 0, 4, 4, 3);
    const observer = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };
    const labels = renderLayoutControl([near, far], observer, 64, 36).visible.map((v) => v.label);
    expect(labels).toEqual(["Near"]);
  });

  it("puts a block on the right when it is to the right of the gaze", () => {
    const right = geo("Right", 10, 6, 3, 3, 6);
    const observer = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };
    const [box] = renderLayoutControl([right], observer, 64, 36).visible;
    expect(box!.x_pct).toBeGreaterThan(0.6);
    expect(box!.h_pos === "right" || box!.h_pos === "far-right").toBe(true);
  });
});

describe("depth buffer", () => {
  it("measures the distance to the block it hit, and the ground elsewhere", () => {
    const wall = geo("Wall", 20, 0, 4, 40, 10);
    const observer = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };
    const { depth, width, height } = renderLayoutControl([wall], observer, 64, 36);
    const centre = depth[Math.floor(height / 2) * width + Math.floor(width / 2)]!;
    // The wall's near face is 18 units ahead (20 - 4/2).
    expect(centre).toBeGreaterThan(17.5);
    expect(centre).toBeLessThan(18.6);
    // Straight down at the bottom of the frame is close ground, never Infinity.
    const low = depth[(height - 1) * width + Math.floor(width / 2)]!;
    expect(Number.isFinite(low)).toBe(true);
    expect(low).toBeLessThan(centre);
    // Sky above the wall is unbounded.
    expect(depth[Math.floor(width / 2)]).toBe(Infinity);
  });
});

describe("after a zoom-out (ascend reparents the town)", () => {
  it("keeps the same camera and visible buildings in the absolute frame", async () => {
    const { reparentRoots } = await import("./scale-tree");
    const { toAbsoluteEntities } = await import("./world-geometry");
    const town = LANTERN_QUAY.filter((e) => !e.parent_id);
    const before = routeToFocus(KETTLE, { x: 50, y: 30 }, town);
    const beforeLabels = renderLayoutControl(town, before.observer, 160, 90).visible.map((v) => v.label);

    const quarter = geo("The Riverward Quarter", 50, 30, 100, 60, 4, { id: "geo_quarter" });
    const { geos } = reparentRoots(town, quarter, "t0");
    // Stored numbers are re-expressed (not the town we started with)...
    expect(geos.find((g) => g.id === KETTLE.id)!.pos).not.toEqual(KETTLE.pos);
    // ...but in the absolute frame the same camera sees the same town.
    const absolute = toAbsoluteEntities(geos, geos);
    const kettle = absolute.find((g) => g.id === KETTLE.id)!;
    const after = routeToFocus(kettle, { x: 50, y: 30 }, absolute);
    expect(after.observer.pos.x).toBeCloseTo(before.observer.pos.x, 6);
    expect(after.observer.pos.y).toBeCloseTo(before.observer.pos.y, 6);
    const afterLabels = renderLayoutControl(absolute, after.observer, 160, 90, "geo_quarter").visible.map((v) => v.label);
    expect(afterLabels).toEqual(beforeLabels);
    expect(afterLabels.length).toBeGreaterThan(0);
  });

  it("never renders the 3D editor copy or a building's interior children", () => {
    const sceneCopy = geo("The Copper Kettle", 37, 29.1, 10, 12, 7.8, { id: "scene_kettle", scene_id: "scene1" });
    const interior = geo("Ropewalk Store", 16.7, 36.6, 33, 18, 4, { id: "inside", parent_id: KETTLE.id });
    const labels = solidBlocks([KETTLE, WELL, sceneCopy, interior]).map((b) => b.id);
    expect(labels).toEqual([KETTLE.id, WELL.id]);
  });
});
