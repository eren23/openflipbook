import { describe, expect, it, vi } from "vitest";
import type { RoomLayout } from "@openflipbook/config";
import { emptyPlaceScene, newComponent, parsePlaceScene, sceneGeos } from "./place-scene";
import { buildingParts } from "./building-structure";
import { roomAt, roomDoorLinks, roomLayoutGeometry } from "./room-layout";
import { reachableFloor, validateRoomCirculation } from "./room-circulation";
import { buildPlaceScene, disposePlace } from "../components/sketch/place-scene-renderer";
import { loadPlacePhysics } from "./place-physics";
import { placeCollider } from "./place-colliders";
import { mapChanges } from "./map-artwork";
import { parseWalkPose, poseSpaceMatches, walkSpace } from "./walk-position";
vi.mock("@dimforge/rapier3d-compat", async () => {
  // @ts-expect-error Browser entry shares package-root declarations.
  const rapier = await import("@dimforge/rapier3d-compat/rapier.es.js"); return { default: rapier.default };
});
function fixture(two = false) {
  const building = newComponent("building", 10, 10);
  if (two) { building.height = 7.8; building.structure!.floors.push({ id: "upper", label: "Upper room" }); }
  const layout: Extract<RoomLayout, { type: "split" }> = { type: "split", id: "partition", axis: "x", position: 1.5,
    door: { id: "door", offset: 0, width: 1.2, height: 2.2 }, a: { type: "room", id: "hall", label: "Hall" }, b: { type: "room", id: "study", label: "Study" } };
  building.structure!.floors[two ? 1 : 0]!.layout = layout;
  return { building, layout, definition: { ...emptyPlaceScene(), objects: [building] } };
}
describe("persistent room architecture", () => {
  it("round-trips room identities and derives envelopes and doorway adjacency", () => {
    const { building, definition } = fixture(); expect(parsePlaceScene(definition)).toEqual(definition);
    const { rooms } = roomLayoutGeometry(building, 0);
    expect(rooms).toEqual([{ id: "hall", label: "Hall", x1: -3.75, x2: 1.375, z1: -4.25, z2: 4.25 }, { id: "study", label: "Study", x1: 1.625, x2: 3.75, z1: -4.25, z2: 4.25 }]);
    expect(roomDoorLinks(building, 0)).toEqual([{ id: "door", a: "hall", b: "study" }]);
    expect(roomAt(building, 0, { x: 1.5, z: 0 })).toBeUndefined();
  });
  it.each(["small room", "thin door", "short door", "duplicate", "missing child", "deep", "crossed doorway"])("rejects %s", reason => {
    const { building, definition, layout } = fixture();
    if (reason === "small room") layout.position = 3;
    if (reason === "thin door") layout.door.width = 0.5;
    if (reason === "short door") layout.door.height = 1.8;
    if (reason === "duplicate") layout.a.id = layout.b.id;
    if (reason === "missing child") Object.assign(layout, { a: null });
    if (reason === "deep") layout.a = layout;
    if (reason === "crossed doorway") layout.b = { type: "split", id: "cross", axis: "z", position: 0, door: { id: "cross_door", offset: 2.7, width: 1, height: 2.2 }, a: { type: "room", id: "north", label: "North" }, b: { type: "room", id: "south", label: "South" } };
    expect(building.structure!.floors[0]!.layout).toBe(layout);
    expect(() => parsePlaceScene(definition)).toThrow();
  });
  it("rejects partitions through exterior entry or stairs, and accepts an upper side room", () => {
    const ground = fixture(); ground.layout.position = 0;
    expect(() => parsePlaceScene(ground.definition)).toThrow("exterior opening");
    const upper = fixture(true); expect(() => parsePlaceScene(upper.definition)).not.toThrow();
    upper.layout.axis = "z"; upper.layout.position = 0;
    expect(() => parsePlaceScene(upper.definition)).toThrow("stairs");
  });
  it("allows further subdivision when the earlier opening still connects whole rooms", () => {
    const { layout, definition, building } = fixture();
    layout.b = { type: "split", id: "cross", axis: "z", position: 1.5, door: { id: "cross_door", offset: 2.7, width: 1, height: 2.2 }, a: { type: "room", id: "north", label: "North" }, b: { type: "room", id: "south", label: "South" } };
    expect(() => parsePlaceScene(definition)).not.toThrow();
    expect(roomDoorLinks(building, 0)).toEqual([{ id: "door", a: "hall", b: "north" }, { id: "cross_door", a: "north", b: "south" }]);
  });
  it("keeps furnishings inside rooms and derives their map membership", () => {
    const { definition, building } = fixture();
    const bench = { ...newComponent("bench", 2.7, 2), width: 1, placement: { building_id: building.id, floor_id: building.structure!.floors[0]!.id } }; definition.objects.push(bench);
    expect(() => parsePlaceScene(definition)).not.toThrow();
    const geos = sceneGeos({ id: "scene", session_id: "world", place_id: "place", revision: 1, source_node_id: null, source_image_key: null, updated_at: "now", definition }, []);
    expect(geos.find(g => g.id === bench.id)).toMatchObject({ room_id: "study", parent_id: building.id });
    bench.x = 1.5; expect(() => parsePlaceScene(definition)).toThrow("partition");
    bench.x = 2.7; bench.z = 0; bench.width = 1.8; expect(() => parsePlaceScene(definition)).toThrow("interior doorway");
  });
  it("preserves saved room identity across rename but rejects substitution after merge", () => {
    const { definition, building, layout } = fixture(); building.heading = Math.PI / 2;
    const position = { x: 8, y: 0.835, z: 12.7 }, space = walkSpace(definition, position)!;
    expect(space).toMatchObject({ room_id: "study" });
    const pose = parseWalkPose({ version: 1, place_id: "place", scene_revision: 1, position, yaw: 0, pitch: 0, space })!;
    expect(pose.space).toEqual(space);
    if (layout.b.type === "room") layout.b.label = "Library";
    expect(poseSpaceMatches(pose, definition)).toBe(true);
    building.structure!.floors[0]!.layout = layout.a;
    expect(poseSpaceMatches(pose, definition)).toBe(false);
    expect(parseWalkPose({ ...pose, space: { ...space, room_id: "invalid id" } })).toBeNull();
  });
  it("does not repaint exterior artwork for interior layout or room names", () => {
    const { definition } = fixture(), before = structuredClone(definition);
    definition.objects[0]!.structure!.floors[0]!.layout = { type: "room", id: "hall", label: "One room" };
    expect(mapChanges(before, definition)).toEqual([]);
    definition.objects[0]!.height = 5; expect(mapChanges(before, definition)).toHaveLength(1);
  });
  it("keeps moved stairs out of exterior repaint and rejects intersection with upper partitions", () => {
    const { definition, building } = fixture(true), before = structuredClone(definition);
    building.structure!.stair = { id: "flight", x: -1, z: 0, direction: "north" };
    expect(() => parsePlaceScene(definition)).not.toThrow();
    expect(mapChanges(before, definition)).toEqual([]);
    building.structure!.stair.direction = "east"; building.structure!.stair.x = 0;
    expect(() => parsePlaceScene(definition)).toThrow("Partition crosses the stairs");
  });
  it("keeps upper partitions and door lintels out of plan cutaways without changing solids", () => {
    const { definition } = fixture(true), full = buildPlaceScene(definition), ground = buildPlaceScene(definition, { cutaway: true }), upper = buildPlaceScene(definition, { cutaway: true, floorId: "upper" });
    try {
      expect(full.solids).toEqual(upper.solids); expect(ground.solids).toEqual(full.solids);
      const visible: boolean[] = []; ground.scene.traverse(o => { if (o.userData.partitionId) visible.push(o.visible); }); expect(visible).toEqual([false, false, false]);
      const cut: boolean[] = []; upper.scene.traverse(o => { if (o.userData.partitionId) cut.push(o.visible); }); expect(cut).toEqual([true, true, false]);
    } finally { [full, ground, upper].forEach(b => disposePlace(b.scene)); }
  });
  it("does not show a downstairs partition through the selected upper slab", () => {
    const { definition, building } = fixture(true);
    building.structure!.floors[0]!.layout = { type: "split", id: "ground_partition", axis: "x", position: 1.5, door: { id: "ground_door", width: 1.2, height: 2.2, offset: 0 }, a: { type: "room", id: "ground_a", label: "Hall" }, b: { type: "room", id: "ground_b", label: "Study" } };
    const built = buildPlaceScene(definition, { cutaway: true, floorId: "upper" });
    try {
      const visible: boolean[] = []; built.scene.traverse(o => { if (o.userData.partitionId === "ground_partition") visible.push(o.visible); });
      expect(visible).toEqual([false, false, false]);
    } finally { disposePlace(built.scene); }
  });
  it("rejects partitions that clip part of a doorway or window despite a walkable remainder", () => {
    const { definition, layout } = fixture(); layout.position = 0.6;
    expect(() => parsePlaceScene(definition)).toThrow("exterior opening");
    definition.objects[0]!.structure!.door.offset = -2; layout.position = 0.8;
    expect(() => parsePlaceScene(definition)).toThrow("exterior opening");
  });
  it("physically blocks the partition and walks through its real door", async () => {
    const { definition, building } = fixture(), built = buildPlaceScene(definition), R = await loadPlacePhysics(), world = new R.World({ x: 0, y: -9.81, z: 0 });
    try {
      for (const p of built.solids) world.createCollider(placeCollider(R, p));
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(10, 0.835, 12));
      const capsule = world.createCollider(R.ColliderDesc.capsule(0.5, 0.3), body), controller = world.createCharacterController(0.02); world.step();
      const move = (x: number, z: number, count: number) => { for (let i = 0; i < count; i++) { controller.computeColliderMovement(capsule, { x, y: -0.01, z }); const p = body.translation(), d = controller.computedMovement(); body.setNextKinematicTranslation({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z }); world.step(); } };
      move(0.04, 0, 80); expect(body.translation().x).toBeLessThan(11.1);
      move(0, -0.04, 50); move(0.04, 0, 40); expect(body.translation().x).toBeGreaterThan(12);
      expect(walkSpace(definition, body.translation())?.room_id).toBe("study");
      expect(buildingParts(building).filter(p => p.partition_id)).toHaveLength(3);
    } finally { world.free(); disposePlace(built.scene); }
  });
});

describe("floor circulation", () => {
  it("resolves a narrow valid passage and rejects a capsule-width obstruction", () => {
    const bounds = { x1: 0, x2: 10, z1: 0, z2: 10 }, first = { x1: 4, x2: 6, z1: 0, z2: 4.5 }, second = { x1: 4, x2: 6, z1: 5.3, z2: 10 };
    expect(reachableFloor(bounds, [first, second], { x: 2, z: 5 }).point({ x: 8, z: 5 })).toBe(true);
    second.z1 = 5.1; expect(reachableFloor(bounds, [first, second], { x: 2, z: 5 }).point({ x: 8, z: 5 })).toBe(false);
  });
  it("rejects a room isolated by furnishings even when they do not touch its door", () => {
    const { definition, building } = fixture();
    definition.objects.push({ ...newComponent("mesh", -1.1875, 1.5), width: 4.4, depth: 0.3, height: 1, asset_id: "fixture", placement: { building_id: building.id, floor_id: building.structure!.floors[0]!.id } });
    expect(() => validateRoomCirculation(definition)).toThrow("clear walking route");
  });
});
