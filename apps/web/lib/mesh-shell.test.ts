import * as THREE from "three";
import { expect, it } from "vitest";
import { inspectMeshShell, meshShellFreeSpace, proposeMeshShell, removeMeshShell } from "./mesh-shell";
import { emptyPlaceScene, newComponent, parsePlaceScene } from "./place-scene";
import { fitGeneratedMesh } from "./mesh-transform";
import { fixtureShellModel } from "../e2e/fixtures/mesh-shell";
import { buildPlaceScene, disposePlace } from "../components/sketch/place-scene-renderer";
import { buildingStair, storeyHeight } from "./building-structure";

function building(floors = 1) {
  const object = { ...newComponent("building", 20, 20), asset_id: "architectural_mesh", mesh_scale: "uniform" as const };
  object.structure!.windows = [];
  if (floors === 2) { object.height = 7.8; object.structure!.floors.push({ id: "upper", label: "Upper" }); }
  return object;
}
it.each([1, 2])("accepts compatible real triangles with %i floors without changing mesh bytes or world placement", floors => {
  const object = building(floors), model = fixtureShellModel(object), before = model.children.map(n => (n as THREE.Mesh).geometry.getAttribute("position").array.slice());
  const fitted = fitGeneratedMesh(model, object); expect(inspectMeshShell(fitted, object).triangles).toBeGreaterThan(50);
  model.children.forEach((n, i) => expect((n as THREE.Mesh).geometry.getAttribute("position").array).toEqual(before[i]));
});
it("rejects a closed facade instead of hiding its geometry or declaring the box enterable", () => {
  const object = building(), fitted = fitGeneratedMesh(fixtureShellModel(object, true), object);
  expect(() => inspectMeshShell(fitted, object)).toThrow("Mesh blocks shell free space");
});
it("uses the same source-axis correction as rendering without mistaking world heading for source rotation", () => {
  const object = { ...building(), heading: 0.7, mesh_orientation: { x: 0, y: 3, z: 0 } }, model = fixtureShellModel(object);
  model.rotation.y = Math.PI / 2;
  expect(inspectMeshShell(fitGeneratedMesh(model, object), object).triangles).toBeGreaterThan(50);
  const wrong = { ...object, mesh_orientation: { x: 0, y: 2, z: 0 } };
  expect(() => inspectMeshShell(fitGeneratedMesh(fixtureShellModel(object), wrong), wrong)).toThrow("Mesh blocks shell free space");
});
it("covers compound recesses and window openings rather than treating the envelope as a hollow rectangle", () => {
  const object = building();
  object.structure!.footprint = [{ id: "n", x: -0.5, z: -0.5 }, { id: "e", x: 0.5, z: -0.5 }, { id: "rs", x: 0.5, z: 0 }, { id: "re", x: 0, z: 0 }, { id: "s", x: 0, z: 0.5 }, { id: "w", x: -0.5, z: 0.5 }];
  object.structure!.door = { ...object.structure!.door, wall_id: "s", offset: -2 };
  object.structure!.windows = [{ id: "window", side: "north", wall_id: "n", offset: 0, width: 1.5, height: 1.2, sill: 1.1, floor: 0 }];
  expect(inspectMeshShell(fitGeneratedMesh(fixtureShellModel(object), object), object).triangles).toBeGreaterThan(50);
  const blocked = fixtureShellModel(object), obstruction = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)); obstruction.position.set(2, 1, 2); blocked.add(obstruction);
  expect(() => inspectMeshShell(fitGeneratedMesh(blocked, object), object)).toThrow("Mesh blocks shell free space");
});
it("rejects a blocked upper-floor stair aperture, including a triangle exactly on a band boundary", () => {
  const object = building(2), model = fixtureShellModel(object), stair = buildingStair(object);
  const slab = new THREE.Mesh(new THREE.PlaneGeometry(stair.width, stair.run), new THREE.MeshBasicMaterial());
  slab.rotation.x = -Math.PI / 2; slab.position.set(stair.x, storeyHeight(object), stair.z); model.add(slab);
  expect(() => inspectMeshShell(fitGeneratedMesh(model, object), object)).toThrow("Mesh blocks shell free space");
});
it("rejects interior triangles, mismatched door locations and non-static geometry", () => {
  const object = building(), model = fixtureShellModel(object), obstacle = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)); obstacle.position.y = 1; model.add(obstacle);
  expect(() => inspectMeshShell(fitGeneratedMesh(model, object), object)).toThrow("Mesh blocks shell free space");
  const source = fixtureShellModel(object), different = structuredClone(object); different.structure!.door.side = "east";
  expect(() => inspectMeshShell(fitGeneratedMesh(source, different), different)).toThrow("Mesh blocks shell free space");
  const instanced = new THREE.Group(); instanced.add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 1));
  expect(() => inspectMeshShell(instanced, object)).toThrow("static, non-instanced");
});
it("proposes an explicit identity-preserving conversion and refuses to discard floor contents on removal", () => {
  const mesh = { ...newComponent("mesh", 20, 20), width: 8, depth: 9, height: 4.6, asset_id: "architectural_mesh", mesh_role: "exterior" as const, mesh_scale: "uniform" as const };
  const scene = { ...emptyPlaceScene(), objects: [mesh] }, before = structuredClone(scene), next = proposeMeshShell(scene, mesh.id), converted = next.objects[0]!;
  expect(converted).toMatchObject({ id: mesh.id, entity_id: mesh.entity_id, asset_id: mesh.asset_id, x: mesh.x, z: mesh.z, width: 8, depth: 9, height: 4.6, kind: "building" });
  expect(converted).not.toHaveProperty("mesh_role"); expect(scene).toEqual(before);
  expect(removeMeshShell(next, mesh.id).objects[0]).toEqual(mesh);
  const bench = { ...newComponent("bench", 2, 1), placement: { building_id: mesh.id, floor_id: converted.structure!.floors[0]!.id } };
  expect(() => removeMeshShell({ ...next, objects: [...next.objects, bench] }, mesh.id)).toThrow("floor contents");
  expect(() => proposeMeshShell({ ...scene, objects: [{ ...mesh, width: 2 }] }, mesh.id)).toThrow("Invalid building structure");
});
it("requires an explicit mesh scaling contract and preserves legacy scenes until conversion", () => {
  const object = building(), { mesh_scale: _scale, ...unspecified } = object;
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [unspecified] })).toThrow("explicit scaling mode");
  expect(() => parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...object, kind: "bench" }] })).toThrow("mesh asset binding");
  const mesh = { ...newComponent("mesh", 20, 20), width: 8, depth: 9, height: 4.6, asset_id: "legacy" };
  const scene = { ...emptyPlaceScene(), version: 1 as const, objects: [mesh] }, original = structuredClone(scene), converted = proposeMeshShell(scene, mesh.id);
  expect(scene).toEqual(original); expect(converted.version).toBe(2); expect(converted.objects[0]).toMatchObject({ mesh_scale: "stretch", width: 8, depth: 9, height: 4.6 });
});
it("uses the structural colliders, keeps the source mesh mount, and hides mesh only in explicit plan cutaway", () => {
  const object = building(), definition = parsePlaceScene({ ...emptyPlaceScene(), objects: [object] });
  const exterior = buildPlaceScene(definition), plan = buildPlaceScene(definition, { cutaway: true });
  expect(exterior.scene.children.find(n => n.userData.meshObjectId === object.id)?.userData.hideMesh).toBe(false);
  expect(plan.scene.children.find(n => n.userData.meshObjectId === object.id)?.userData.hideMesh).toBe(true);
  expect(exterior.solids.some(s => s.w === object.width && s.d === object.depth && s.h === object.height)).toBe(false);
  expect(meshShellFreeSpace(object).some(b => b.containsPoint(new THREE.Vector3(0, 1, object.depth / 2)))).toBe(true);
  disposePlace(exterior.scene); disposePlace(plan.scene);
});
