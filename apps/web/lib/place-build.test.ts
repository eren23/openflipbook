import { expect, it } from "vitest";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { acceptPlacePlan } from "./place-build";
import type { BuildingSide, PlaceBuildConnectionInput } from "@openflipbook/config";
import { OPPOSITE_SIDE } from "./place-connections";

function connections(side: BuildingSide = "east"): PlaceBuildConnectionInput {
  return { version: 1, place_id: "place", connections: [{ id: "road", version: 1, kind: "boundary", width: 4, created_at: "2026-09-13",
    a: { place_id: "neighbor", side: OPPOSITE_SIDE[side], offset: 20 }, b: { place_id: "place", side, offset: 20 } }] };
}

it("separates object and entity symbols while retaining unambiguous floor references", () => {
  const building = newComponent("building", 20, 15); building.entity_id = building.id;
  const floor = building.structure!.floors[0]!;
  const bench = { ...newComponent("bench", 2, 2), placement: { building_id: building.id, floor_id: floor.id } }; bench.entity_id = bench.id;
  const raw = { objects: [building, bench] }, before = structuredClone(raw);
  const result = acceptPlacePlan(emptyPlaceScene(), raw, "same-symbol");
  expect(result.objects[0]!.id).not.toBe(result.objects[0]!.entity_id);
  expect(result.objects[1]!.placement).toEqual({ building_id: result.objects[0]!.id, floor_id: result.objects[0]!.structure!.floors[0]!.id });
  expect(acceptPlacePlan(emptyPlaceScene(), raw, "same-symbol")).toEqual(result); expect(raw).toEqual(before);
  bench.entity_id = building.entity_id;
  expect(() => acceptPlacePlan(emptyPlaceScene(), raw, "duplicate-entity")).toThrow();
});

it("furnishes an explicitly selected saved upper floor without changing its architecture", () => {
  const building = newComponent("building", 20, 15); building.height = 7.8;
  building.heading = Math.PI / 4;
  building.structure!.floors.push({ id: "upper", label: "Upper" });
  const base = { ...emptyPlaceScene(), objects: [building] }, before = structuredClone(base);
  const target = { building_id: building.id, floor_id: "upper" };
  const bench = { ...newComponent("bench", 2, 2), placement: target };
  const next = acceptPlacePlan(base, { objects: [bench] }, "furnish", undefined, target);
  expect(next.objects[0]).toEqual(building); expect(next.objects[1]!.placement).toEqual(target);
  expect(next.objects[1]!.x).toBe(2); expect(next.objects[1]!.id).not.toBe(bench.id); expect(base).toEqual(before);
  for (const bad of [{ ...bench, placement: undefined }, { ...bench, placement: { ...target, floor_id: building.structure!.floors[0]!.id } }, newComponent("building", 30, 30)]) {
    expect(() => acceptPlacePlan(base, { objects: [bad] }, "wrong", undefined, target)).toThrow("selected saved floor");
  }
  expect(() => acceptPlacePlan(base, { objects: [bench] }, "missing", undefined, { ...target, floor_id: "absent" })).toThrow("floor");
  expect(() => acceptPlacePlan(base, { objects: [{ ...bench, width: 0.5, x: -2.95, z: 0 }] }, "blocked", undefined, target)).toThrow("stairs");
});

it.each(["north", "east", "south", "west"] as const)("preserves and routes the saved %s connection using either endpoint", side => {
  const base = { ...emptyPlaceScene(), entrance: { x: 20, z: 20, yaw: 0 } }, input = connections(side), before = structuredClone(input);
  expect(acceptPlacePlan(base, { objects: [newComponent("bench", 8, 8)] }, "connected", input).objects).toHaveLength(1);
  const blocked = { ...newComponent("wall", side === "west" ? 0.5 : side === "east" ? 39.5 : 20, side === "north" ? 0.5 : side === "south" ? 39.5 : 20), width: 0.8, depth: 0.8 };
  expect(() => acceptPlacePlan(base, { objects: [blocked] }, "blocked", input)).toThrow("Connection approach is blocked");
  expect(input).toEqual(before);
});
it("rejects an isolated connection pocket even when its full one-metre approach is empty", () => {
  const wall = { ...newComponent("wall", 38, 20), width: 0.5, depth: 40 };
  expect(() => acceptPlacePlan(emptyPlaceScene(), { objects: [wall] }, "pocket", connections())).toThrow("reachable approach");
});
it("rejects foreign, duplicated and unsupported connection input without inventing links", () => {
  const input = connections(), result = { objects: [newComponent("bench", 8, 8)] };
  expect(() => acceptPlacePlan(emptyPlaceScene(), result, "job", { ...input, place_id: "foreign" })).toThrow("another place");
  expect(() => acceptPlacePlan(emptyPlaceScene(), result, "job", { ...input, connections: [...input.connections, ...input.connections] })).toThrow("Invalid build connection");
  expect(() => acceptPlacePlan(emptyPlaceScene(), { ...result, connections: [] }, "job", input)).toThrow("additions only");
});

it("accepts structured additions with deterministic identities without changing the source", () => {
  const base = emptyPlaceScene(), tree = newComponent("tree", 3, 3); base.objects.push(tree);
  const before = structuredClone(base), building = newComponent("building", 20, 15);
  const bench = { ...newComponent("bench", 2, 2), placement: { building_id: building.id, floor_id: building.structure!.floors[0]!.id } };
  const result = { objects: [building, bench] }, next = acceptPlacePlan(base, result, "job1");
  expect(base).toEqual(before); expect(next.objects[0]).toEqual(tree);
  expect(next.objects[1]!.id).not.toBe(building.id);
  expect(next.objects[2]!.placement).toEqual({ building_id: next.objects[1]!.id, floor_id: next.objects[1]!.structure!.floors[0]!.id });
  expect(acceptPlacePlan(base, result, "job1")).toEqual(next);
  expect(acceptPlacePlan(base, result, "job2").objects[1]!.id).not.toBe(next.objects[1]!.id);
});
it("remaps nested room and doorway identities along with floor-local props", () => {
  const base = emptyPlaceScene(), building = newComponent("building", 20, 15);
  building.structure!.floors[0]!.layout = { type: "split", id: "partition", axis: "x", position: 1.5,
    door: { id: "inside_door", width: 1.2, height: 2.2, offset: 0 }, a: { type: "room", id: "hall", label: "Hall" }, b: { type: "room", id: "office", label: "Office" } };
  const next = acceptPlacePlan(base, { objects: [building] }, "job");
  expect(next.objects[0]!.structure!.floors[0]!.layout).toMatchObject({ id: expect.stringMatching(/^gen_job_/), b: { label: "Office", id: expect.stringMatching(/^gen_job_/) } });
});
it("remaps planned stair identity while preserving its authored placement", () => {
  const building = newComponent("building", 20, 15); building.height = 7.8;
  building.structure!.floors.push({ id: "upper", label: "Upper" });
  building.structure!.stair = { id: "flight", x: 0, z: 0, direction: "east" };
  const next = acceptPlacePlan(emptyPlaceScene(), { objects: [building] }, "stairs");
  expect(next.objects[0]!.structure!.stair).toEqual({ id: expect.stringMatching(/^gen_stairs_/), x: 0, z: 0, direction: "east" });
});
it("rejects changing place geometry, duplicate existing objects, meshes and fixed architecture templates", () => {
  const base = emptyPlaceScene(), tree = newComponent("tree", 3, 3); base.objects.push(tree);
  for (const result of [{ objects: [newComponent("bench", 10, 10)], width: 80 }, { objects: [tree] }, { objects: [newComponent("house", 10, 10)] }, { objects: [{ ...newComponent("mesh", 10, 10), asset_id: "fake" }] }, { objects: [] }]) expect(() => acceptPlacePlan(base, result, "job")).toThrow();
});
it("rejects overlapping buildings and an unreachable external doorway", () => {
  const base = emptyPlaceScene(), a = newComponent("building", 15, 15), b = newComponent("building", 16, 15);
  expect(() => acceptPlacePlan(base, { objects: [a, b] }, "job")).toThrow("overlaps");
  a.x = 4; a.structure!.door.side = "west";
  expect(() => acceptPlacePlan(base, { objects: [a] }, "job")).toThrow("reachable exterior doorway");
});
it("checks all existing door approaches when an addition blocks access", () => {
  const base = emptyPlaceScene(), a = newComponent("building", 15, 15); base.objects.push(a);
  const wall = { ...newComponent("wall", 15, 20.2), width: 8 };
  expect(() => acceptPlacePlan(base, { objects: [wall] }, "job")).toThrow("reachable exterior doorway");
});
it("accepts a varied multi-building district without substituting a canned layout", () => {
  const base = { ...emptyPlaceScene(), width: 80, depth: 80, entrance: { x: 40, z: 77, yaw: 0 } };
  const objects = Array.from({ length: 8 }, (_, i) => ({ ...newComponent("building", 12 + i % 4 * 18, 15 + Math.floor(i / 4) * 35), label: `Workshop ${i}`, height: i === 0 ? 7.8 : 4.6 }));
  objects[0]!.structure!.floors.push({ id: "upper", label: "Upstairs" });
  const next = acceptPlacePlan(base, { objects }, "district");
  expect(next.objects).toHaveLength(8); expect(next.objects.map(o => o.label)).toEqual(objects.map(o => o.label));
  expect(next.objects[0]!.structure!.floors).toHaveLength(2);
});
