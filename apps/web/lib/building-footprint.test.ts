import { expect, it, vi } from "vitest";
import type { PlaceSceneObject } from "@openflipbook/config";
import { buildingEnvelope, clipFloorRect, floorContainsRect, footprintContainsPoint, footprintWalls, openingPoint, openingWall, polygonArea } from "./building-footprint";
import { buildingBlocksPoint, buildingParts, buildingStair, parseBuildingStructure } from "./building-structure";
import { emptyPlaceScene, newComponent, parsePlaceScene, sceneGeos } from "./place-scene";
import { roomAt } from "./room-layout";
import { walkSpace } from "./walk-position";
import { validateFloorPlacements } from "./floor-placement";
import { acceptPlacePlan } from "./place-build";
import { mapObject, mapRepaintState } from "./map-artwork";
import { buildPlaceScene, disposePlace, THREE } from "../components/sketch/place-scene-renderer";
import { loadPlacePhysics } from "./place-physics";
import { placeCollider } from "./place-colliders";
vi.mock("@dimforge/rapier3d-compat", async () => {
  // @ts-expect-error The browser bundle uses the package-root declarations.
  const rapierModule = await import("@dimforge/rapier3d-compat/rapier.es.js");
  return { default: rapierModule.default };
});

function compound(shape: "L" | "U" | "T" = "U"): PlaceSceneObject {
  const o = newComponent("building", 20, 15); o.width = o.depth = 12;
  const points = shape === "L" ? [[-0.5,-0.5],[0,-0.5],[0,0],[0.5,0],[0.5,0.5],[-0.5,0.5]] : shape === "T" ? [[-0.5,-0.5],[0.5,-0.5],[0.5,-0.15],[0.2,-0.15],[0.2,0.5],[-0.2,0.5],[-0.2,-0.15],[-0.5,-0.15]] : [[-0.5,-0.5],[0.5,-0.5],[0.5,-0.2],[0,-0.2],[0,0.2],[0.5,0.2],[0.5,0.5],[-0.5,0.5]];
  o.structure!.footprint = points.map(([x, z], i) => ({ id: `wall_${i}`, x: x!, z: z! }));
  o.structure!.windows = [];
  const south = footprintWalls(o).find(w => w.side === "south" && w.edge === 6)!;
  o.structure!.door = { ...o.structure!.door, wall_id: south.id, offset: (south.low + south.high) / 2 };
  return o;
}
const definition = (o: PlaceSceneObject) => ({ ...emptyPlaceScene(), objects: [o] });
it.each(["L", "U", "T"] as const)("derives a connected %s shell, floor and map without filling its recesses", shape => {
  const o = compound(shape), d = parsePlaceScene(definition(o)), env = buildingEnvelope(o);
  expect(d.objects[0]!.structure).toEqual(o.structure);
  expect(env.floor).toHaveLength(1);
  const parts = buildingParts(o);
  for (const p of parts.filter(p => p.surface === "floor" || p.surface === "ceiling")) expect(floorContainsRect(o, { x1: p.x - p.w / 2, x2: p.x + p.w / 2, z1: p.z - p.d / 2, z2: p.z + p.d / 2 })).toBe(true);
  const area = parts.filter(p => p.surface === "floor").reduce((a, p) => a + p.w * p.d, 0);
  expect(area).toBeCloseTo(polygonArea(env.floor), 7);
  const geos = sceneGeos({ id: "scene", session_id: "world", place_id: "place", revision: 1, source_node_id: null, source_image_key: null, updated_at: "now", definition: d }, []);
  expect(geos[1]!.border).toHaveLength(o.structure!.footprint!.length);
  expect(geos[1]!.entity_id).toBe(o.entity_id);
  const built = buildPlaceScene(d);
  built.scene.traverse(mesh => {
    if (!(mesh instanceof THREE.Mesh) || mesh.userData.surface !== "roof") return;
    const a = mesh.geometry.getAttribute("position");
    // GPU positions are float32; authored envelope calculations use doubles.
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i) + mesh.position.x, z = a.getZ(i) + mesh.position.z;
      expect(env.roofRects.some(r => x >= r.x1 - 1e-6 && x <= r.x2 + 1e-6 && z >= r.z1 - 1e-6 && z <= r.z2 + 1e-6)).toBe(true);
    }
  });
  disposePlace(built.scene);
});
it("keeps the courtyard outdoors and excludes it from named rooms and floor furniture", () => {
  const o = compound(), d = definition(o), floor = o.structure!.floors[0]!;
  floor.layout = { type: "room", id: "room", label: "Hall" };
  expect(roomAt(o, 0, { x: 3, z: 0 })).toBeUndefined();
  expect(roomAt(o, 0, { x: -3, z: 0 })?.id).toBe("room");
  expect(walkSpace(d, { x: 23, y: 0.82, z: 15 })).toBeNull();
  expect(walkSpace(d, { x: 17, y: 0.82, z: 15 })).toMatchObject({ building_id: o.id, room_id: "room" });
  const prop = { ...newComponent("bench", 3, 0), placement: { building_id: o.id, floor_id: floor.id } };
  expect(() => validateFloorPlacements({ ...d, objects: [o, prop] })).toThrow("compound floor");
  prop.x = -3; expect(() => validateFloorPlacements({ ...d, objects: [o, prop] })).not.toThrow();
});
it("opens the identified recessed wall, not the other east-facing walls", () => {
  const o = compound(), s = o.structure!, wall = footprintWalls(o).find(w => w.side === "east" && w.edge === 0)!;
  s.door = { ...s.door, side: "east", wall_id: wall.id, offset: 0 };
  expect(() => parsePlaceScene(definition(o))).not.toThrow();
  expect(openingPoint(o, s.door)).toEqual({ x: 0, z: 0 });
  expect(buildingBlocksPoint(o, { x: 20, z: 15 })).toBe(false);
  expect(buildingBlocksPoint(o, { x: 20, z: 16.8 })).toBe(true);
  expect(buildingBlocksPoint(o, { x: 26, z: 11 })).toBe(true);
  const before = structuredClone(o);
  delete s.door.wall_id; expect(() => parseBuildingStructure(o)).toThrow("identified exterior wall");
  o.structure = before.structure!; o.structure!.door.wall_id = "missing";
  expect(() => openingWall(o, o.structure!.door)).toThrow("identified exterior wall");
});
it("retains stair clearance and clips upper slabs to both footprint and stairwell", () => {
  const o = compound(); o.height = 7.8; o.structure!.floors.push({ id: "upper", label: "Upper" });
  expect(() => parsePlaceScene(definition(o))).not.toThrow();
  expect(buildingParts(o).filter(p => p.surface === "floor" && p.y > 0).every(p => footprintContainsPoint(o, p, true))).toBe(true);
  o.structure!.stair = { id: "flight", x: 2, z: 0, direction: "north" };
  expect(() => parseBuildingStructure(o)).toThrow("compound floor");
});
it("clips partitions to the compound room envelope and rejects doors in its void", () => {
  const o = compound(), s = o.structure!;
  s.floors[0]!.layout = { type: "split", id: "partition", axis: "z", position: -3.2, door: { id: "inner", offset: -3, width: 1.2, height: 2.2 }, a: { type: "room", id: "a", label: "North" }, b: { type: "room", id: "b", label: "Main" } };
  expect(() => parsePlaceScene(definition(o))).not.toThrow();
  s.floors[0]!.layout.position = 0;
  expect(() => parsePlaceScene(definition(o))).not.toThrow();
  const partition = buildingParts(o).filter(p => p.partition_id);
  expect(partition.every(p => p.x + p.w / 2 <= -0.25)).toBe(true);
  s.floors[0]!.layout.door.offset = 3;
  expect(() => parsePlaceScene(definition(o))).toThrow("connect two rooms");
});
it.each(["diagonal", "short", "backwards", "bounds", "extent", "duplicate", "crossing", "empty", "many"])("rejects invalid %s outlines", reason => {
  const o = compound(), ring = o.structure!.footprint!;
  if (reason === "diagonal") ring[1]!.z += 0.01;
  if (reason === "short") { ring[2]!.z = -0.49; ring[3]!.z = -0.49; }
  if (reason === "backwards") ring.reverse();
  if (reason === "bounds") ring[0]!.x = -0.6;
  if (reason === "extent") for (const p of ring) p.x *= 0.8;
  if (reason === "duplicate") ring[1]!.id = ring[0]!.id;
  if (reason === "crossing") { ring[3]!.x = -0.5; ring[4]!.x = -0.5; }
  if (reason === "empty") o.structure!.footprint = [];
  if (reason === "many") o.structure!.footprint = [...ring, ...ring, ...ring, ...ring];
  expect(() => parseBuildingStructure(o)).toThrow();
});
it("allows generated courtyard props and remaps every wall reference deterministically", () => {
  const o = compound(), wall = footprintWalls(o).find(w => w.side === "east" && w.edge === 0)!;
  o.structure!.door = { ...o.structure!.door, side: "east", wall_id: wall.id, offset: 0 };
  const prop = newComponent("tree", 24, 15); prop.width = prop.depth = 1;
  const result = { objects: [o, prop] }, base = emptyPlaceScene();
  const next = acceptPlacePlan(base, result, "compound");
  const s = next.objects[0]!.structure!;
  expect(s.footprint!.every(p => p.id.startsWith("gen_compound_"))).toBe(true);
  expect(s.footprint!.some(p => p.id === s.door.wall_id)).toBe(true);
  expect(acceptPlacePlan(base, result, "compound")).toEqual(next);
});
it("draws the registered concave outline instead of a bounding rectangle", () => {
  const o = compound(), before = definition(o), after = structuredClone(before); after.objects[0]!.x += 1;
  const r = { x: 50, y: 50, width: 60, rotation: 23 }, frame = { width: 1600, height: 900 };
  expect(mapObject(o, before, r, frame).points).toHaveLength(8);
  const state = mapRepaintState(before, after, r, frame, 2);
  const outline = state.scene.elements.find(e => e.customData?.role === "footprint")!;
  expect(outline.type).toBe("line"); expect(outline.points).toHaveLength(9);
  const points = outline.points as number[][]; expect(points[0]).toEqual([0, 0]); expect(points[0]).toEqual(points.at(-1));
  const projected = mapObject(after.objects[0]!, after, r, frame).points;
  points.slice(0, -1).forEach((p, i) => { expect(outline.x + p[0]!).toBeCloseTo(projected[i]!.x, 8); expect(outline.y + p[1]!).toBeCloseTo(projected[i]!.y, 8); });
});
it("subtracts rectangular exclusions without merging across a hole", () => {
  const o = compound(), cells = clipFloorRect(o, { x1: -5, x2: -1, z1: -4, z2: 4 }, [{ x1: -4, x2: -2, z1: -1, z2: 1 }]);
  expect(cells.reduce((a, r) => a + (r.x2 - r.x1) * (r.z2 - r.z1), 0)).toBeCloseTo(28);
  expect(cells.some(r => r.x1 < -3 && r.x2 > -3 && r.z1 < 0 && r.z2 > 0)).toBe(false);
});
it("walks from a courtyard through its recessed doorway, upstairs and back through real collision", async () => {
  const o = compound(); o.height = 7.8; o.structure!.floors.push({ id: "upper", label: "Upper" });
  const wall = footprintWalls(o).find(w => w.side === "east" && w.edge === 0)!;
  o.structure!.door = { ...o.structure!.door, side: "east", wall_id: wall.id, offset: 0 };
  const d = parsePlaceScene(definition(o)), built = buildPlaceScene(d), stair = buildingStair(o), R = await loadPlacePhysics(), world = new R.World({ x: 0, y: -9.81, z: 0 });
  try {
    for (const p of built.solids) world.createCollider(placeCollider(R, p));
    const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(27, 0.82, 15));
    const collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.3), body), controller = world.createCharacterController(0.02);
    controller.enableSnapToGround(0.2); controller.enableAutostep(0.25, 0.2, false); controller.setSlideEnabled(true); world.step();
    let vy = 0;
    const step = (x: number, z: number) => {
      const p = body.translation(); vy = controller.computedGrounded() ? -0.2 : Math.max(-20, vy - 9.81 / 60);
      controller.computeColliderMovement(collider, { x, y: vy / 60, z }); const delta = controller.computedMovement();
      body.setNextKinematicTranslation({ x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z }); world.timestep = 1 / 60; world.step();
    };
    const move = (axis: "x" | "z", target: number) => {
      for (let i = 0; i < 700 && Math.abs(body.translation()[axis] - target) > 0.035; i++) {
        const delta = Math.sign(target - body.translation()[axis]) * 0.035; step(axis === "x" ? delta : 0, axis === "z" ? delta : 0);
      }
      expect(Math.abs(body.translation()[axis] - target), JSON.stringify(body.translation())).toBeLessThan(0.04);
    };
    move("x", 23); expect(walkSpace(d, body.translation())).toBeNull();
    move("x", 18); expect(walkSpace(d, body.translation())?.building_id).toBe(o.id);
    move("x", o.x + stair.x); move("z", o.z + stair.point(0, -stair.run / 2 - 0.45).z);
    expect(body.translation().y).toBeGreaterThan(stair.level + 0.75);
    expect(walkSpace(d, body.translation())?.floor_id).toBe("upper");
    move("z", 15); for (let i = 0; i < 30; i++) step(0, 0);
    expect(body.translation().y).toBeLessThan(0.9); move("x", 27);
    expect(walkSpace(d, body.translation())).toBeNull();
  } finally { world.free(); disposePlace(built.scene); }
});
