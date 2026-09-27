import type { PlaceSceneObject, BuildingSurface, SurfaceMaterial, PlaceSceneDefinition } from "@openflipbook/config";
export const BUILDING_SURFACES: BuildingSurface[] = ["wall", "floor", "roof", "ceiling", "stair"];
export interface MaterialAsset { id: string; prompt: string; model: string; sha256: string; image?: { width: number; height: number; channel: "base_color"; color_space: "srgb"; tiling: "unverified" } }
export function materialSurfaces(object: PlaceSceneObject): BuildingSurface[] {
  return object.kind === "building" && object.structure ? BUILDING_SURFACES : object.kind === "path" ? ["floor"] : [];
}
export function parseSurfaceMaterial(raw: unknown): SurfaceMaterial {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid surface material binding");
  const value = raw as SurfaceMaterial;
  if (typeof value.asset_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value.asset_id)
    || !Number.isFinite(value.tile_metres) || value.tile_metres < 0.1 || value.tile_metres > 20
    || !Number.isFinite(value.rotation) || Math.abs(value.rotation) > Math.PI * 2
    || !Number.isFinite(value.roughness) || value.roughness < 0 || value.roughness > 1) throw new Error("Invalid surface material binding");
  return { asset_id: value.asset_id, tile_metres: value.tile_metres, rotation: value.rotation, roughness: value.roughness };
}
export function parseSurfaceMaterials(object: PlaceSceneObject): PlaceSceneObject["materials"] {
  if (object.materials === undefined) return undefined;
  const surfaces = materialSurfaces(object);
  if (!surfaces.length || !object.materials || typeof object.materials !== "object" || Array.isArray(object.materials)) throw new Error("Material bindings require a structured building or path");
  const result: NonNullable<PlaceSceneObject["materials"]> = {};
  for (const [key, value] of Object.entries(object.materials)) {
    if (!surfaces.includes(key as BuildingSurface)) throw new Error("Invalid surface material binding");
    result[key as BuildingSurface] = parseSurfaceMaterial(value);
  }
  return Object.keys(result).length ? result : undefined;
}
export const materialAssetIds = (definition: PlaceSceneDefinition) => [...new Set([
  ...(definition.ground_material ? [definition.ground_material.asset_id] : []),
  ...definition.objects.flatMap(object => Object.values(object.materials ?? {}).map(binding => binding.asset_id)),
])];
