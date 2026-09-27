import { expect, it } from "vitest";
import { acceptPlacePlan } from "./place-build";
import { acceptMaterialPlan, bindPlannedMaterials } from "./place-build-materials";
import { emptyPlaceScene, newComponent } from "./place-scene";

const object = newComponent("building", 20, 20);
const result = acceptPlacePlan(emptyPlaceScene(), { objects: [object] }, "build1");
const target = { object_id: object.id, surface: "wall", tile_metres: 2, rotation: 0, roughness: 0.8 };
const request = { id: "limestone", prompt: "Weathered grey limestone", targets: [target] };
it("binds planned paths and initial ground without inventing an object identity", () => {
  const path = newComponent("path", 20, 20), accepted = acceptPlacePlan(emptyPlaceScene(), { objects: [path] }, "buildpath");
  const raw = [{ ...request, targets: [{ ...target, object_id: path.id, surface: "floor" }, { ...target, object_id: null, surface: "floor" }] }];
  const plan = acceptMaterialPlan(raw, [path.id], accepted.objects, true);
  const bound = bindPlannedMaterials(accepted, plan, new Map([["limestone", "material1"]]));
  expect(bound.ground_material).toEqual(bound.objects[0]!.materials?.floor);
  expect(bound.objects[0]).toEqual({ ...accepted.objects[0], materials: { floor: bound.ground_material } });
  expect(accepted.ground_material).toBeUndefined();
  expect(() => acceptMaterialPlan(raw, [path.id], accepted.objects)).toThrow("target");
  expect(() => bindPlannedMaterials(bound, plan, new Map([["limestone", "replacement"]]))).toThrow("no longer empty");
});
it("rejects ambiguous ground targets, duplicate ground and wall textures on paths", () => {
  const path = newComponent("path", 20, 20), ground = { ...target, object_id: null, surface: "floor" };
  for (const t of [{ ...ground, object_id: "null" }, { ...ground, object_id: undefined }, { ...ground, surface: "roof" }, { ...target, object_id: path.id }]) {
    expect(() => acceptMaterialPlan([{ ...request, targets: [t] }], [path.id], [path], true)).toThrow("target");
  }
  expect(() => acceptMaterialPlan([{ ...request, targets: [ground, ground] }], [], [], true)).toThrow("Duplicate");
});
it("remaps material targets to accepted identities and binds appearance without altering geometry", () => {
  const plan = acceptMaterialPlan([request], [object.id], result.objects);
  expect(plan[0]!.targets[0]!.object_id).toBe(result.objects[0]!.id);
  const bound = bindPlannedMaterials(result, plan, new Map([["limestone", "material1"]]));
  const { materials, ...geometry } = bound.objects[0]!;
  expect(geometry).toEqual(result.objects[0]); expect(result.objects[0]!.materials).toBeUndefined();
  expect(materials?.wall).toMatchObject({ asset_id: "material1", tile_metres: 2 });
});
it("supports old layouts without optional material requests", () => {
  expect(acceptMaterialPlan(undefined, [object.id], result.objects)).toEqual([]);
  expect(acceptMaterialPlan([], [object.id], result.objects)).toEqual([]);
});
it("rejects existing, missing and non-architectural targets", () => {
  for (const id of ["existing", "missing"]) expect(() => acceptMaterialPlan([{ ...request, targets: [{ ...target, object_id: id }] }], [object.id], result.objects)).toThrow("target");
  expect(() => acceptMaterialPlan([request], [object.id], [newComponent("bench", 20, 20)])).toThrow("target");
});
it("rejects duplicate identities/surfaces, oversized batches and invalid bindings", () => {
  expect(() => acceptMaterialPlan([request, request], [object.id], result.objects)).toThrow("request");
  expect(() => acceptMaterialPlan([{ ...request, targets: [target, target] }], [object.id], result.objects)).toThrow("Duplicate");
  expect(() => acceptMaterialPlan(Array(13).fill(request), [object.id], result.objects)).toThrow("12");
  for (const patch of [{ tile_metres: 0 }, { roughness: NaN }, { rotation: Infinity }, { surface: "glass" }, { asset_id: "injected" }]) {
    expect(() => acceptMaterialPlan([{ ...request, targets: [{ ...target, ...patch }] }], [object.id], result.objects)).toThrow("target");
  }
  expect(() => bindPlannedMaterials(result, acceptMaterialPlan([request], [object.id], result.objects), new Map())).toThrow("not ready");
});
