import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { validateMeshGlb } from "./mesh-asset";
import { validateMeshDimensions } from "./mesh-dimensions";

export function generatedMeshBounds(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  // Precise bounds read vertices, not untrusted accessor min/max declarations.
  const bounds = new THREE.Box3().setFromObject(model, true);
  const size = bounds.getSize(new THREE.Vector3());
  validateMeshDimensions({ width: size.x, height: size.y, depth: size.z });
  return bounds;
}

export async function withMeshGeometry<T>(bytes: Uint8Array, inspect: (scene: THREE.Group) => T): Promise<T> {
  validateMeshGlb(bytes);
  const loader = new GLTFLoader();
  // Geometry inspection runs in Node too. Materials are irrelevant to bounds;
  // skip texture decoding without implementing a second glTF geometry parser.
  loader.register(() => ({ name: "OFB_geometry_inspection", loadMaterial: async () => new THREE.MeshBasicMaterial() }));
  const gltf = await loader.parseAsync(new Uint8Array(bytes).buffer, "");
  try {
    return inspect(gltf.scene);
  } finally {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    for (const scene of gltf.scenes) scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}

export async function measureMeshGlb(bytes: Uint8Array) {
  return withMeshGeometry(bytes, scene => {
    const size = generatedMeshBounds(scene).getSize(new THREE.Vector3());
    return { width: size.x, height: size.y, depth: size.z };
  });
}
