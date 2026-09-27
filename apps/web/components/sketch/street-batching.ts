import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Merge only within one owner and material. Picking and roof edits retain identity.
export function batchStreetMeshes(scene: THREE.Scene) {
  const groups = new Map<string, THREE.Mesh[]>();
  scene.traverse(object => {
    if (object.userData.generatedMesh || object.userData.structuredBuilding) return;
    if (!(object instanceof THREE.Mesh) || !object.visible || !(object.material instanceof THREE.MeshStandardMaterial) || !object.parent) return;
    const material = object.material;
    const key = JSON.stringify([object.parent.uuid, object.userData.objectId, object.userData.surface, material.color.getHex(), material.map?.uuid, material.bumpMap?.uuid, material.roughness, material.metalness, object.castShadow, object.receiveShadow]);
    const group = groups.get(key) || []; group.push(object); groups.set(key, group);
  });
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0]!, parent = first.parent!;
    const geometries = group.map(mesh => {
      mesh.updateMatrix();
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      return geometry.applyMatrix4(mesh.matrix);
    });
    const geometry = mergeGeometries(geometries);
    geometries.forEach(geometry => geometry.dispose());
    if (!geometry) continue;
    const merged = new THREE.Mesh(geometry, first.material);
    merged.userData = { ...first.userData }; merged.castShadow = first.castShadow; merged.receiveShadow = first.receiveShadow;
    parent.add(merged);
    for (const mesh of group) { parent.remove(mesh); mesh.geometry.dispose(); if (mesh.material !== first.material) (mesh.material as THREE.Material).dispose(); }
    removed += group.length - 1;
  }
  return removed;
}
