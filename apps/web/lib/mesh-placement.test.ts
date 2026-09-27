import { expect, it } from "vitest";
import { duplicateMesh, replaceMeshAsset } from "./mesh-placement";
import { emptyPlaceScene, newComponent, parsePlaceScene, sceneChanges } from "./place-scene";
import { assertMeshProportions } from "./mesh-dimensions";
import { footprintsOverlap } from "./floor-placement";
function fixture() {
  const mesh = { ...newComponent("mesh", 12, 12), label: "Named landmark", asset_id: "old", width: 2, height: 3, depth: 4, heading: 0.5, mesh_scale: "stretch" as const, mesh_orientation: { x: 1, y: 0, z: 0 }, drawing_element_id: "outline" };
  const other = newComponent("tree", 30, 30), scene = { ...emptyPlaceScene(), objects: [mesh, other] };
  return { mesh, other, scene };
}
it("replaces only the asset and proportional envelope while retaining world identity, pose and annotations", () => {
  const { mesh, other, scene } = fixture(), before = structuredClone(scene), size = { width: 4, height: 2, depth: 3 };
  const result = replaceMeshAsset(scene, mesh.id, "next", size), next = result.objects[0]!;
  expect(next).toMatchObject({ id: mesh.id, entity_id: mesh.entity_id, label: mesh.label, x: 12, z: 12, heading: 0.5, drawing_element_id: "outline", mesh_scale: "uniform", asset_id: "next", width: 2, height: 1, depth: 1.5 });
  expect(next).not.toHaveProperty("mesh_orientation"); assertMeshProportions(size, next);
  expect(result.objects[1]).toEqual(other); expect(scene).toEqual(before); expect(sceneChanges(scene, result)).toContain("Replace Named landmark mesh asset");
});
it("rejects incompatible thin bounds and invalid assets without mutating the original scene", () => {
  const { scene, mesh, other } = fixture(), before = structuredClone(scene);
  expect(() => replaceMeshAsset(scene, mesh.id, "next", { width: 0.0001, height: 8, depth: 3 })).toThrow();
  expect(() => replaceMeshAsset(scene, mesh.id, "../other", { width: 4, height: 2, depth: 3 })).toThrow();
  expect(() => replaceMeshAsset(scene, other.id, "next", { width: 4, height: 2, depth: 3 })).toThrow("Select a mesh"); expect(scene).toEqual(before);
});
it("duplicates geometry/asset state with fresh IDs and a clear position, not shared drawing identity", () => {
  const { scene, mesh } = fixture(), before = structuredClone(scene), result = duplicateMesh(scene, mesh.id), copy = result.definition.objects.at(-1)!;
  expect(copy.id).not.toBe(mesh.id); expect(copy.entity_id).not.toBe(mesh.entity_id); expect(copy.id).toBe(result.id);
  expect(copy).toMatchObject({ asset_id: mesh.asset_id, width: mesh.width, height: mesh.height, depth: mesh.depth, heading: mesh.heading, mesh_scale: mesh.mesh_scale, mesh_orientation: mesh.mesh_orientation });
  expect(copy).not.toHaveProperty("drawing_element_id"); expect(footprintsOverlap(copy, mesh, 0.2)).toBe(false); expect(scene).toEqual(before);
});
it("duplicates floor furnishings on the same floor without blocking circulation", () => {
  const building = newComponent("building", 20, 20); building.height = 7.8; building.structure!.floors.push({ id: "upper", label: "Upper" });
  const mesh = { ...newComponent("mesh", 1, 0), width: 0.5, depth: 0.5, height: 0.8, asset_id: "furnishing", placement: { building_id: building.id, floor_id: "upper" } };
  const scene = parsePlaceScene({ ...emptyPlaceScene(), objects: [building, mesh] }), result = duplicateMesh(scene, mesh.id);
  expect(result.definition.objects.at(-1)!.placement).toEqual(mesh.placement); expect(() => parsePlaceScene(result.definition)).not.toThrow();
  const replacement = replaceMeshAsset(scene, mesh.id, "different", { width: 1, height: 1, depth: 1 }); expect(replacement.objects[1]!.placement).toEqual(mesh.placement);
});
it("fails a full scene without deleting or moving anything", () => {
  const mesh = { ...newComponent("mesh", 2, 1.5), asset_id: "full", width: 4, depth: 3, height: 2 };
  const scene = { ...emptyPlaceScene(), width: 4, depth: 4, entrance: { x: 2, z: 3.6, yaw: 0 }, objects: [mesh] }, before = structuredClone(scene);
  expect(() => duplicateMesh(scene, mesh.id)).toThrow("No clear footprint"); expect(scene).toEqual(before);
});
