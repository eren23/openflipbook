import type { PlaceComponent, PlaceSceneDefinition, PlaceSceneObject, PlaceSceneSnapshot, WorldEntityGeo } from "@openflipbook/config";
import { buildingBlocksPoint, newBuildingStructure, parseBuildingStructure } from "./building-structure";
import { footprintPoints } from "./building-footprint";
import { resolveSceneObject, validateFloorPlacements } from "./floor-placement";
import { roomAt, roomLayoutIds } from "./room-layout";
import { validateRoomCirculation } from "./room-circulation";
import { parseSurfaceMaterial, parseSurfaceMaterials } from "./surface-material";
import { parseMeshOrientation } from "./mesh-orientation";

export const COMPONENTS: PlaceComponent[] = ["building", "pond", "bench", "pergola", "path", "wall", "tree", "tavern", "house", "well", "barrels", "volume"];
export const COMPONENT_DEFAULTS: Record<PlaceComponent, { width: number; depth: number; height: number; color: string }> = {
  pond: { width: 5, depth: 4, height: 0.12, color: "#398e9f" },
  bench: { width: 2, depth: 0.7, height: 0.9, color: "#b56852" },
  pergola: { width: 4, depth: 3, height: 2.8, color: "#d4c9b5" },
  path: { width: 1.5, depth: 5, height: 0.03, color: "#c1c6c4" },
  wall: { width: 5, depth: 0.3, height: 1.1, color: "#8e999b" },
  tree: { width: 2, depth: 2, height: 3, color: "#4e8464" },
  tavern: { width: 10, depth: 5.4, height: 7, color: "#7a3b2e" },
  house: { width: 5, depth: 5, height: 6, color: "#647970" },
  well: { width: 1.3, depth: 1.3, height: 0.9, color: "#87948d" },
  barrels: { width: 1.4, depth: 1, height: 1.1, color: "#927552" },
  mesh: { width: 3, depth: 3, height: 3, color: "#ffffff" },
  volume: { width: 3, depth: 3, height: 3, color: "#9babad" },
  building: { width: 8, depth: 9, height: 4.6, color: "#c6c9bd" },
};

export function footprintComponent(kind: PlaceComponent, start: { x: number; z: number }, end: { x: number; z: number }, bounds: { width: number; depth: number }): PlaceSceneObject | null {
  if (![start.x, start.z, end.x, end.z, bounds.width, bounds.depth].every(Number.isFinite) || bounds.width <= 0 || bounds.depth <= 0) return null;
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  const x1 = clamp(start.x, bounds.width), x2 = clamp(end.x, bounds.width);
  const z1 = clamp(start.z, bounds.depth), z2 = clamp(end.z, bounds.depth);
  const width = Math.abs(x2 - x1), depth = Math.abs(z2 - z1);
  if (width < 0.25 || depth < 0.25) return null;
  return { ...newComponent(kind, (x1 + x2) / 2, (z1 + z2) / 2), width, depth };
}
const safeId = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(x);
const num = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
export function parsePlaceScene(input: unknown): PlaceSceneDefinition {
  const d = input as PlaceSceneDefinition;
  if (!d || ![1, 2].includes(d.version) || d.units !== "authored_metres" || typeof d.label !== "string" || !d.label.trim() || d.label.length > 160 || !num(d.width, 4, 100) || !num(d.depth, 4, 100) || !Array.isArray(d.objects) || d.objects.length > 100) throw new Error("Invalid place dimensions or objects");
  const ids = new Set<string>(), entityIds = new Set<string>(), architecturalIds = new Set<string>();
  if (d.material_pack !== undefined && d.material_pack !== "ankh-street-v1") throw new Error("Unknown material pack");
  const ground_material = d.ground_material === undefined ? undefined : parseSurfaceMaterial(d.ground_material);
  const objects = d.objects.map(o => {
    if (o?.placement !== undefined && (!o.placement || !safeId(o.placement.building_id) || !safeId(o.placement.floor_id))) throw new Error("Invalid floor placement");
    const mesh = o?.kind === "mesh" || o?.kind === "building" && o.asset_id !== undefined;
    if (mesh ? !safeId(o.asset_id) : o?.asset_id !== undefined) throw new Error("Invalid mesh asset binding");
    if (o?.mesh_scale !== undefined && (!mesh || !["uniform", "stretch"].includes(o.mesh_scale))) throw new Error("Invalid mesh scaling mode");
    if (o?.kind === "building" && o.asset_id && o.mesh_scale === undefined) throw new Error("Mesh shells require an explicit scaling mode");
    if (o?.mesh_orientation !== undefined && !mesh) throw new Error("Only meshes have source orientation");
    const mesh_orientation = parseMeshOrientation(o?.mesh_orientation);
    if (o?.mesh_role !== undefined && (o.kind !== "mesh" || !["prop", "exterior"].includes(o.mesh_role) || o.mesh_role === "exterior" && o.placement)) throw new Error("Invalid mesh role");
    if (!o || !safeId(o.id) || !safeId(o.entity_id) || ids.has(o.id) || entityIds.has(o.entity_id) || (!COMPONENTS.includes(o.kind) && o.kind !== "mesh") || typeof o.label !== "string" || !o.label.trim() || o.label.length > 100 || !num(o.x, o.placement ? -d.width : 0, d.width) || !num(o.z, o.placement ? -d.depth : 0, d.depth) || !num(o.width, 0.1, d.width) || !num(o.depth, 0.1, d.depth) || !num(o.height, 0.01, 20) || !num(o.heading, -Math.PI * 2, Math.PI * 2) || !/^#[0-9a-fA-F]{6}$/.test(o.color) || (o.drawing_element_id !== undefined && !safeId(o.drawing_element_id))) throw new Error("Invalid component");
    const c = Math.abs(Math.cos(o.heading)), s = Math.abs(Math.sin(o.heading));
    const hx = (o.width * c + o.depth * s) / 2, hz = (o.width * s + o.depth * c) / 2;
    if (!o.placement && (o.x - hx < -0.001 || o.x + hx > d.width + 0.001 || o.z - hz < -0.001 || o.z + hz > d.depth + 0.001)) throw new Error(`${o.label} extends outside the place`);
    ids.add(o.id); entityIds.add(o.entity_id);
    const building = o.kind === "tavern" || o.kind === "house";
    if (o.eave_height !== undefined && (!building || !num(o.eave_height, 0.1, o.height - 0.05))) throw new Error("Invalid eave height");
    if (o.roof_offset !== undefined && (!building || !num(o.roof_offset, -o.width * 0.45, o.width * 0.45))) throw new Error("Invalid roof offset");
    if (o.roof_material !== undefined && (!building || !["terracotta", "teal"].includes(o.roof_material))) throw new Error("Invalid roof material");
    if (o.kind === "building" && d.version !== 2) throw new Error("Structured buildings require scene version 2");
    if (o.kind !== "building" && o.structure !== undefined) throw new Error("Only structured buildings can contain architecture");
    const structure = o.kind === "building" ? parseBuildingStructure(o) : undefined;
    const materials = parseSurfaceMaterials(o);
    if (structure) for (const part of [...structure.floors, structure.door, ...structure.windows, ...(structure.stair ? [structure.stair] : []), ...(structure.footprint ?? [])]) {
      if (architecturalIds.has(part.id)) throw new Error("Architectural identity belongs to another building");
      architecturalIds.add(part.id);
    }
    if (structure) for (const floor of structure.floors) if (floor.layout) for (const id of roomLayoutIds(floor.layout)) {
      if (architecturalIds.has(id)) throw new Error("Architectural identity belongs to another building");
      architecturalIds.add(id);
    }
    return { id: o.id, entity_id: o.entity_id, kind: o.kind, label: o.label.trim(), x: o.x, z: o.z, width: o.width, depth: o.depth, height: o.height, heading: o.heading, color: o.color, ...(materials ? { materials } : {}), ...(o.placement ? { placement: { building_id: o.placement.building_id, floor_id: o.placement.floor_id } } : {}), ...(structure ? {structure} : {}), ...(o.asset_id ? { asset_id: o.asset_id } : {}), ...(o.mesh_scale ? { mesh_scale: o.mesh_scale } : {}), ...(mesh_orientation ? { mesh_orientation } : {}), ...(o.mesh_role ? { mesh_role: o.mesh_role } : {}), ...(o.drawing_element_id ? { drawing_element_id: o.drawing_element_id } : {}), ...(o.eave_height !== undefined ? { eave_height: o.eave_height } : {}), ...(o.roof_offset !== undefined ? { roof_offset: o.roof_offset } : {}), ...(o.roof_material !== undefined ? { roof_material: o.roof_material } : {}) };
  });
  const clean = { ...d, objects };
  validateFloorPlacements(clean);
  validateRoomCirculation(clean);
  if (!d.entrance || !num(d.entrance.x, 0.4, d.width - 0.4) || !num(d.entrance.z, 0.4, d.depth - 0.4) || !num(d.entrance.yaw, -Math.PI * 2, Math.PI * 2)) throw new Error("Invalid entrance");
  for (const o of objects.map(o => resolveSceneObject(clean, o)).filter(o => o.elevation < 1.8 && o.kind !== "path" && o.kind !== "pergola")) {
    if (o.kind === "building") {
      if (buildingBlocksPoint(o, d.entrance)) throw new Error("Entrance is blocked by building structure");
      continue;
    }
    const dx = d.entrance.x - o.x, dz = d.entrance.z - o.z, c = Math.cos(o.heading), s = Math.sin(o.heading);
    if (Math.abs(dx * c + dz * s) < o.width / 2 + 0.3 && Math.abs(-dx * s + dz * c) < o.depth / 2 + 0.3) throw new Error("Entrance is blocked by an object");
  }
  return { version: d.version, label: d.label.trim(), width: d.width, depth: d.depth, units: "authored_metres", objects, entrance: { ...d.entrance }, ...(d.material_pack ? { material_pack: d.material_pack } : {}), ...(ground_material ? { ground_material } : {}) };
}

export function newComponent(kind: PlaceComponent, x: number, z: number): PlaceSceneObject {
  return { id: `geo_${crypto.randomUUID()}`, entity_id: `entity_${crypto.randomUUID()}`, kind, label: kind[0]!.toUpperCase() + kind.slice(1), x, z, heading: 0, ...COMPONENT_DEFAULTS[kind], ...(kind === "building" ? {structure: newBuildingStructure()} : {}) };
}
export function gardenScene(): PlaceSceneDefinition {
  const object = (kind: PlaceComponent, x: number, z: number, patch: Partial<PlaceSceneObject> = {}) => ({ ...newComponent(kind, x, z), ...patch });
  return { version: 1, label: "Garden", width: 20, depth: 20, units: "authored_metres", entrance: { x: 10, z: 18.8, yaw: 0 }, objects: [
    object("pond", 5, 8), object("bench", 14, 15), object("pergola", 14, 5),
    object("path", 10, 13, { width: 1.5, depth: 12 }), object("path", 12, 7, { width: 5.5, depth: 1.5 }),
    object("wall", 10, 0.3, { width: 19.4 }), object("wall", 0.3, 10, { width: 19.4, heading: Math.PI / 2 }),
    object("wall", 19.7, 10, { width: 19.4, heading: Math.PI / 2 }),
    object("tree", 3, 15), object("tree", 17, 10),
  ] };
}

export function emptyPlaceScene(): PlaceSceneDefinition {
  return { version: 2, label: "New place", width: 40, depth: 40, units: "authored_metres",
    entrance: { x: 20, z: 38.8, yaw: 0 }, objects: [] };
}

export function sceneChanges(before: PlaceSceneDefinition | null, after: PlaceSceneDefinition): string[] {
  if (!before) return [`Create ${after.label}`, ...after.objects.map(o => `Add ${o.label}`)];
  const changes: string[] = [];
  if (before.version !== after.version) changes.push(`Upgrade scene format to version ${after.version}`);
  if (before.material_pack !== after.material_pack) changes.push("Update material pack");
  if (JSON.stringify(before.ground_material) !== JSON.stringify(after.ground_material)) changes.push("Update ground material");
  if (before.label !== after.label || before.width !== after.width || before.depth !== after.depth) changes.push("Update place dimensions or name");
  if (before.entrance.x !== after.entrance.x || before.entrance.z !== after.entrance.z || before.entrance.yaw !== after.entrance.yaw) changes.push("Move entrance");
  for (const o of after.objects) {
    const old = before.objects.find(p => p.id === o.id);
    if (!old) changes.push(`Add ${o.label}`);
    else if (JSON.stringify(Object.entries(old).sort(([a], [b]) => a.localeCompare(b))) !== JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))) {
      changes.push(`Update ${o.label}`);
      if (old.kind !== o.kind && o.asset_id) changes.push(o.kind === "building" ? `Add authored structural shell to ${o.label}` : `Remove ${o.label} structural shell`);
      if (old.asset_id !== o.asset_id) changes.push(`Replace ${o.label} mesh asset`);
      if (old.depth !== o.depth || old.width !== o.width) changes.push(`${o.label} footprint: ${old.width.toFixed(2)} x ${old.depth.toFixed(2)} m -> ${o.width.toFixed(2)} x ${o.depth.toFixed(2)} m`);
      if (old.roof_material !== o.roof_material) changes.push(`${o.label} roof: ${o.roof_material ?? "default"}`);
    }
  }
  for (const o of before.objects) if (!after.objects.some(p => p.id === o.id)) changes.push(`Remove ${o.label}`);
  return changes;
}

// Local scene metres occupy a nested map frame; the parent's map placement is never inferred from pixels.
export function sceneGeos(scene: PlaceSceneSnapshot, previous: WorldEntityGeo[]): WorldEntityGeo[] {
  const { definition: d } = scene;
  const existingParent = previous.find(e => e.id === scene.place_id);
  // A source-free root uses authored metres, not a fixed reference-image frame.
  // Resize its bounds without rescaling or moving existing local objects.
  const oldParent = existingParent && !scene.source_node_id && !existingParent.parent_id ? {
    ...existingParent, pos: { x: existingParent.pos.x - existingParent.footprint.w / 2 + d.width / 2, y: existingParent.pos.y - existingParent.footprint.d / 2 + d.depth / 2 },
    footprint: { w: d.width, d: d.depth },
  } : existingParent;
  const parent: WorldEntityGeo = oldParent ? { ...oldParent, scale: Math.min(oldParent.footprint.w / d.width, oldParent.footprint.d / d.depth), scene_id: scene.id, label: d.label, updated_at: scene.updated_at } : {
    id: scene.place_id, entity_id: `entity_${scene.place_id}`, kind: "place", label: d.label, pos: { x: d.width / 2, y: d.depth / 2 }, footprint: { w: d.width, d: d.depth }, height: 0, scale: 1, visual: `Authored ${d.label}`, state: {}, confidence: 1, source: "user", updated_at: scene.updated_at, scene_id: scene.id,
  };
  return [parent, ...d.objects.map(object => {
    const o = resolveSceneObject(d, object), building = d.objects.find(b => b.id === object.placement?.building_id);
    const room = building ? roomAt(building, building.structure!.floors.findIndex(f => f.id === object.placement!.floor_id), object) : undefined;
    // Map frames compose translation/scale, not heading. Project the rotated
    // local displacement; canonical placement remains in the scene definition.
    return {
    id: o.id, entity_id: o.entity_id, parent_id: building?.id ?? scene.place_id, kind: o.kind === "building" ? "place" as const : "item" as const, label: o.label,
    pos: { x: o.x - (building?.x ?? d.width / 2), y: o.z - (building?.z ?? d.depth / 2) }, footprint: { w: o.width, d: o.depth }, height: o.height,
    ...(o.structure?.footprint ? { border: footprintPoints(o).map(p => ({ x: o.x - d.width / 2 + p.x * Math.cos(o.heading) - p.z * Math.sin(o.heading), y: o.z - d.depth / 2 + p.x * Math.sin(o.heading) + p.z * Math.cos(o.heading) })) } : {}),
    ...(object.placement ? { elevation: o.elevation, floor_id: object.placement.floor_id } : {}),
    ...(room ? { room_id: room.id } : {}),
    heading: o.heading, visual: `${o.color} ${o.kind}${o.roof_material ? `, ${o.roof_material} roof` : ""}`, state: {}, confidence: 1, source: "user" as const,
    updated_at: scene.updated_at, scene_id: scene.id,
  }; })];
}
