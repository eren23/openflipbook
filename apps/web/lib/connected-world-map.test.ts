import { describe, expect, it } from "vitest";
import type { PlaceConnection, PlaceNetwork, PlaceSceneSnapshot } from "@openflipbook/config";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { connectedMapRoute, connectedMapWalkPoint, connectedWorldMap } from "./connected-world-map";
import type { WalkPose } from "./walk-position";

function scene(id: string, width: number, depth: number, buildings: number): PlaceSceneSnapshot {
  return { id: `scene_${id}`, session_id: "world", place_id: id, revision: 3, source_node_id: null, source_image_key: null, updated_at: new Date(0).toISOString(), definition: { ...emptyPlaceScene(), label: id, width, depth, entrance: { x: width / 2, z: depth - 1.2, yaw: 0 }, objects: Array.from({ length: buildings }, (_, i) => ({ ...newComponent("building", 8 + i * 10, 10), id: `${id}_${i}` })) } };
}
function fixture(): PlaceNetwork {
  const connection = (id: string, side: "east" | "west" | "north", target: string, targetSide: "west" | "east" | "south", targetOffset = 20): PlaceConnection => ({ id, version: 1, kind: "boundary", a: { place_id: "root", side, offset: 20 }, b: { place_id: target, side: targetSide, offset: targetOffset }, width: 3, created_at: new Date(0).toISOString() });
  return { chunks: [{ scene: scene("root", 40, 40, 3), x: 0, z: 0 }, { scene: scene("east", 24, 32, 2), x: 40, z: 4 }, { scene: scene("west", 16, 40, 2), x: -16, z: 0 }, { scene: scene("north", 40, 40, 1), x: 0, z: -40 }], connections: [connection("east_door", "east", "east", "west", 16), connection("west_door", "west", "west", "east"), connection("north_door", "north", "north", "south")] };
}

describe("spatial connected world map", () => {
  it("retains all four saved places and eight buildings in the actual 80×80 metre frame", () => {
    const network = fixture(), before = structuredClone(network), map = connectedWorldMap(network, "root");
    expect(map).toMatchObject({ width: 80, depth: 80, buildingCount: 8 });
    expect(map.chunks.map(c => [c.scene.place_id, c.x, c.z])).toEqual([["root", 16, 40], ["east", 56, 44], ["west", 0, 40], ["north", 16, 0]]);
    expect(map.portals.map(p => [p.connection.id, p.x, p.z])).toEqual([["east_door", 56, 60], ["west_door", 16, 60], ["north_door", 36, 40]]);
    expect(network).toEqual(before);
  });
  it("draws authored compound footprints and doors in the building's rotated world frame", () => {
    const network = fixture(), object = network.chunks[0]!.scene.definition.objects[0]!;
    object.width = 10; object.depth = 8; object.heading = Math.PI / 2;
    object.structure!.footprint = [{ id: "a", x: -.5, z: -.5 }, { id: "b", x: .5, z: -.5 }, { id: "c", x: .5, z: 0 }, { id: "d", x: 0, z: 0 }, { id: "e", x: 0, z: .5 }, { id: "f", x: -.5, z: .5 }];
    object.structure!.door = { ...object.structure!.door, side: "north", offset: 1, wall_id: "a" };
    const mapped = connectedWorldMap(network, "root").objects[0]!;
    expect(mapped.outline).toHaveLength(6);
    expect(mapped.outline[0]!.x).toBeCloseTo(28); expect(mapped.outline[0]!.z).toBeCloseTo(45);
    expect(mapped.door!.x).toBeCloseTo(28); expect(mapped.door!.z).toBeCloseTo(51);
  });
  it("keeps upper-floor furnishings out of the outdoor map", () => {
    const network = fixture(), building = network.chunks[0]!.scene.definition.objects[0]!;
    network.chunks[0]!.scene.definition.objects.push({ ...newComponent("bench", 1, 1), id: "upstairs_seat", placement: { building_id: building.id, floor_id: building.structure!.floors[0]!.id } });
    expect(connectedWorldMap(network, "root").objects.map(o => o.object.id)).not.toContain("upstairs_seat");
  });
  it("normalizes a real saved walk pose once and refuses stale or unrelated poses", () => {
    const map = connectedWorldMap(fixture(), "root");
    const pose: WalkPose = { version: 1, place_id: "root", scene_revision: 3, position: { x: 20, y: .82, z: 38.8 }, yaw: .5, pitch: 0 };
    expect(connectedMapWalkPoint(map, pose)).toMatchObject({ x: 36, z: 78.8, place_id: "root", yaw: .5 });
    expect(connectedMapWalkPoint(map, { ...pose, place_id: "east", position: { x: 17.5, y: .82, z: 10.5 } })).toMatchObject({ x: 73.5, z: 54.5, place_id: "east" });
    for (const invalid of [null, { ...pose, scene_revision: 2 }, { ...pose, place_id: "elsewhere" }, { ...pose, position: { ...pose.position, x: 99 } }, { ...pose, yaw: NaN }]) expect(connectedMapWalkPoint(map, invalid)).toBeNull();
  });
  it("uses registered openings for routes across places and reports disconnected targets", () => {
    const network = fixture(), map = connectedWorldMap(network, "root");
    const route = connectedMapRoute(map, "west", "north")!;
    expect(route.places).toEqual(["west", "root", "north"]); expect(route.portals.map(p => p.connection.id)).toEqual(["west_door", "north_door"]);
    expect(connectedMapRoute(map, "east", "east")).toEqual({ places: ["east"], portals: [] });
    expect(connectedMapRoute(map, "east", "missing")).toBeNull();
    network.connections = network.connections.filter(c => c.id !== "north_door");
    expect(connectedMapRoute(connectedWorldMap(network, "root"), "east", "north")).toBeNull();
  });
  it("refuses missing, duplicated, nonfinite and misaligned source geometry", () => {
    const network = fixture();
    expect(() => connectedWorldMap(network, "missing")).toThrow("not loaded");
    for (const modify of [(n: PlaceNetwork) => { n.chunks[1]!.x = NaN; }, (n: PlaceNetwork) => { n.chunks[1]!.scene.place_id = "root"; }, (n: PlaceNetwork) => { n.chunks[1]!.x += 1; }, (n: PlaceNetwork) => { n.connections[0]!.b.place_id = "missing"; }, (n: PlaceNetwork) => { n.connections[0]!.a.offset = 0; }, (n: PlaceNetwork) => { n.connections.push(n.connections[0]!); }]) {
      const invalid = structuredClone(network); modify(invalid); expect(() => connectedWorldMap(invalid, "root")).toThrow();
    }
  });
});
