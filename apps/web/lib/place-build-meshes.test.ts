import { expect, it } from "vitest";
import { acceptPlacePlan } from "./place-build";
import { acceptMeshPlan, bindPlannedMeshes } from "./place-build-meshes";
import { emptyPlaceScene, newComponent, parsePlaceScene } from "./place-scene";
import { resolveSceneObject } from "./floor-placement";
import { buildPlaceScene, disposePlace } from "../components/sketch/place-scene-renderer";

const building = newComponent("building", 10, 14);
const volume = { ...newComponent("volume", 28, 20), width: 4, depth: 8, height: 6, heading: 0.3 };
const result = acceptPlacePlan(emptyPlaceScene(), { objects: [building, volume] }, "build1");
const request = { id: "statue", prompt: "An ornate stone statue", role: "exterior", targets: [{ object_id: volume.id }] };
const plan = () => acceptMeshPlan([request], [building.id, volume.id], result.objects);
const assets = () => new Map([["statue", { id: "mesh1", size: { width: 2, height: 4, depth: 3 } }]]);
it("fits saved meshes proportionally within new volumes without moving identities or neighboring architecture", () => {
  const before = structuredClone(result), bound = bindPlannedMeshes(result, plan(), assets());
  expect(bound.objects[0]).toEqual(before.objects[0]); expect(result).toEqual(before);
  expect(bound.objects[1]).toMatchObject({ id: result.objects[1]!.id, entity_id: result.objects[1]!.entity_id, x: 28, z: 20, heading: 0.3,
    kind: "mesh", mesh_role: "exterior", mesh_scale: "uniform", width: 3, height: 6, depth: 4.5, asset_id: "mesh1" });
  expect(bound.objects[1]!.structure).toBeUndefined(); expect(parsePlaceScene(bound)).toEqual(bound);
});
it("reserves solid box geometry before generation and uses fitted dimensions for collision afterward", () => {
  const initial = buildPlaceScene(result), bound = buildPlaceScene(bindPlannedMeshes(result, plan(), assets()));
  try {
    expect(initial.solids).toContainEqual({ x: 28, y: 3, z: 20, w: 4, h: 6, d: 8, yaw: -0.3 });
    expect(bound.solids).toContainEqual({ x: 28, y: 3, z: 20, w: 3, h: 6, d: 4.5, yaw: -0.3 });
  } finally { disposePlace(initial.scene); disposePlace(bound.scene); }
});
it("keeps indoor generated props bound to their building and floor", () => {
  const shell = newComponent("building", 20, 20), prop = { ...newComponent("volume", 1.8, 1.5), width: 0.7, depth: 0.7, height: 0.8,
    placement: { building_id: shell.id, floor_id: shell.structure!.floors[0]!.id } };
  const accepted = acceptPlacePlan(emptyPlaceScene(), { objects: [shell, prop] }, "room1");
  const requests = acceptMeshPlan([{ ...request, role: "prop", targets: [{ object_id: prop.id }] }], [shell.id, prop.id], accepted.objects);
  const bound = bindPlannedMeshes(accepted, requests, assets()), object = bound.objects[1]!;
  expect(object.placement).toEqual(accepted.objects[1]!.placement); expect(object.mesh_role).toBe("prop");
  expect(resolveSceneObject(bound, object)).toMatchObject({ x: 21.8, z: 21.5, elevation: 0.015 });
  expect(() => acceptMeshPlan([{ ...request, targets: [{ object_id: prop.id }] }], [shell.id, prop.id], accepted.objects)).toThrow("exterior");
});
it("rejects replacing architecture, existing entities, duplicate targets and unsupported roles", () => {
  for (const object_id of [building.id, "existing", "missing"]) expect(() => acceptMeshPlan([{ ...request, targets: [{ object_id }] }], [building.id, volume.id], result.objects)).toThrow("new volumes");
  expect(() => acceptMeshPlan([request, { ...request, id: "duplicate" }], [building.id, volume.id], result.objects)).toThrow("distinct");
  expect(() => acceptMeshPlan([{ ...request, role: "enterable" }], [building.id, volume.id], result.objects)).toThrow("request");
  expect(() => acceptMeshPlan(Array(7).fill(request), [building.id, volume.id], result.objects)).toThrow("6");
  expect(acceptMeshPlan(undefined, [], [])).toEqual([]);
});
it("fails closed on missing assets, incompatible aspect ratios and changed target volumes", () => {
  expect(() => bindPlannedMeshes(result, plan(), new Map())).toThrow("not ready");
  expect(() => bindPlannedMeshes(result, plan(), new Map([["statue", { id: "mesh1", size: { width: 0.001, height: 10, depth: 3 } }]]))).toThrow("Invalid component");
  expect(() => bindPlannedMeshes({ ...result, objects: [result.objects[0]!] }, plan(), assets())).toThrow("missing");
  expect(() => parsePlaceScene({ ...result, objects: [{ ...result.objects[1], mesh_role: "exterior" }] })).toThrow("mesh role");
});
