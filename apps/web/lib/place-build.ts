import type { PlaceBuildConnectionInput, PlaceBuildFloorTarget, PlaceSceneDefinition, PlaceSceneObject, RoomLayout } from "@openflipbook/config";
import { parsePlaceScene } from "./place-scene";
import { FURNISHINGS, footprintsOverlap, placementFloor } from "./floor-placement";
import { reachableFloor, validateRoomCirculation } from "./room-circulation";
import type { PlannedMaterial, BuildMaterialStage } from "./place-build-materials";
import type { PlannedMesh } from "./place-build-meshes";
import { buildingEnvelope, openingPoint } from "./building-footprint";
import { connectionApproach, OPPOSITE_SIDE } from "./place-connections";

export interface PlaceBuildJob {
  id: string;
  prompt: string;
  model: string;
  reservation: number;
  base_revision: number;
  status: "queued" | "scheduled" | "planning" | "validating" | "ready" | "invalid" | "submission_unknown" | "cancelled";
  created_at: string;
  error?: string;
  stale_connections?: boolean;
  target_floor?: PlaceBuildFloorTarget;
  object_count?: number;
  material_plan?: PlannedMaterial[];
  material_stage?: BuildMaterialStage;
  mesh_plan?: PlannedMesh[];
  mesh_stage?: BuildMaterialStage;
  appearance_approval?: { id: string; kinds: ("material" | "mesh")[]; total_reservation: number };
}

export function acceptPlacePlan(base: PlaceSceneDefinition, result: unknown, jobId: string, connectionInput?: PlaceBuildConnectionInput, targetFloor?: PlaceBuildFloorTarget): PlaceSceneDefinition {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobId)) throw new Error("Invalid build identity");
  const raw = result as { objects: PlaceSceneObject[] };
  if (!raw || Object.keys(raw).some(k => !["objects", "materials", "meshes"].includes(k)) || !Array.isArray(raw.objects) || !raw.objects.length) throw new Error("Planner must return additions only");
  if (raw.objects.some(o => !o || ["mesh", "house", "tavern"].includes(o.kind) || o.asset_id || o.drawing_element_id || o.materials)) throw new Error("Planner must use structured architecture and existing component types");
  if (targetFloor) {
    placementFloor(base, targetFloor);
    if (raw.objects.some(o => !FURNISHINGS.includes(o.kind) || o.placement?.building_id !== targetFloor.building_id || o.placement?.floor_id !== targetFloor.floor_id)) throw new Error("Every addition must furnish the selected saved floor");
  }
  const clean = parsePlaceScene({ ...base, version: 2, objects: [...base.objects, ...raw.objects] });
  const additions = clean.objects.slice(base.objects.length), ids = new Map<string, string>(), entityIds = new Map<string, string>();
  const identity = (id: string) => { if (ids.has(id)) throw new Error("Planner reused a symbolic identity"); ids.set(id, `gen_${jobId}_${ids.size}`); };
  const visit = (r: RoomLayout) => { identity(r.id); if (r.type === "split") { identity(r.door.id); visit(r.a); visit(r.b); } };
  for (const o of additions) {
    identity(o.id);
    // Entity references and architectural references are different namespaces.
    // A planner may use the same symbolic name for an object and its entity.
    if (entityIds.has(o.entity_id)) throw new Error("Planner reused an entity identity");
    entityIds.set(o.entity_id, `gen_${jobId}_entity_${entityIds.size}`);
    if (o.structure) {
      for (const f of o.structure.floors) { identity(f.id); if (f.layout) visit(f.layout); }
      identity(o.structure.door.id); for (const w of o.structure.windows) identity(w.id);
      if (o.structure.stair) identity(o.structure.stair.id);
      for (const wall of o.structure.footprint ?? []) identity(wall.id);
    }
  }
  const map = (id: string) => ids.get(id) ?? id;
  const room = (r: RoomLayout): RoomLayout => r.type === "room" ? { ...r, id: map(r.id) } : { ...r, id: map(r.id), door: { ...r.door, id: map(r.door.id) }, a: room(r.a), b: room(r.b) };
  const generated = additions.map(o => ({ ...o, id: map(o.id), entity_id: entityIds.get(o.entity_id)!,
    ...(o.placement ? { placement: { building_id: map(o.placement.building_id), floor_id: map(o.placement.floor_id) } } : {}),
    ...(o.structure ? { structure: { ...o.structure,
      floors: o.structure.floors.map(f => ({ ...f, id: map(f.id), ...(f.layout ? { layout: room(f.layout) } : {}) })),
      door: { ...o.structure.door, id: map(o.structure.door.id), ...(o.structure.door.wall_id ? { wall_id: map(o.structure.door.wall_id) } : {}) }, windows: o.structure.windows.map(w => ({ ...w, id: map(w.id), ...(w.wall_id ? { wall_id: map(w.wall_id) } : {}) })),
      ...(o.structure.footprint ? { footprint: o.structure.footprint.map(w => ({ ...w, id: map(w.id) })) } : {}),
      ...(o.structure.stair ? { stair: { ...o.structure.stair, id: map(o.structure.stair.id) } } : {}),
    } } : {}),
  }));
  const next = parsePlaceScene({ ...base, version: 2, objects: [...base.objects, ...generated] });
  // Scoped furnishings cannot change outdoor geometry. Validate their interior
  // clearance below without rejecting an unchanged, conservatively bounded exterior.
  if (!targetFloor) validateOutdoorBuild(next, generated, connectionInput);
  // Bare multi-floor shells need the same circulation test as partitioned ones.
  validateRoomCirculation({ ...next, objects: next.objects.map(o => o.structure ? { ...o, structure: { ...o.structure,
    floors: o.structure.floors.map(f => ({ ...f, layout: f.layout ?? { type: "room", id: `${f.id}_clearance`, label: f.label } })),
  } } : o) });
  return next;
}

export function validateOutdoorBuild(next: PlaceSceneDefinition, generated: PlaceSceneObject[], connectionInput?: PlaceBuildConnectionInput) {
  const ground = next.objects.filter(o => !o.placement && o.kind !== "path");
  const envelopes = (o: PlaceSceneObject) => o.structure?.footprint ? buildingEnvelope(o).roofRects.map(r => {
    const x = (r.x1 + r.x2) / 2, z = (r.z1 + r.z2) / 2;
    return { ...o, x: o.x + x * Math.cos(o.heading) - z * Math.sin(o.heading), z: o.z + x * Math.sin(o.heading) + z * Math.cos(o.heading), width: r.x2 - r.x1, depth: r.z2 - r.z1 };
  }) : [o];
  for (const o of generated.filter(o => !o.placement && o.kind !== "path")) for (const other of ground) {
    if (o.id !== other.id && envelopes(o).some(a => envelopes(other).some(b => footprintsOverlap(a, b, 0.3)))) throw new Error(`${o.label} overlaps or crowds ${other.label}`);
  }
  // Conservative outdoor envelope routing supplements the per-room clearance
  // checks. It does not claim an exact mesh navmesh or permit walking through walls.
  const obstacles = ground.flatMap(envelopes).map(o => {
    const c = Math.abs(Math.cos(o.heading)), s = Math.abs(Math.sin(o.heading));
    const hx = (o.width * c + o.depth * s) / 2, hz = (o.width * s + o.depth * c) / 2;
    return { x1: o.x - hx, x2: o.x + hx, z1: o.z - hz, z2: o.z + hz };
  });
  const reach = reachableFloor({ x1: 0, x2: next.width, z1: 0, z2: next.depth }, obstacles, next.entrance);
  if (!reach.point(next.entrance)) throw new Error("Layout planning requires a clear outdoor entrance");
  if (connectionInput) {
    if (connectionInput.version !== 1 || !Array.isArray(connectionInput.connections) || connectionInput.connections.length > 256) throw new Error("Invalid build connection input");
    const seen = new Set<string>();
    for (const link of connectionInput.connections) {
      if (link.kind !== "boundary" || link.version !== 1 || seen.has(link.id) || link.a.place_id === link.b.place_id || link.b.side !== OPPOSITE_SIDE[link.a.side]) throw new Error("Invalid build connection");
      seen.add(link.id);
      const end = [link.a, link.b].find(e => e.place_id === connectionInput.place_id);
      if (!end) throw new Error("Build connection belongs to another place");
      const approach = connectionApproach(next, end, link.width);
      if (!reach.point(approach)) throw new Error(`Connection ${link.id} needs a reachable approach from the saved entrance`);
    }
  }
  for (const o of next.objects.filter(o => o.kind === "building")) {
    const { x, z } = openingPoint(o, o.structure!.door, -0.6);
    const c = Math.cos(o.heading), s = Math.sin(o.heading);
    if (!reach.point({ x: o.x + x * c - z * s, z: o.z + x * s + z * c })) throw new Error(`${o.label} needs a reachable exterior doorway`);
  }
}
