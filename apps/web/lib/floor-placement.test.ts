import { describe, expect, it, vi } from "vitest";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import { emptyPlaceScene, newComponent, parsePlaceScene, sceneGeos } from "./place-scene";
import { bindObjectToFloor, findFloorPlacement, floorLocalPoint, resolveSceneObject } from "./floor-placement";
import { buildPlaceScene, disposePlace } from "../components/sketch/place-scene-renderer";
import { resolveAbsoluteFrame } from "./world-geometry";
import { mapChanges, mapObject } from "./map-artwork";
import { networkView } from "./place-connections";
import { loadPlacePhysics } from "./place-physics";
import { placeCollider } from "./place-colliders";

vi.mock("@dimforge/rapier3d-compat", async () => {
  // @ts-expect-error Browser entry shares the package-root declarations.
  const rapier = await import("@dimforge/rapier3d-compat/rapier.es.js");
  return { default: rapier.default };
});
function fixture() {
  const building = newComponent("building", 20, 20);
  building.height = 7.8; building.structure!.floors.push({ id: "upper", label: "Upper room" });
  const bench = { ...newComponent("bench", 1, 0), placement: { building_id: building.id, floor_id: "upper" } };
  const definition = { ...emptyPlaceScene(), objects: [building, bench] };
  return { definition, building, bench };
}
const snapshot = (definition: ReturnType<typeof fixture>["definition"]): PlaceSceneSnapshot => ({ id: "scene", session_id: "world", place_id: "place", revision: 1, source_node_id: null, source_image_key: null, updated_at: new Date(0).toISOString(), definition });

describe("canonical floor furnishing", () => {
  it.each(["north", "east", "south", "west"] as const)("protects the moved %s flight and its landings", direction => {
    const { definition, building, bench } = fixture(); building.width = building.depth = 12;
    building.structure!.stair = { id: "flight", x: 0, z: 0, direction };
    bench.x = 0; bench.z = 0;
    expect(() => parsePlaceScene(definition)).toThrow("stairs or landing");
    bench.x = direction === "east" || direction === "west" ? 2.8 : 0;
    bench.z = direction === "east" || direction === "west" ? 0 : 2.8;
    expect(() => parsePlaceScene(definition)).toThrow("stairs or landing");
    bench.x = 3.8; bench.z = 3.8;
    expect(() => parsePlaceScene(definition)).not.toThrow();
  });
  it("persists a local binding, not redundant world coordinates or elevation", () => {
    const { definition, bench } = fixture(); bench.x = -0.5;
    expect(parsePlaceScene(definition)).toEqual(definition);
    const parsed = parsePlaceScene({ ...definition, objects: definition.objects.map(o => ({ ...o, elevation: 90 })) });
    expect(parsed.objects[1]).not.toHaveProperty("elevation");
    expect(resolveSceneObject(parsed, bench)).toMatchObject({ x: 19.5, z: 20, elevation: 3.2 });
  });
  it("carries rotation, movement and changing storey height without mutating the furnishing", () => {
    const { definition, building, bench } = fixture(), before = structuredClone(bench);
    building.heading = Math.PI / 2; building.x = 24; building.height = 8.6;
    const resolved = resolveSceneObject(definition, bench);
    expect(resolved.x).toBeCloseTo(24); expect(resolved.z).toBeCloseTo(21);
    expect(resolved.elevation).toBeCloseTo(3.6); expect(resolved.heading).toBeCloseTo(Math.PI / 2);
    expect(floorLocalPoint(building, resolved)).toEqual({ x: 1, z: expect.closeTo(0) });
    expect(bench).toEqual(before); expect(() => parsePlaceScene(definition)).not.toThrow();
  });
  it("binds a sketch footprint without moving its pixels and normalizes wrapped headings", () => {
    const { definition, building, bench } = fixture(); building.heading = -Math.PI * 2;
    const sketch = { ...newComponent("bench", 21, 20), heading: Math.PI * 2, drawing_element_id: "stroke" };
    const bound = bindObjectToFloor(definition, sketch, bench.placement);
    expect(bound.x).toBeCloseTo(1); expect(bound.z).toBeCloseTo(0); expect(bound.heading).toBeCloseTo(0);
    expect(bound.drawing_element_id).toBe("stroke");
    expect(() => parsePlaceScene({ ...definition, objects: [building, bound] })).not.toThrow();
    const resolved = resolveSceneObject(definition, bound);
    expect(resolved.x).toBeCloseTo(sketch.x); expect(resolved.z).toBeCloseTo(sketch.z);
    expect(Math.cos(resolved.heading)).toBeCloseTo(Math.cos(sketch.heading));
  });
  it.each(["missing building", "removed floor", "version", "invalid kind", "outside", "ceiling", "stairs", "overlap", "invalid binding"])("rejects %s before persistence", reason => {
    const { definition, building, bench } = fixture();
    if (reason === "missing building") bench.placement.building_id = "absent";
    if (reason === "removed floor") { building.structure!.floors.pop(); building.height = 4.6; }
    if (reason === "version") definition.version = 1;
    if (reason === "invalid kind") bench.kind = "tree";
    if (reason === "outside") bench.x = 3;
    if (reason === "ceiling") bench.height = 3.2;
    if (reason === "stairs") bench.x = -2.8;
    if (reason === "overlap") definition.objects.push({ ...bench, id: "duplicate", entity_id: "duplicate_entity" });
    if (reason === "invalid binding") bench.placement.floor_id = "";
    expect(() => parsePlaceScene(definition)).toThrow();
  });
  it("keeps ground door clearance and entrance validation floor-aware", () => {
    const { definition, building, bench } = fixture();
    bench.placement.floor_id = building.structure!.floors[0]!.id; bench.x = 0; bench.z = 3.5;
    expect(() => parsePlaceScene(definition)).toThrow("doorway");
    bench.x = 1; bench.z = 0; definition.entrance = { x: 21, z: 20, yaw: 0 };
    expect(() => parsePlaceScene(definition)).toThrow("Entrance");
    bench.placement.floor_id = "upper";
    expect(() => parsePlaceScene(definition)).not.toThrow();
  });
  it("permits the same footprint on separate floors and finds a new clear slot", () => {
    const { definition, building, bench } = fixture();
    definition.objects.push({ ...bench, id: "lower", entity_id: "lower_entity", placement: { ...bench.placement, floor_id: building.structure!.floors[0]!.id } });
    expect(() => parsePlaceScene(definition)).not.toThrow();
    const placed = findFloorPlacement(definition, newComponent("bench", 0, 0), bench.placement)!;
    expect(placed).not.toBeNull();
    expect(() => parsePlaceScene({ ...definition, objects: [...definition.objects, placed] })).not.toThrow();
  });
  it("projects stable building/floor identity into the map's translation-only frame", () => {
    const { definition, building, bench } = fixture(); building.heading = Math.PI / 2;
    const geos = sceneGeos(snapshot(definition), []), geo = geos.find(g => g.id === bench.id)!;
    expect(geo).toMatchObject({ parent_id: building.id, floor_id: "upper", elevation: 3.2, heading: Math.PI / 2 });
    const absolute = resolveAbsoluteFrame(geo.id, new Map(geos.map(g => [g.id, g])))!;
    expect(absolute.pos.x).toBeCloseTo(20); expect(absolute.pos.y).toBeCloseTo(21);
    const p = mapObject(bench, definition, { x: 50, y: 50, width: 40, rotation: 0 }, { width: 1000, height: 600 });
    expect(p.cx).toBeCloseTo(500); expect(p.cy).toBeCloseTo(310);
  });
  it("excludes interior-only edits from exterior repaint, including moves indoors/outdoors", () => {
    const { definition, bench } = fixture(), after = structuredClone(definition);
    after.objects[1]!.color = "#ff0000"; expect(mapChanges(definition, after)).toEqual([]);
    delete after.objects[1]!.placement; after.objects[1]!.x = 30; after.objects[1]!.z = 30;
    expect(mapChanges(definition, after)).toEqual([{ before: undefined, after: after.objects[1] }]);
    expect(mapChanges(after, definition)).toEqual([{ before: after.objects[1], after: undefined }]);
    expect(bench.placement.floor_id).toBe("upper");
  });
  it("applies connected chunk offsets once, through the parent building", () => {
    const { definition, bench } = fixture(), a = snapshot(definition), b = { ...snapshot({ ...emptyPlaceScene(), objects: [] }), id: "b", place_id: "b" };
    const view = networkView({ chunks: [{ scene: a, x: 40, z: 0 }, { scene: b, x: 0, z: 0 }], connections: [] }, "place");
    const object = view.definition.objects.find(o => o.id === bench.id)!;
    expect(object.x).toBe(1); expect(resolveSceneObject(view.definition, object).x).toBe(61);
  });
  it("uses the same transformed elevation for rendered meshes and colliders", async () => {
    const { definition, building, bench } = fixture(); building.heading = Math.PI / 2;
    const built = buildPlaceScene(definition), R = await loadPlacePhysics(), world = new R.World({ x: 0, y: -9.81, z: 0 });
    try {
      built.scene.updateMatrixWorld(true);
      const group = built.scene.children.find(g => g.userData.sceneObjectId === bench.id)!;
      expect(group.position.toArray()).toEqual([20, 3.2, 21]);
      for (const solid of built.solids) world.createCollider(placeCollider(R, solid));
      world.step();
      const hit = (x: number, y: number, z: number) => world.intersectionWithShape({ x, y, z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Ball(0.07));
      expect(hit(20, 3.65, 21)).not.toBeNull();
      expect(hit(20, 0.45, 21)).toBeNull();
    } finally { world.free(); disposePlace(built.scene); }
  });
  it("shows only the selected floor furnishings without changing walk collision", () => {
    const { definition, building, bench } = fixture(), full = buildPlaceScene(definition), outside = buildPlaceScene(definition, { cutaway: true }), upper = buildPlaceScene(definition, { cutaway: true, floorId: "upper" });
    try {
      const visible = (built: typeof full) => built.scene.children.find(g => g.userData.sceneObjectId === bench.id)!.visible;
      expect(visible(full)).toBe(true); expect(visible(outside)).toBe(false); expect(visible(upper)).toBe(true);
      expect(upper.solids).toEqual(full.solids);
      const group = upper.scene.children.find(g => g.userData.sceneObjectId === building.id)!;
      expect(group.children.filter(g => g.userData.surface === "floor" && g.position.y > 0).every(g => g.visible)).toBe(true);
    } finally { [full, outside, upper].forEach(b => disposePlace(b.scene)); }
  });
});
