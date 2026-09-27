import { expect, it } from "vitest";
import * as THREE from "three";
import { batchStreetMeshes } from "./street-batching";

it("batches repeated surfaces without merging owners or changing world bounds", () => {
  const scene = new THREE.Scene(), parent = new THREE.Group(); parent.position.set(10, 0, 8); scene.add(parent);
  for (const [x, id] of [[0, "drum"], [2, "drum"], [4, "neighbor"]] as const) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: "#123456" }));
    mesh.position.set(x, 1, 0); mesh.userData = { objectId: id, surface: "roof" }; parent.add(mesh);
  }
  const before = new THREE.Box3().setFromObject(scene);
  expect(batchStreetMeshes(scene)).toBe(1);
  expect(parent.children).toHaveLength(2);
  expect(new Set(parent.children.map(object => object.userData.objectId))).toEqual(new Set(["drum", "neighbor"]));
  expect(new THREE.Box3().setFromObject(scene)).toEqual(before);
});
