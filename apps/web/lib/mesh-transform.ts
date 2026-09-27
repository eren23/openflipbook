import * as THREE from "three";
import type { PlaceSceneObject } from "@openflipbook/config";
import { generatedMeshBounds } from "./mesh-geometry";
import { assertMeshProportions } from "./mesh-dimensions";
import { DEFAULT_MESH_ORIENTATION, parseMeshOrientation } from "./mesh-orientation";

// Shared by visible rendering and structural compatibility inspection.
export function fitGeneratedMesh(model: THREE.Object3D, object: PlaceSceneObject) {
  const orientation = parseMeshOrientation(object.mesh_orientation) ?? DEFAULT_MESH_ORIENTATION;
  const oriented = new THREE.Group();
  oriented.rotation.set(orientation.x * Math.PI / 2, orientation.y * Math.PI / 2, orientation.z * Math.PI / 2, "XYZ");
  oriented.add(model);
  const bounds = generatedMeshBounds(oriented), size = bounds.getSize(new THREE.Vector3());
  if (object.mesh_scale === "uniform") assertMeshProportions({ width: size.x, height: size.y, depth: size.z }, object);
  const pivot = new THREE.Group();
  pivot.scale.set(object.width / size.x, object.height / size.y, object.depth / size.z);
  const centered = new THREE.Group();
  centered.position.set(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
  centered.add(oriented); pivot.add(centered);
  model.traverse(child => {
    if (child instanceof THREE.Mesh) { child.userData.objectId = object.id; child.userData.generatedMesh = true; child.castShadow = true; child.receiveShadow = true; }
  });
  return pivot;
}
