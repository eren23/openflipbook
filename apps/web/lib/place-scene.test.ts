import { describe, expect, it } from "vitest";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
import { footprintComponent, gardenScene, newComponent, parsePlaceScene, sceneChanges, sceneGeos } from "./place-scene";
import { applyGeoUpsert } from "./world-map";
import { resolveAbsoluteFrame } from "./world-geometry";
import { buildPlaceScene, disposePlace } from "../components/sketch/place-scene-renderer";

const snapshot = (): PlaceSceneSnapshot => ({ id: "scene1", session_id: "world", place_id: "garden", revision: 1, source_node_id: "root", source_image_key: "map.png", definition: gardenScene(), updated_at: new Date().toISOString() });
describe("local scene contract", () => {
  it("turns a reversed plan drag into an exact authored footprint with unique IDs", () => {
    const a = footprintComponent("house", { x: 8, z: 9 }, { x: 3, z: 5 }, { width: 20, depth: 20 })!;
    const b = footprintComponent("house", { x: 3, z: 5 }, { x: 8, z: 9 }, { width: 20, depth: 20 })!;
    expect(a).toMatchObject({ kind: "house", x: 5.5, z: 7, width: 5, depth: 4, heading: 0, height: 6 });
    expect(a.id).not.toBe(b.id); expect(a.entity_id).not.toBe(b.entity_id);
    expect({ ...a, id: b.id, entity_id: b.entity_id }).toEqual(b);
  });
  it("clamps footprint endpoints and rejects clicks, slivers and nonfinite coordinates", () => {
    expect(footprintComponent("bench", { x: -1, z: -2 }, { x: 24, z: 28 }, { width: 20, depth: 20 })).toMatchObject({ x: 10, z: 10, width: 20, depth: 20 });
    for (const end of [{ x: 1, z: 1 }, { x: 1.1, z: 5 }, { x: NaN, z: 3 }, { x: 3, z: Infinity }]) expect(footprintComponent("house", { x: 1, z: 1 }, end, { width: 20, depth: 20 })).toBeNull();
  });
  it("mirrors building changes and drawn additions without moving the parent map frame", () => {
    const scene = snapshot(), previous = sceneGeos(scene, []);
    const house = footprintComponent("house", { x: 2, z: 2 }, { x: 5, z: 5 }, scene.definition)!;
    scene.definition.objects.push(house);
    house.width = 4; house.height = 8; house.heading = 0.2;
    const geos = sceneGeos(scene, previous), mapped = geos.find(g => g.id === house.id)!;
    expect(mapped).toMatchObject({ entity_id: house.entity_id, parent_id: scene.place_id, footprint: { w: 4, d: 3 }, height: 8, heading: 0.2, pos: { x: -6.5, y: -6.5 } });
    expect(geos[0]!.pos).toEqual(previous[0]!.pos);
    expect(geos.filter(g => g.id !== house.id)).toEqual(previous);
  });
  it("validates the garden without inventing measured scale", () => {
    const d = gardenScene(); expect(parsePlaceScene(d)).toEqual(d); expect(d.units).toBe("authored_metres");
    expect(d.objects.find(o => o.kind === "pond")!.x).toBeLessThan(d.entrance.x);
    expect(d.objects.find(o => o.kind === "pergola")!.z).toBeLessThan(d.objects.find(o => o.kind === "bench")!.z);
  });
  it("rejects impossible or non-building roof fields and unknown texture packs", () => {
    const d = gardenScene();
    d.objects[0]!.roof_material = "teal";
    expect(() => parsePlaceScene(d)).toThrow(/roof material/);
    delete d.objects[0]!.roof_material;
    const house = newComponent("house", 5, 5); d.objects = [house];
    house.eave_height = house.height;
    expect(() => parsePlaceScene(d)).toThrow(/eave/);
    house.eave_height = 4; house.roof_offset = 3;
    expect(() => parsePlaceScene(d)).toThrow(/roof offset/);
    house.roof_offset = 1; house.roof_material = "teal"; d.material_pack = "ankh-street-v1";
    expect(parsePlaceScene(d)).toEqual(d);
    expect(() => parsePlaceScene({ ...d, material_pack: "https://arbitrary.example/image" })).toThrow(/material pack/);
  });
  it.each([NaN, Infinity, -2, 0, 101])("rejects invalid physical dimensions %s", n => {
    const d = gardenScene(); d.width = n; expect(() => parsePlaceScene(d)).toThrow();
  });
  it("rejects duplicate identities, unsafe colors and unbound ids", () => {
    const d = gardenScene(); d.objects.push(d.objects[0]!); expect(() => parsePlaceScene(d)).toThrow();
    d.objects.pop(); d.objects[0]!.color = "url(secret)"; expect(() => parsePlaceScene(d)).toThrow();
    d.objects[0]!.color = "#445566"; d.objects[0]!.id = "../x"; expect(() => parsePlaceScene(d)).toThrow();
  });
  it("checks rotated footprints and blocked entrances", () => {
    const d = gardenScene(); d.objects[0]!.x = 0; expect(() => parsePlaceScene(d)).toThrow(/outside/);
    const clean = gardenScene(); clean.entrance = { x: 5, z: 8, yaw: 0 }; expect(() => parsePlaceScene(clean)).toThrow(/blocked/);
  });
  it("keeps paint separate from geometry", () => {
    const before = gardenScene(), after = structuredClone(before); after.objects[0]!.color = "#af3333";
    expect(sceneChanges(before, after)).toEqual(["Update Pond"]);
    expect({ ...after.objects[0], color: before.objects[0]!.color }).toEqual(before.objects[0]);
    expect(sceneChanges(before, before)).toEqual([]);
    expect(sceneChanges(before, parsePlaceScene(before))).toEqual([]);
  });
  it("tracks additions, removals, entrance and dimensions", () => {
    const before = gardenScene(), after = structuredClone(before); after.objects.shift(); after.objects.push(newComponent("tree", 2, 2)); after.width = 21; after.entrance.x++;
    expect(sceneChanges(before, after)).toEqual(expect.arrayContaining(["Remove Pond", "Add Tree", "Move entrance", "Update place dimensions or name"]));
  });
  it("binds scene components to canonical geos and calibrates nested metres", () => {
    const scene = snapshot(), first = sceneGeos(scene, []), parent = { ...first[0]!, pos: { x: 100, y: 200 }, footprint: { w: 2, d: 2 } };
    const geos = sceneGeos(scene, [parent]);
    expect(geos[0]).toMatchObject({ pos: { x: 100, y: 200 }, scale: 0.1 });
    const pond = geos.find(g => g.label === "Pond")!;
    expect(resolveAbsoluteFrame(pond.id, new Map(geos.map(g => [g.id, g])))).toEqual({ pos: { x: 99.5, y: 199.8 }, unit: 0.1 });
    expect(pond.entity_id).toBe(scene.definition.objects[0]!.entity_id);
  });
  it("legacy extraction cannot overwrite or forge a scene binding", () => {
    const geos = sceneGeos(snapshot(), []), old = geos[1]!;
    expect(applyGeoUpsert(geos, [{ ...old, pos: { x: 99, y: 99 } }], "later")).toEqual(geos);
    expect(applyGeoUpsert([], [old], "later")).toEqual([]);
  });
  it("builds horizontal pergola beams and open traversable space under them", () => {
    const def = gardenScene(), { scene, solids } = buildPlaceScene(def), pergola = def.objects.find(o => o.kind === "pergola")!;
    const beams = solids.filter(s => s.y >= pergola.height && s.x > 10);
    expect(beams.length).toBeGreaterThan(4); expect(beams.every(s => s.h < s.d || s.h < s.w)).toBe(true);
    expect(solids.some(s => Math.abs(s.x - pergola.x) < 0.5 && Math.abs(s.z - pergola.z) < 0.5 && s.y < 1.6)).toBe(false);
    expect(scene.children.length).toBeGreaterThan(def.objects.length); disposePlace(scene);
  });
});
