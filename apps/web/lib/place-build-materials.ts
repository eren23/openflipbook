import type { BuildingSurface, PlaceSceneDefinition, SurfaceMaterial } from "@openflipbook/config";
import type { MeshJob } from "./mesh-asset";
import { materialSurfaces } from "./surface-material";

export interface PlannedMaterial {
  id: string;
  prompt: string;
  targets: { object_id: string | null; surface: BuildingSurface; tile_metres: number; rotation: number; roughness: number }[];
}
export interface BuildMaterialStage {
  id: string;
  status: "generating" | "ready" | "blocked" | "cancelled";
  reservation: number;
  items: { plan_id: string; job: MeshJob }[];
}

// Resolve symbolic targets only after geometry acceptance remints object IDs.
// Existing objects cannot acquire planner-authored appearance changes.
export function acceptMaterialPlan(raw: unknown, originalIds: string[], generated: PlaceSceneDefinition["objects"], allowGround = false): PlannedMaterial[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 12) throw new Error("At most 12 material requests are allowed");
  const ids = new Set<string>(), surfaces = new Set<string>();
  let count = 0;
  return raw.map(value => {
    if (!value || typeof value !== "object" || Object.keys(value).some(k => !["id", "prompt", "targets"].includes(k))
      || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value.id) || ids.has(value.id)
      || typeof value.prompt !== "string" || value.prompt.trim().length < 3 || value.prompt.length > 1024
      || !Array.isArray(value.targets) || !value.targets.length) throw new Error("Invalid material request");
    ids.add(value.id);
    const targets = value.targets.map((t: Record<string, unknown>) => {
      const object = t && typeof t.object_id === "string" ? generated[originalIds.indexOf(t.object_id)] : undefined;
      const ground = t?.object_id === null && allowGround;
      if (!t || typeof t !== "object" || Object.keys(t).some(k => !["object_id", "surface", "tile_metres", "rotation", "roughness"].includes(k))
        || !(ground ? t.surface === "floor" : object && materialSurfaces(object).includes(t.surface as BuildingSurface))
        || typeof t.tile_metres !== "number" || !Number.isFinite(t.tile_metres) || t.tile_metres < 0.1 || t.tile_metres > 20
        || typeof t.rotation !== "number" || !Number.isFinite(t.rotation) || Math.abs(t.rotation) > 2 * Math.PI
        || typeof t.roughness !== "number" || !Number.isFinite(t.roughness) || t.roughness < 0 || t.roughness > 1) throw new Error("Invalid material target");
      const key = ground ? "ground" : `${object!.id}:${t.surface}`;
      if (surfaces.has(key) || ++count > 100) throw new Error("Duplicate or excessive material targets");
      surfaces.add(key);
      return { object_id: ground ? null : object!.id, surface: t.surface as BuildingSurface, tile_metres: t.tile_metres, rotation: t.rotation, roughness: t.roughness };
    });
    return { id: value.id, prompt: value.prompt.trim(), targets };
  });
}

export function bindPlannedMaterials(definition: PlaceSceneDefinition, plan: PlannedMaterial[], assets: Map<string, string>): PlaceSceneDefinition {
  const objects = definition.objects.map(o => ({ ...o, ...(o.materials ? { materials: { ...o.materials } } : {}) }));
  let ground_material = definition.ground_material;
  for (const material of plan) {
    const asset_id = assets.get(material.id);
    if (!asset_id) throw new Error("A planned material is not ready");
    for (const target of material.targets) {
      const binding: SurfaceMaterial = { asset_id, tile_metres: target.tile_metres, rotation: target.rotation, roughness: target.roughness };
      if (target.object_id === null) {
        if (target.surface !== "floor" || ground_material) throw new Error("Ground material target is no longer empty");
        ground_material = binding;
        continue;
      }
      const object = objects.find(o => o.id === target.object_id);
      if (!object || !materialSurfaces(object).includes(target.surface)) throw new Error("Material target is missing");
      object.materials = { ...object.materials, [target.surface]: binding };
    }
  }
  return { ...definition, objects, ...(ground_material ? { ground_material } : {}) };
}
