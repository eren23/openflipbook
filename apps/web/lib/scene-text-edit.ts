import { createHash } from "node:crypto";
import type { PlaceBuildConnectionInput, PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { parsePlaceScene } from "./place-scene";
import { acceptPlacePlan, validateOutdoorBuild } from "./place-build";
import { floorLocalPoint } from "./floor-placement";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a scene edit object");
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported scene edit fields"); };
const patchFields = ["x", "z", "width", "depth", "height", "heading", "color", "label", "eave_height", "roof_offset", "roof_material", "materials"];
const openingFields = ["side", "wall_id", "offset", "width", "height", "sill", "floor"];

/** Bounded typed operations; no scene replacement, identity changes or hidden asset generation. */
export function applySceneTextEdits(base: PlaceSceneDefinition, raw: unknown, jobId: string, selectedIds: string[], connections?: PlaceBuildConnectionInput) {
  const result = object(raw); keys(result, ["version", "edits"]);
  if (result.version !== 1 || !Array.isArray(result.edits) || result.edits.length < 1 || result.edits.length > 30) throw new Error("Use 1 to 30 versioned scene edits");
  const next = structuredClone(base), additions: PlaceSceneObject[] = [], touched = new Set<string>();
  const allowed = new Set(selectedIds.length ? [...selectedIds, ...base.objects.filter(o => o.placement && selectedIds.includes(o.placement.building_id)).map(o => o.id)] : base.objects.map(o => o.id));
  let structural = false;
  for (const rawEdit of result.edits) {
    const edit = object(rawEdit);
    if (edit.op === "add") {
      keys(edit, ["op", "object"]);
      const addition = object(edit.object) as unknown as PlaceSceneObject;
      if (selectedIds.length && (!addition.placement || !selectedIds.includes(addition.placement.building_id))) throw new Error("New scoped additions must furnish a selected building");
      additions.push(addition); structural = true; continue;
    }
    if (typeof edit.target !== "string" || !allowed.has(edit.target)) throw new Error("Edit a selected saved object in this place");
    const at = next.objects.findIndex(o => o.id === edit.target), target = next.objects[at];
    if (!target) throw new Error("Scene edit target is missing or already removed");
    touched.add(target.id);
    if (edit.op === "remove") { keys(edit, ["op", "target"]); next.objects.splice(at, 1); structural = true; }
    else if (edit.op === "move") {
      keys(edit, ["op", "target", "dx", "dz"]);
      if (![edit.dx, edit.dz].every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100)) throw new Error("Invalid authored-metre movement");
      const building = target.placement ? next.objects.find(o => o.id === target.placement!.building_id) : undefined;
      const delta = building ? floorLocalPoint({ ...building, x: 0, z: 0 }, { x: Number(edit.dx), z: Number(edit.dz) }) : { x: Number(edit.dx), z: Number(edit.dz) };
      target.x += delta.x; target.z += delta.z; structural = true;
    } else if (edit.op === "patch") {
      keys(edit, ["op", "target", "changes"]); const changes = object(edit.changes); keys(changes, patchFields);
      if (!Object.keys(changes).length) throw new Error("An edit needs changed fields");
      if (Object.keys(changes).some(k => !["color", "label", "roof_material", "materials"].includes(k))) structural = true;
      Object.assign(target, changes);
    } else if (edit.op === "roof") {
      keys(edit, ["op", "target", "roof_height"]);
      if (!target.structure || typeof edit.roof_height !== "number" || !Number.isFinite(edit.roof_height)) throw new Error("Edit a structured building roof");
      target.structure.roof_height = edit.roof_height; structural = true;
    } else if (edit.op === "door") {
      keys(edit, ["op", "target", "changes"]); const changes = object(edit.changes); keys(changes, openingFields);
      if (!target.structure || !Object.keys(changes).length) throw new Error("Edit a structured building's saved door");
      Object.assign(target.structure.door, changes); structural = true;
    } else throw new Error("Unsupported scene edit operation");
  }
  let accepted = parsePlaceScene(next);
  if (additions.length) {
    const namespace = `edit_${createHash("sha256").update(jobId).digest("hex").slice(0, 32)}`;
    accepted = acceptPlacePlan(accepted, { objects: additions }, namespace, connections);
    for (const o of accepted.objects.slice(next.objects.length)) touched.add(o.id);
  }
  if (structural) validateOutdoorBuild(accepted, accepted.objects.filter(o => touched.has(o.id) && !o.placement), connections);
  if (JSON.stringify(accepted) === JSON.stringify(base)) throw new Error("No world changes to apply");
  return { definition: accepted, object_ids: [...touched].sort() };
}
