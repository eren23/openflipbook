import { InstancedMesh, Mesh, SkinnedMesh, Vector3, type Object3D, type Scene } from "three";
import type { CameraCollisionSurface } from "@/lib/camera-path-check";

// Walking uses simplified solids. Camera flight also needs rendered surfaces,
// including roofs that have no walking collider and transformed mesh details.
export function cameraCollisionSurfaces(scene: Scene): CameraCollisionSurface[] {
  const surfaces: CameraCollisionSurface[] = [];
  let triangles = 0, vertexCount = 0;
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    for (let parent: Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    if (object instanceof InstancedMesh || object instanceof SkinnedMesh || object.morphTargetInfluences?.some(v => v !== 0)) throw new Error("Animated or instanced camera geometry is not supported");
    const positions = object.geometry.getAttribute("position"), index = object.geometry.getIndex();
    if (!positions) return;
    const count = index?.count ?? positions.count;
    triangles += count / 3; vertexCount += positions.count;
    if (count % 3 !== 0 || triangles > 500000 || vertexCount > 1500000) throw new Error("Scene geometry is too complex for camera validation");
    const vertices = new Float32Array(positions.count * 3), point = new Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
      if (!point.toArray().every(Number.isFinite)) throw new Error("Invalid camera collision geometry");
      point.toArray(vertices, i * 3);
    }
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const value = index ? index.getX(i) : i;
      if (!Number.isSafeInteger(value) || value < 0 || value >= positions.count) throw new Error("Invalid camera collision indices");
      indices[i] = value;
    }
    let objectId: string | null = null;
    for (let parent: Object3D | null = object; parent; parent = parent.parent) {
      const id = parent.userData.objectId ?? parent.userData.sceneObjectId;
      if (typeof id === "string") { objectId = id; break; }
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    surfaces.push({ vertices, indices, object_id: objectId, occludes: materials.some(material => material.visible && !material.transparent) });
  });
  return surfaces;
}
