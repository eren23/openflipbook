import type { PlaceComponent, PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { buildingStair, storeyHeight } from "./building-structure";
import { roomAt, roomLayoutGeometry } from "./room-layout";
import { validateRoomCirculation } from "./room-circulation";
import { floorContainsRect, openingPoint } from "./building-footprint";

export type FloorPlacement = NonNullable<PlaceSceneObject["placement"]>;
export const FURNISHINGS: PlaceComponent[] = ["bench", "barrels", "mesh", "volume"];

export function placementFloor(definition: PlaceSceneDefinition, placement: FloorPlacement) {
  const building = definition.objects.find(o => o.id === placement.building_id && o.kind === "building");
  const index = building?.structure?.floors.findIndex(f => f.id === placement.floor_id) ?? -1;
  if (!building?.structure || index < 0) throw new Error("Move or remove furnishings before removing their building or floor");
  return { building, index, elevation: index === 0 ? 0.015 : index * storeyHeight(building) };
}

export function resolveSceneObject(definition: PlaceSceneDefinition, object: PlaceSceneObject): PlaceSceneObject & { elevation: number } {
  if (!object.placement) return { ...object, elevation: 0 };
  const { building, elevation } = placementFloor(definition, object.placement);
  const c = Math.cos(building.heading), s = Math.sin(building.heading);
  return { ...object, x: building.x + object.x * c - object.z * s, z: building.z + object.x * s + object.z * c,
    heading: object.heading + building.heading, elevation };
}

export function floorLocalPoint(building: PlaceSceneObject, point: { x: number; z: number }) {
  const x = point.x - building.x, z = point.z - building.z, c = Math.cos(building.heading), s = Math.sin(building.heading);
  return { x: x * c + z * s, z: -x * s + z * c };
}

export function bindObjectToFloor(definition: PlaceSceneDefinition, object: PlaceSceneObject, placement: FloorPlacement): PlaceSceneObject {
  const { building } = placementFloor(definition, placement);
  const heading = object.heading - building.heading;
  return { ...object, ...floorLocalPoint(building, object), heading: Math.atan2(Math.sin(heading), Math.cos(heading)), placement };
}

// Separating axes retain usable space around rotated furnishings, unlike AABBs.
export function footprintsOverlap(a: Pick<PlaceSceneObject, "x" | "z" | "width" | "depth" | "heading">, b: typeof a, clearance = 0) {
  for (const angle of [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2]) {
    const radius = (o: typeof a) => Math.abs(Math.cos(o.heading - angle)) * o.width / 2 + Math.abs(Math.sin(o.heading - angle)) * o.depth / 2;
    if (Math.abs((a.x - b.x) * Math.cos(angle) + (a.z - b.z) * Math.sin(angle)) >= radius(a) + radius(b) + clearance - 0.00001) return false;
  }
  return true;
}

export function validateFloorPlacements(definition: PlaceSceneDefinition, onlyId?: string) {
  for (const object of definition.objects) {
    if (!object.placement || onlyId && object.id !== onlyId) continue;
    if (definition.version !== 2 || !FURNISHINGS.includes(object.kind)) throw new Error("Only furnishings can be placed on a building floor in scene version 2");
    const { building, index, elevation } = placementFloor(definition, object.placement);
    const structure = building.structure!, level = storeyHeight(building);
    const hx = (Math.abs(Math.cos(object.heading)) * object.width + Math.abs(Math.sin(object.heading)) * object.depth) / 2;
    const hz = (Math.abs(Math.sin(object.heading)) * object.width + Math.abs(Math.cos(object.heading)) * object.depth) / 2;
    if (Math.abs(object.x) + hx > building.width / 2 - structure.wall_thickness - 0.02 || Math.abs(object.z) + hz > building.depth / 2 - structure.wall_thickness - 0.02) throw new Error(`${object.label} extends outside its floor`);
    if (structure.footprint && !floorContainsRect(building, { x1: object.x - hx - 0.02, x2: object.x + hx + 0.02, z1: object.z - hz - 0.02, z2: object.z + hz + 0.02 })) throw new Error(`${object.label} extends outside its compound floor`);
    if (structure.floors[index]!.layout) {
      const room = roomAt(building, index, object);
      if (!room || object.x - hx < room.x1 + 0.02 || object.x + hx > room.x2 - 0.02 || object.z - hz < room.z1 + 0.02 || object.z + hz > room.z2 - 0.02) throw new Error(`${object.label} intersects a room partition`);
      for (const p of roomLayoutGeometry(building, index).partitions) {
        const n = p.node, reserve = { x: n.axis === "x" ? n.position : n.door.offset, z: n.axis === "x" ? n.door.offset : n.position,
          width: n.axis === "x" ? structure.wall_thickness + 1.2 : n.door.width + 0.2, depth: n.axis === "x" ? n.door.width + 0.2 : structure.wall_thickness + 1.2, heading: 0 };
        if (footprintsOverlap(object, reserve)) throw new Error(`${object.label} blocks an interior doorway`);
      }
    }
    const ceiling = (index + 1) * level - (index < structure.floors.length - 1 ? 0.16 : 0.12);
    if (elevation + object.height > ceiling - 0.02) throw new Error(`${object.label} intersects the ceiling`);
    if (structure.floors.length > 1) {
      const stair = buildingStair(building);
      const reserve = { x: stair.x, z: stair.z, width: stair.width + 0.2, depth: stair.run + 1.6, heading: stair.heading };
      if (footprintsOverlap(object, reserve)) throw new Error(`${object.label} blocks the stairs or landing`);
    }
    if (index === 0) {
      const door = structure.door, horizontal = door.side === "north" || door.side === "south";
      const inward = structure.wall_thickness + 0.5;
      const reserve = { ...openingPoint(building, door, inward),
        width: horizontal ? door.width + 0.2 : 1, depth: horizontal ? 1 : door.width + 0.2, heading: 0 };
      if (footprintsOverlap(object, reserve)) throw new Error(`${object.label} blocks the doorway`);
    }
    for (const other of definition.objects) if (other.id !== object.id && other.placement?.floor_id === object.placement.floor_id && other.placement.building_id === object.placement.building_id && footprintsOverlap(object, other, 0.05)) throw new Error(`${object.label} overlaps ${other.label} on the same floor`);
  }
}

export function findFloorPlacement(definition: PlaceSceneDefinition, object: PlaceSceneObject, placement: FloorPlacement): PlaceSceneObject | null {
  if (!FURNISHINGS.includes(object.kind)) return null;
  const { building } = placementFloor(definition, placement);
  // Try the centre first, then a bounded grid. Never resize the asset to force a fit.
  const candidates = [{ x: 0, z: 0 }];
  for (let z = -building.depth / 2 + 0.5; z < building.depth / 2; z += 0.5) for (let x = -building.width / 2 + 0.5; x < building.width / 2; x += 0.5) candidates.push({ x, z });
  for (const point of candidates) {
    const next = { ...object, ...point, placement };
    try {
      const candidate = { ...definition, objects: [...definition.objects.filter(o => o.id !== object.id), next] };
      validateFloorPlacements(candidate, next.id); validateRoomCirculation(candidate); return next;
    }
    catch { /* Continue searching the same floor, without detaching to ground. */ }
  }
  return null;
}
