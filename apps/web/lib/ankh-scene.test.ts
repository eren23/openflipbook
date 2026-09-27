import { describe, expect, it } from "vitest";
import { ankhStreetScene, DRUM_APPROACH } from "./ankh-scene";
import { parsePlaceScene, sceneGeos } from "./place-scene";
import { buildPlaceScene, disposePlace } from "../components/sketch/place-scene-renderer";
import { angleDifference, routeMovement } from "./walk-route";

describe("Mended Drum authored street", () => {
  it("validates all rotated footprints and keeps entrance on Short Street", () => {
    const d = ankhStreetScene(); expect(parsePlaceScene(d)).toEqual(d);
    expect(d.entrance).toEqual({ x: 34.2, z: 6, yaw: Math.PI });
    expect(d.objects.filter(o => o.kind === "tavern")).toHaveLength(1);
    const tavern = d.objects.find(o => o.kind === "tavern")!;
    expect(tavern.z - tavern.depth / 2).toBe(13);
    expect(tavern.x - tavern.width * 0.04).toBe(12.6);
  });
  it("issues fresh object and entity IDs for each world template instance", () => {
    const a = ankhStreetScene(), b = ankhStreetScene();
    expect(a.objects.every(o => !b.objects.some(p => p.id === o.id || p.entity_id === o.entity_id))).toBe(true);
  });
  it("round trips street components through the existing scene/geo contract", () => {
    const definition = parsePlaceScene(JSON.parse(JSON.stringify(ankhStreetScene())));
    const geos = sceneGeos({ id: "street", session_id: "session", place_id: "drum", revision: 1, source_node_id: "source", source_image_key: "map.png", updated_at: "2026-09-10", definition }, []);
    expect(geos).toHaveLength(definition.objects.length + 1);
    expect(geos.find(g => g.label === "The Mended Drum")).toMatchObject({ footprint: { w: 10, d: 5.4 }, height: 7, scene_id: "street" });
  });
  it("keeps the full approach clear of solids at eye level and closes the tavern", () => {
    const def = ankhStreetScene(), { scene, solids } = buildPlaceScene(def);
    const occupied = (x: number, z: number) => solids.some(s => {
      if (s.y + s.h / 2 < 0.1 || s.y - s.h / 2 > 1.6) return false;
      const dx = x - s.x, dz = z - s.z, c = Math.cos(s.yaw), sin = Math.sin(s.yaw);
      return Math.abs(dx * c - dz * sin) < s.w / 2 + 0.32 && Math.abs(dx * sin + dz * c) < s.d / 2 + 0.32;
    });
    let prev = def.entrance;
    for (const point of DRUM_APPROACH) {
      for (let i = 0; i <= 100; i++) expect(occupied(prev.x + (point.x - prev.x) * i / 100, prev.z + (point.z - prev.z) * i / 100)).toBe(false);
      prev = point;
    }
    expect(occupied(12.6, 13.2)).toBe(true);
    expect(occupied(25.3, 12.8)).toBe(true);
    disposePlace(scene);
  });
});

describe("collision-driven guided route", () => {
  it("turns before moving and never advances waypoints without physical arrival", () => {
    const state = { index: 0, held: 0 }, route = [{ x: 0, z: 3, yaw: Math.PI }];
    expect(routeMovement(route, state, { x: 0, z: 0 }, 0, 0.02)).toMatchObject({ x: 0, z: 0, done: false });
    for (let i = 0; i < 300; i++) routeMovement(route, state, { x: 0, z: 0 }, Math.PI, 0.02);
    expect(state.index).toBe(0);
  });
  it("follows the two turns, stops before the door and looks back east", () => {
    const state = { index: 0, held: 0 }, d = ankhStreetScene();
    let { x, z, yaw } = d.entrance, done = false;
    for (let i = 0; i < 2000 && !done; i++) {
      const m = routeMovement(DRUM_APPROACH, state, { x, z }, yaw, 0.02);
      x += m.x; z += m.z; yaw = m.yaw; done = m.done;
    }
    expect(done).toBe(true); expect(x).toBeCloseTo(12.6, 1); expect(z).toBeCloseTo(12, 1); expect(yaw).toBe(-Math.PI / 2);
    expect(angleDifference(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(0.2);
    expect(routeMovement([], state, { x, z }, yaw, 0.02).done).toBe(true);
  });
});
