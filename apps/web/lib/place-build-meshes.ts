import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { proportionalMeshDimensions, type MeshDimensions } from "./mesh-dimensions";
import { parsePlaceScene } from "./place-scene";

export interface PlannedMesh {
  id: string; prompt: string; role: "prop" | "exterior";
  targets: { object_id: string }[];
}
export function acceptMeshPlan(raw: unknown, originalIds: string[], generated: PlaceSceneObject[]): PlannedMesh[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 6) throw new Error("At most 6 mesh requests are allowed");
  const ids = new Set<string>(), targets = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== "object" || Object.keys(value).some(k => !["id", "prompt", "role", "targets"].includes(k))
      || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value.id) || ids.has(value.id)
      || typeof value.prompt !== "string" || value.prompt.trim().length < 3 || value.prompt.length > 1024
      || !["prop", "exterior"].includes(value.role) || !Array.isArray(value.targets) || !value.targets.length) throw new Error("Invalid mesh request");
    ids.add(value.id);
    return { id: value.id, prompt: value.prompt.trim(), role: value.role, targets: value.targets.map((t: Record<string, unknown>) => {
      const object = t && generated[originalIds.indexOf(String(t.object_id))];
      if (!t || typeof t !== "object" || Object.keys(t).some(k => k !== "object_id") || object?.kind !== "volume"
        || value.role === "exterior" && object.placement || targets.has(object.id) || targets.size >= 30) throw new Error("Meshes must target distinct new volumes; exterior meshes cannot occupy interiors");
      targets.add(object.id); return { object_id: object.id };
    }) };
  });
}

export function bindPlannedMeshes(definition: PlaceSceneDefinition, plan: PlannedMesh[], assets: Map<string, { id: string; size: MeshDimensions }>): PlaceSceneDefinition {
  const replacements = new Map<string, PlaceSceneObject>();
  for (const request of plan) {
    const asset = assets.get(request.id);
    if (!asset) throw new Error("A planned mesh is not ready");
    for (const target of request.targets) {
      const volume = definition.objects.find(o => o.id === target.object_id);
      if (volume?.kind !== "volume") throw new Error("Mesh envelope is missing or changed");
      replacements.set(volume.id, { ...volume, kind: "mesh", asset_id: asset.id, mesh_scale: "uniform", mesh_role: request.role,
        ...proportionalMeshDimensions(asset.size, volume), color: "#ffffff" });
    }
  }
  // Fitting only shrinks the reserved volume. Canonical validation still checks
  // minimum dimensions, floor placement, circulation and architectural openings.
  return parsePlaceScene({ ...definition, objects: definition.objects.map(o => replacements.get(o.id) ?? o) });
}
