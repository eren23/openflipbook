import type { PlaceSceneObject } from "@openflipbook/config";

export type MeshDimensions = Pick<PlaceSceneObject, "width" | "height" | "depth">;
export const MESH_AXES = ["width", "height", "depth"] as const;

export function validateMeshDimensions(size: MeshDimensions) {
  if (!size || !MESH_AXES.every(axis => Number.isFinite(size[axis]) && size[axis] > 0.00001)) throw new Error("Generated mesh has invalid bounds");
  return size;
}

export function proportionalMeshDimensions(source: MeshDimensions, envelope: MeshDimensions): MeshDimensions {
  validateMeshDimensions(source); validateMeshDimensions(envelope);
  const scale = Math.min(...MESH_AXES.map(axis => envelope[axis] / source[axis]));
  return { width: source.width * scale, height: source.height * scale, depth: source.depth * scale };
}

export function assertMeshProportions(source: MeshDimensions, object: MeshDimensions) {
  validateMeshDimensions(source); validateMeshDimensions(object);
  const scales = MESH_AXES.map(axis => object[axis] / source[axis]);
  if (Math.max(...scales) / Math.min(...scales) > 1.00001) throw new Error("Mesh dimensions change its proportions. Restore proportions or explicitly enable stretching.");
}

export function resizeMesh(object: PlaceSceneObject, patch: Partial<PlaceSceneObject>): PlaceSceneObject {
  if ((object.kind !== "mesh" && !object.asset_id) || object.mesh_scale !== "uniform") return { ...object, ...patch };
  const changed = MESH_AXES.filter(axis => patch[axis] !== undefined && patch[axis] !== object[axis]);
  if (changed.length !== 1) return { ...object, ...patch };
  const axis = changed[0]!, scale = patch[axis]! / object[axis];
  const next = { ...object, ...patch, width: object.width * scale, height: object.height * scale, depth: object.depth * scale };
  validateMeshDimensions(next);
  return next;
}
