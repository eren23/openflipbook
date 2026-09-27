import type { PlaceSceneObject } from "@openflipbook/config";
import { validateMeshDimensions, type MeshDimensions } from "./mesh-dimensions";

export type MeshOrientation = NonNullable<PlaceSceneObject["mesh_orientation"]>;
export const SOURCE_AXES = ["x", "y", "z"] as const;
export const DEFAULT_MESH_ORIENTATION: MeshOrientation = { x: 0, y: 0, z: 0 };

export function parseMeshOrientation(raw: unknown): MeshOrientation | undefined {
  if (raw === undefined) return undefined;
  const value = raw as MeshOrientation;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !SOURCE_AXES.includes(key as typeof SOURCE_AXES[number]))
    || !SOURCE_AXES.every(axis => Number.isInteger(value[axis]) && value[axis] >= 0 && value[axis] <= 3)) throw new Error("Invalid mesh orientation: use quarter-turns 0 to 3 on each source axis");
  return { x: value.x, y: value.y, z: value.z };
}

export function orientedMeshDimensions(size: MeshDimensions, orientation = DEFAULT_MESH_ORIENTATION, inverse = false): MeshDimensions {
  validateMeshDimensions(size); parseMeshOrientation(orientation);
  let { width, height, depth } = size;
  // Three's XYZ Euler applies Z, then Y, then X. Orthogonal rotations exactly
  // permute measured bounds; no vertex approximation or trigonometric drift.
  for (const axis of inverse ? SOURCE_AXES : [...SOURCE_AXES].reverse()) {
    if (orientation[axis] % 2 === 0) continue;
    if (axis === "x") [height, depth] = [depth, height];
    if (axis === "y") [width, depth] = [depth, width];
    if (axis === "z") [width, height] = [height, width];
  }
  return { width, height, depth };
}

export function reorientMesh(object: PlaceSceneObject, orientation: MeshOrientation): PlaceSceneObject {
  if (object.kind !== "mesh" && !(object.kind === "building" && object.asset_id)) throw new Error("Only meshes have source orientation");
  const parsed = parseMeshOrientation(orientation)!;
  const source = orientedMeshDimensions(object, object.mesh_orientation, true);
  return { ...object, ...orientedMeshDimensions(source, parsed), mesh_orientation: parsed };
}
