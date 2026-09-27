import { expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_MESH_ORIENTATION, orientedMeshDimensions, parseMeshOrientation, reorientMesh } from "./mesh-orientation";
import { emptyPlaceScene, newComponent, parsePlaceScene, sceneChanges } from "./place-scene";
import { fitGeneratedMesh } from "../components/sketch/generated-mesh";
import { proportionalMeshDimensions } from "./mesh-dimensions";

const source = { width: 2, height: 4, depth: 3 };
it("matches actual Three vertex bounds for every supported source-axis combination", () => {
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
    const orientation = { x, y, z }, size = orientedMeshDimensions(source, orientation);
    const model = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 3), new THREE.MeshStandardMaterial());
    model.position.set(7, -5, 2);
    const vertices = [...model.geometry.attributes.position!.array];
    const object = { ...newComponent("mesh", 10, 10), ...size, asset_id: "fixture", mesh_scale: "uniform" as const, mesh_orientation: orientation };
    try {
      const fitted = fitGeneratedMesh(model, object), bounds = new THREE.Box3().setFromObject(fitted, true), measured = bounds.getSize(new THREE.Vector3());
      expect(measured.x).toBeCloseTo(size.width); expect(measured.y).toBeCloseTo(size.height); expect(measured.z).toBeCloseTo(size.depth);
      expect(fitted.scale.x).toBeCloseTo(1); expect(fitted.scale.y).toBeCloseTo(1); expect(fitted.scale.z).toBeCloseTo(1);
      expect(bounds.min.y).toBeCloseTo(0); expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0); expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0);
      expect([...model.geometry.attributes.position!.array]).toEqual(vertices);
      expect(model.position.toArray()).toEqual([7, -5, 2]);
      const vertex = new THREE.Vector3().fromBufferAttribute(model.geometry.attributes.position!, 0);
      const expected = vertex.clone().applyEuler(new THREE.Euler(x * Math.PI / 2, y * Math.PI / 2, z * Math.PI / 2, "XYZ")); expected.y += size.height / 2;
      expect(model.localToWorld(vertex).distanceTo(expected)).toBeLessThan(0.00001);
      expect(orientedMeshDimensions(size, orientation, true)).toEqual(source);
    } finally { model.geometry.dispose(); model.material.dispose(); }
  }
});
it("preserves physical scale, identity, placement and legacy stretch while changing source orientation", () => {
  const mesh = { ...newComponent("mesh", 1, 2), width: 3, height: 8, depth: 5, heading: 0.4, asset_id: "saved", placement: { building_id: "building", floor_id: "upper" } };
  const rotated = reorientMesh(mesh, { x: 1, y: 0, z: 0 });
  expect(rotated).toEqual({ ...mesh, width: 3, height: 5, depth: 8, mesh_orientation: { x: 1, y: 0, z: 0 } });
  const reset = reorientMesh(reorientMesh(rotated, { x: 3, y: 1, z: 2 }), DEFAULT_MESH_ORIENTATION);
  expect(reset).toEqual({ ...mesh, mesh_orientation: DEFAULT_MESH_ORIENTATION });
  expect(mesh).not.toHaveProperty("mesh_orientation");
  const restored = proportionalMeshDimensions(orientedMeshDimensions(source, rotated.mesh_orientation), rotated);
  expect(restored).toEqual({ width: 3, height: 4.5, depth: 6 });
});
it("round-trips orientation, records flips even when dimensions stay equal, and preserves old scenes", () => {
  const mesh = { ...newComponent("mesh", 8, 8), ...source, asset_id: "saved" }, before = { ...emptyPlaceScene(), objects: [mesh] };
  expect(parsePlaceScene(before).objects[0]).not.toHaveProperty("mesh_orientation");
  const flipped = { ...before, objects: [reorientMesh(mesh, { x: 2, y: 0, z: 0 })] };
  expect(parsePlaceScene(flipped)).toEqual(flipped);
  expect(sceneChanges(before, flipped)).toContain(`Update ${mesh.label}`);
  for (const raw of [null, {}, [], { x: 0, y: 0 }, { x: 0.5, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: "1", y: 0, z: 0 }, { x: 0, y: 0, z: 0, hidden: true }]) expect(() => parseMeshOrientation(raw)).toThrow("orientation");
  expect(() => parsePlaceScene({ ...before, objects: [{ ...newComponent("bench", 8, 8), mesh_orientation: DEFAULT_MESH_ORIENTATION }] })).toThrow("Only meshes");
});
it("rejects an orientation that no longer fits inside the owning floor", () => {
  const building = newComponent("building", 20, 20);
  const mesh = { ...newComponent("mesh", 3.2, 1.5), width: 0.3, height: 2.8, depth: 0.3, asset_id: "saved", placement: { building_id: building.id, floor_id: building.structure!.floors[0]!.id } };
  const definition = parsePlaceScene({ ...emptyPlaceScene(), objects: [building, mesh] });
  expect(() => parsePlaceScene({ ...definition, objects: [building, reorientMesh(mesh, { x: 0, y: 0, z: 1 })] })).toThrow();
  expect(definition.objects[1]).toEqual(mesh);
});
