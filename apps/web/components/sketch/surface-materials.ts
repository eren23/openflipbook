import * as THREE from "three";
import type { PlaceSceneDefinition, BuildingSurface, SurfaceMaterial } from "@openflipbook/config";
import { materialAssetIds } from "@/lib/surface-material";

export function materialUVs(mesh: THREE.Mesh, binding: SurfaceMaterial) {
  const position = mesh.geometry.getAttribute("position"), normal = mesh.geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2), point = new THREE.Vector3(), n = new THREE.Vector3();
  mesh.updateMatrix(); const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrix);
  const c = Math.cos(binding.rotation), s = Math.sin(binding.rotation);
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
    n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z), top = ay >= ax && ay >= az;
    const u = (top || az >= ax ? point.x : point.z) / binding.tile_metres, v = (top ? point.z : point.y) / binding.tile_metres;
    uv[i * 2] = c * u - s * v; uv[i * 2 + 1] = s * u + c * v;
  }
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

export function bindSurfaceMaterials(scene: THREE.Scene, definition: PlaceSceneDefinition, textures: Map<string, THREE.Texture>) {
  const objects = new Map(definition.objects.map(object => [object.id, object]));
  const materials = new Map<string, THREE.MeshStandardMaterial>(), replaced = new Set<THREE.Material>();
  let count = 0;
  scene.traverse(mesh => {
    if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
    const ground = mesh.userData.groundSurface === true;
    const surface = (mesh.userData.structuredBuilding ? mesh.userData.surface : mesh.userData.materialSurface) as BuildingSurface;
    const object = objects.get(mesh.userData.objectId), binding = ground ? definition.ground_material : object?.materials?.[surface];
    if (!binding) return;
    const texture = textures.get(binding.asset_id); if (!texture) throw new Error("Saved surface material is missing");
    const key = ground ? "ground" : `${object!.id}:${surface}`;
    let material = materials.get(key);
    if (!material) {
      material = mesh.material.clone(); material.map = texture; material.color.set("#ffffff");
      material.bumpMap = null; material.normalMap = null; material.roughness = binding.roughness;
      material.metalness = 0; material.needsUpdate = true; materials.set(key, material);
    }
    replaced.add(mesh.material); mesh.material = material; materialUVs(mesh, binding); count++;
  });
  const retained = new Set<THREE.Material>();
  scene.traverse(mesh => { if (mesh instanceof THREE.Mesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) retained.add(material); });
  for (const material of replaced) if (!retained.has(material)) material.dispose();
  return count;
}

export async function loadSurfaceMaterials(scene: THREE.Scene, definition: PlaceSceneDefinition, base: string | undefined, signal: AbortSignal) {
  const ids = materialAssetIds(definition); if (!ids.length) return 0;
  if (!base) throw new Error("Material storage is unavailable");
  const textures = new Map<string, THREE.Texture>(), bitmaps: ImageBitmap[] = [];
  try {
    for (const id of ids) {
      const response = await fetch(`${base}/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Saved surface material could not be loaded");
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "flipY" }); bitmaps.push(bitmap);
      if (signal.aborted) return 0;
      const texture = new THREE.Texture(bitmap); texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 8; texture.needsUpdate = true;
      texture.addEventListener("dispose", () => bitmap.close()); textures.set(id, texture);
    }
    const count = bindSurfaceMaterials(scene, definition, textures);
    const used = new Set<THREE.Texture>();
    scene.traverse(mesh => { if (mesh instanceof THREE.Mesh && mesh.material instanceof THREE.MeshStandardMaterial && mesh.material.map) used.add(mesh.material.map); });
    for (const texture of textures.values()) if (!used.has(texture)) texture.dispose();
    return count;
  } catch (e) { for (const texture of textures.values()) texture.dispose(); for (const bitmap of bitmaps) bitmap.close(); throw e; }
  finally { if (signal.aborted) { for (const texture of textures.values()) texture.dispose(); for (const bitmap of bitmaps) bitmap.close(); } }
}
