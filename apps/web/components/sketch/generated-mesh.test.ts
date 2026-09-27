import {expect, it, vi} from "vitest";
import * as THREE from "three";
import {fitGeneratedMesh} from "./generated-mesh";
import {newComponent} from "@/lib/place-scene";
import {emptyPlaceScene} from "@/lib/place-scene";
import {buildPlaceScene, disposePlace} from "./place-scene-renderer";
import { loadPlacePhysics } from "@/lib/place-physics";
import { placeCollider } from "@/lib/place-colliders";
import { reorientMesh } from "@/lib/mesh-orientation";
// Match the browser entry, as in the building and floor collision tests.
vi.mock("@dimforge/rapier3d-compat", async () => {
  // @ts-expect-error The bundled browser entry uses the package-root declarations.
  const physicsModule = await import("@dimforge/rapier3d-compat/rapier.es.js");
  return { default: physicsModule.default };
});

it("normalizes arbitrary mesh origins into authored bounds without changing vertices", () => {
  const model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshStandardMaterial());
  mesh.position.set(8, 9, -4); model.add(mesh);
  const vertices = [...mesh.geometry.attributes.position!.array];
  const object = {...newComponent("mesh", 10, 10), width: 3, height: 7, depth: 5, asset_id: "mesh_test"};
  const fitted = fitGeneratedMesh(model, object), bounds = new THREE.Box3().setFromObject(fitted);
  expect(bounds.min.x).toBeCloseTo(-1.5); expect(bounds.max.x).toBeCloseTo(1.5);
  expect(bounds.min.z).toBeCloseTo(-2.5); expect(bounds.max.z).toBeCloseTo(2.5);
  expect(bounds.min.y).toBeCloseTo(0); expect(bounds.max.y).toBeCloseTo(7);
  expect(mesh.userData.objectId).toBe(object.id); expect(mesh.userData.generatedMesh).toBe(true);
  expect([...mesh.geometry.attributes.position!.array]).toEqual(vertices);
  mesh.geometry.dispose(); mesh.material.dispose();
});
it("rejects empty meshes instead of presenting a fake replacement", () => {
  expect(() => fitGeneratedMesh(new THREE.Group(), newComponent("mesh", 3, 3))).toThrow("invalid bounds");
});
it("renders locked proportions with exact plan bounds and refuses a distorted lock", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 3), new THREE.MeshStandardMaterial());
  const object = { ...newComponent("mesh", 5, 5), width: 1.5, height: 3, depth: 2.25, mesh_scale: "uniform" as const };
  try {
    const fitted = fitGeneratedMesh(mesh, object), bounds = new THREE.Box3().setFromObject(fitted, true);
    expect(bounds.getSize(new THREE.Vector3()).toArray()).toEqual([1.5, 3, 2.25]);
    expect(fitted.scale.toArray()).toEqual([0.75, 0.75, 0.75]);
    fitted.remove(mesh.parent!); mesh.removeFromParent();
    expect(() => fitGeneratedMesh(mesh, { ...object, width: 3 })).toThrow("proportions");
  } finally { mesh.geometry.dispose(); mesh.material.dispose(); }
});
it("retains the floor transform when a loaded mesh is fitted into its owning group", () => {
  const building = newComponent("building", 20, 20);
  building.height = 7.8; building.heading = Math.PI / 2;
  building.structure!.floors.push({id:"upper",label:"Upper floor"});
  const object = {...newComponent("mesh", 1, 0), width:1,depth:1,height:2,asset_id:"fixture",placement:{building_id:building.id,floor_id:"upper"}};
  const built = buildPlaceScene({...emptyPlaceScene(),objects:[building,object]});
  try {
    const group = built.scene.children.find(o=>o.userData.meshObjectId===object.id)!;
    const fixture = new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshStandardMaterial());
    group.add(fitGeneratedMesh(fixture,object));
    built.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.y).toBeCloseTo(3.2);expect(bounds.max.y).toBeCloseTo(5.2);
    expect(bounds.getCenter(new THREE.Vector3()).toArray()).toEqual([20,4.2,21]);
  } finally {disposePlace(built.scene);}
});
it.each([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 3, z: 2 }, { x: 2, y: 0, z: 3 }])("keeps source orientation %j, placement heading and actual Rapier contacts aligned", async orientation => {
  const object = reorientMesh({ ...newComponent("mesh", 10, 10), width: 1.5, height: 3, depth: 2.25, heading: Math.PI / 4, mesh_scale: "uniform" as const, asset_id: "fixture" }, orientation);
  const built = buildPlaceScene({ ...emptyPlaceScene(), objects: [object] }, { ground: false });
  const R = await loadPlacePhysics(), world = new R.World({ x: 0, y: 0, z: 0 });
  try {
    const solid = built.solids[0]!;
    expect(solid).toMatchObject({ w: object.width, h: object.height, d: object.depth, yaw: -Math.PI / 4 });
    world.createCollider(placeCollider(R, solid)); world.step();
    const parent = built.scene.children.find(o => o.userData.meshObjectId === object.id)!;
    parent.add(fitGeneratedMesh(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 3), new THREE.MeshStandardMaterial()), object));
    built.scene.updateMatrixWorld(true);
    for (const [x, z, dx, dz] of [[-object.width / 2 - 1, 0, 1, 0], [0, -object.depth / 2 - 1, 0, 1]]) {
      const origin = parent.localToWorld(new THREE.Vector3(x!, object.height / 2, z!));
      const direction = new THREE.Vector3(dx!, 0, dz!).transformDirection(parent.matrixWorld);
      const physics = world.castRay(new R.Ray(origin, direction), 3, true);
      const rendered = new THREE.Raycaster(origin, direction, 0, 3).intersectObject(parent, true)[0];
      expect(physics?.timeOfImpact).toBeCloseTo(1, 4);
      expect(rendered?.distance).toBeCloseTo(1, 4);
    }
  } finally { world.free(); disposePlace(built.scene); }
});
