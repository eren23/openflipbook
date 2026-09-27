import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { newComponent, parsePlaceScene } from "./place-scene";
import { findFloorPlacement, footprintsOverlap } from "./floor-placement";
import { proportionalMeshDimensions, type MeshDimensions } from "./mesh-dimensions";

export function replaceMeshAsset(scene: PlaceSceneDefinition, objectId: string, assetId: string, size: MeshDimensions) {
  const object = scene.objects.find(o => o.id === objectId);
  if (object?.kind !== "mesh" && !(object?.kind === "building" && object.asset_id)) throw new Error("Select a mesh to replace");
  const { mesh_orientation: _orientation, ...unchanged } = object;
  const next: PlaceSceneObject = { ...unchanged, asset_id: assetId, ...proportionalMeshDimensions(size, object), mesh_scale: "uniform" };
  // Source-axis correction belongs to the old file. Keep world heading and
  // position, fit the new file proportionally, and validate before draft mutation.
  return parsePlaceScene({ ...scene, objects: scene.objects.map(o => o.id === objectId ? next : o) });
}

export function duplicateMesh(scene: PlaceSceneDefinition, objectId: string) {
  const object = scene.objects.find(o => o.id === objectId);
  if (object?.kind !== "mesh" || scene.objects.length >= 100) throw new Error("Cannot duplicate this mesh");
  const identity = newComponent("mesh", object.x, object.z), { drawing_element_id: _drawing, ...original } = object;
  const copy = { ...original, id: identity.id, entity_id: identity.entity_id, label: `${object.label} copy`.slice(0, 100) };
  if (object.placement) {
    const placed = findFloorPlacement(scene, copy, object.placement);
    if (!placed) throw new Error("No clear space on this floor for a duplicate");
    return { definition: parsePlaceScene({ ...scene, objects: [...scene.objects, placed] }), id: copy.id };
  }
  const candidates = [{ x: object.x + object.width + 0.4, z: object.z }, { x: object.x, z: object.z + object.depth + 0.4 }];
  for (let z = 1; z < scene.depth; z++) for (let x = 1; x < scene.width; x++) candidates.push({ x, z });
  for (const point of candidates) {
    const placed = { ...copy, ...point };
    if (scene.objects.some(o => !o.placement && o.kind !== "path" && footprintsOverlap(placed, o, 0.2))) continue;
    try { return { definition: parsePlaceScene({ ...scene, objects: [...scene.objects, placed] }), id: copy.id }; }
    catch { /* Try a clear footprint within the same place. */ }
  }
  throw new Error("No clear footprint for a duplicate");
}
