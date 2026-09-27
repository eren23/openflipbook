import type { BuildingOpening, BuildingStructure, PlaceSceneObject } from "@openflipbook/config";
import { floorBounds, parseRoomLayout, roomDoorLinks, roomLayoutGeometry } from "./room-layout";
import { buildingEnvelope, clipFloorRect, floorContainsRect, openingPoint, openingWall, parseBuildingFootprint } from "./building-footprint";

export interface BuildingPart {
  x: number; y: number; z: number; w: number; h: number; d: number;
  surface: "wall" | "floor" | "stair" | "glass" | "ceiling";
  partition_id?: string;
  floor?: number;
}
const sides = ["north", "east", "south", "west"] as const;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const number = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
export const storeyHeight = (object: PlaceSceneObject) => (object.height - object.structure!.roof_height) / object.structure!.floors.length;

export function newBuildingStructure(): BuildingStructure {
  return {
    wall_thickness: 0.25, roof_height: 1.4,
    floors: [{id: crypto.randomUUID(), label: "Ground floor"}],
    door: {id: crypto.randomUUID(), side: "south", offset: 0, width: 1.4, height: 2.3, sill: 0, floor: 0},
    windows: [{id: crypto.randomUUID(), side: "north", offset: 0, width: 1.5, height: 1.2, sill: 1.1, floor: 0}],
  };
}

export function buildingStair(object: PlaceSceneObject) {
  const level = storeyHeight(object), thickness = object.structure!.wall_thickness;
  const steps = Math.ceil(level / 0.18), run = steps * 0.25;
  const saved = object.structure!.stair, direction = saved?.direction ?? "north";
  const x = saved?.x ?? -object.width / 2 + thickness + 0.8;
  const z = saved?.z ?? -object.depth / 2 + thickness + 0.8 + run / 2;
  const heading = { north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 }[direction];
  // Cardinal coefficients avoid floating-point cracks in slab subtraction.
  const [c, s] = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[direction] as [number, number];
  const point = (u: number, v: number) => ({ x: x + u * c - v * s, z: z + u * s + v * c });
  const bounds = (across = 0, along = 0) => {
    const w = Math.abs(c) * (0.6 + across) + Math.abs(s) * (run / 2 + along);
    const d = Math.abs(s) * (0.6 + across) + Math.abs(c) * (run / 2 + along);
    return { x1: x - w, x2: x + w, z1: z - d, z2: z + d };
  };
  return {steps, run, rise: level / steps, x, z, direction, heading, point, bounds, width: 1.2, level};
}

export function parseBuildingStructure(object: PlaceSceneObject): BuildingStructure {
  const s = object.structure;
  if (!s || !number(object.width, 4, 100) || !number(object.depth, 4, 100) || !number(s.wall_thickness, 0.15, 0.5) || !number(s.roof_height, 0.3, 4) || !Array.isArray(s.floors) || s.floors.length < 1 || s.floors.length > 2 || !Array.isArray(s.windows) || s.windows.length > 16) throw new Error("Invalid building structure");
  const ids = new Set<string>();
  const identity = (id: unknown) => {if (!safeId(id) || ids.has(id)) throw new Error("Invalid or duplicate architectural identity"); ids.add(id);};
  const footprint = parseBuildingFootprint(object, identity);
  const level = storeyHeight(object);
  if (!number(level, 2.6, 4.5)) throw new Error("Each storey must be 2.6 to 4.5 m high");
  const floors = s.floors.map(f => {
    if (!f || typeof f.label !== "string" || !f.label.trim() || f.label.length > 100) throw new Error("Invalid floor label");
    identity(f.id); return {id: f.id, label: f.label.trim(), ...(f.layout !== undefined ? { layout: parseRoomLayout(f.layout, floorBounds(object), s.wall_thickness, level, identity) } : {})};
  });
  let authoredStair: BuildingStructure["stair"];
  if (s.stair !== undefined) {
    if (!s.stair || !sides.includes(s.stair.direction) || !number(s.stair.x, -50, 50) || !number(s.stair.z, -50, 50) || floors.length !== 2) throw new Error("Invalid stair placement or floor count");
    identity(s.stair.id);
    authoredStair = { id: s.stair.id, x: s.stair.x, z: s.stair.z, direction: s.stair.direction };
  }
  const opening = (o: BuildingOpening, door: boolean): BuildingOpening => {
    if (!o || !sides.includes(o.side) || !Number.isInteger(o.floor) || !number(o.floor, 0, floors.length - 1)) throw new Error("Invalid opening wall or floor");
    identity(o.id);
    if (o.wall_id !== undefined && !safeId(o.wall_id)) throw new Error("Invalid opening wall identity");
    const wall = openingWall(object, o), span = wall.high - wall.low;
    if (!number(o.width, door ? 1 : 0.3, span - 2 * s.wall_thickness - 0.2) || !number(o.height, door ? 2.1 : 0.3, level - 0.2) || !number(o.sill, 0, level - o.height - 0.2) || !number(o.offset, wall.low + s.wall_thickness + 0.1 + o.width / 2, wall.high - s.wall_thickness - 0.1 - o.width / 2)) throw new Error("Opening extends outside the wall or lacks clearance");
    if (door && (o.floor !== 0 || o.sill !== 0)) throw new Error("Exterior doorway must meet the ground floor");
    return {id: o.id, side: o.side, ...(footprint ? { wall_id: wall.id } : {}), offset: o.offset, width: o.width, height: o.height, sill: o.sill, floor: o.floor};
  };
  const door = opening(s.door, true), windows = s.windows.map(w => opening(w, false)), openings = [door, ...windows];
  for (let i = 0; i < openings.length; i++) for (let j = i + 1; j < openings.length; j++) {
    const a = openings[i]!, b = openings[j]!;
    if (a.side === b.side && a.wall_id === b.wall_id && a.floor === b.floor && Math.abs(a.offset - b.offset) < (a.width + b.width) / 2 + 0.1 && a.sill < b.sill + b.height + 0.1 && b.sill < a.sill + a.height + 0.1) throw new Error("Architectural openings overlap");
  }
  if (floors.length === 2) {
    const stair = buildingStair(object);
    const clearance = stair.bounds(0.15, 0.8), inside = floorBounds(object);
    if (clearance.x1 < inside.x1 - 0.00001 || clearance.x2 > inside.x2 + 0.00001 || clearance.z1 < inside.z1 - 0.00001 || clearance.z2 > inside.z2 + 0.00001) throw new Error("Building is too shallow or stair placement lacks wall and landing clearance");
    if (footprint && !floorContainsRect(object, clearance)) throw new Error("Stairs and landings must fit inside the compound floor");
    const { x: dx, z: dz } = openingPoint(object, door);
    const blocked = stair.bounds(0.5, 0.5);
    if (dx > blocked.x1 && dx < blocked.x2 && dz > blocked.z1 && dz < blocked.z2) throw new Error("Doorway is blocked by the stair flight");
  }
  const structure = {wall_thickness: s.wall_thickness, roof_height: s.roof_height, ...(footprint ? { footprint } : {}), floors, door, windows, ...(authoredStair ? { stair: authoredStair } : {})};
  const clean = { ...object, structure };
  for (let floor = 0; floor < floors.length; floor++) {
    roomDoorLinks(clean, floor);
    for (const p of roomLayoutGeometry(clean, floor).partitions) {
      const n = p.node;
      for (const hole of [door, ...windows].filter(h => h.floor === floor)) {
        const boundary = openingPoint(clean, hole, s.wall_thickness);
        const joins = n.axis === "x" ? (hole.side === "north" || hole.side === "south") && boundary.z >= p.z1 - 0.0001 && boundary.z <= p.z2 + 0.0001 : (hole.side === "west" || hole.side === "east") && boundary.x >= p.x1 - 0.0001 && boundary.x <= p.x2 + 0.0001;
        if (joins && Math.abs(n.position - hole.offset) < (hole.width + s.wall_thickness) / 2 + 0.05) throw new Error("Partition intersects an exterior opening");
      }
    }
    if (floors.length < 2) continue;
    const stair = buildingStair(clean);
    for (const p of roomLayoutGeometry(clean, floor).partitions) {
      const n = p.node;
      // A partition cannot cross the stairwell, even with a ground-level door:
      // its lintel would collide with the rising capsule and the upper opening.
      const x1 = n.axis === "x" ? n.position - s.wall_thickness / 2 : p.x1;
      const x2 = n.axis === "x" ? n.position + s.wall_thickness / 2 : p.x2;
      const z1 = n.axis === "z" ? n.position - s.wall_thickness / 2 : p.z1;
      const z2 = n.axis === "z" ? n.position + s.wall_thickness / 2 : p.z2;
      const reserve = stair.bounds(0.05, 0.65);
      if (x1 < reserve.x2 && x2 > reserve.x1 && z1 < reserve.z2 && z2 > reserve.z1) throw new Error("Partition crosses the stairs or landing");
    }
  }
  return structure;
}

// Rendering, collision and entrance validation consume exactly these same parts.
export function buildingParts(object: PlaceSceneObject): BuildingPart[] {
  const s = object.structure!, parts: BuildingPart[] = [], level = storeyHeight(object), wallHeight = object.height - s.roof_height;
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, surface: BuildingPart["surface"]) => {
    if (w > 0.00001 && h > 0.00001 && d > 0.00001) parts.push({x, y, z, w, h, d, surface});
  };
  if (!s.footprint) for (const side of sides) {
    const horizontal = side === "north" || side === "south", span = horizontal ? object.width : object.depth;
    const holes = [s.door, ...s.windows].filter(o => o.side === side);
    const xs = [...new Set([-span / 2, span / 2, ...holes.flatMap(o => [o.offset - o.width / 2, o.offset + o.width / 2])])].sort((a,b)=>a-b);
    const ys = [...new Set([0, wallHeight, ...holes.flatMap(o => [o.floor * level + o.sill, o.floor * level + o.sill + o.height])])].sort((a,b)=>a-b);
    const add = (u: number, y: number, w: number, h: number, surface: BuildingPart["surface"], thickness = s.wall_thickness) => {
      const edge = ((horizontal ? object.depth : object.width) - s.wall_thickness) / 2 * (side === "north" || side === "west" ? -1 : 1);
      box(horizontal ? u : edge, y, horizontal ? edge : u, horizontal ? w : thickness, h, horizontal ? thickness : w, surface);
    };
    for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
      const x = (xs[i-1]! + xs[i]!) / 2, y = (ys[j-1]! + ys[j]!) / 2;
      if (holes.some(o => Math.abs(x - o.offset) < o.width / 2 && y > o.floor * level + o.sill && y < o.floor * level + o.sill + o.height)) continue;
      add(x, y, xs[i]! - xs[i-1]!, ys[j]! - ys[j-1]!, "wall");
    }
    for (const w of s.windows.filter(w => w.side === side)) add(w.offset, w.floor * level + w.sill + w.height / 2, w.width, w.height, "glass", 0.04);
  }
  if (s.footprint) for (const wall of buildingEnvelope(object).walls) for (const r of wall.rects) {
    const horizontal = wall.horizontal, low = horizontal ? r.x1 : r.z1, high = horizontal ? r.x2 : r.z2;
    const holes = [s.door, ...s.windows].filter(o => openingWall(object, o).id === wall.id);
    const xs = [...new Set([low, high, ...holes.flatMap(o => [o.offset - o.width / 2, o.offset + o.width / 2]).filter(x => x > low && x < high)])].sort((a, b) => a - b);
    const ys = [...new Set([0, wallHeight, ...holes.flatMap(o => [o.floor * level + o.sill, o.floor * level + o.sill + o.height])])].sort((a, b) => a - b);
    const add = (from: number, to: number, bottom: number, top: number, surface: BuildingPart["surface"]) => {
      const u = (from + to) / 2, edge = horizontal ? (r.z1 + r.z2) / 2 : (r.x1 + r.x2) / 2;
      const thickness = surface === "glass" ? 0.04 : horizontal ? r.z2 - r.z1 : r.x2 - r.x1;
      box(horizontal ? u : edge, (bottom + top) / 2, horizontal ? edge : u, horizontal ? to - from : thickness, top - bottom, horizontal ? thickness : to - from, surface);
    };
    for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
      const x = (xs[i - 1]! + xs[i]!) / 2, y = (ys[j - 1]! + ys[j]!) / 2;
      if (!holes.some(o => Math.abs(x - o.offset) < o.width / 2 && y > o.floor * level + o.sill && y < o.floor * level + o.sill + o.height)) add(xs[i - 1]!, xs[i]!, ys[j - 1]!, ys[j]!, "wall");
    }
    for (const w of holes.filter(o => o.id !== s.door.id)) {
      const from = Math.max(low, w.offset - w.width / 2), to = Math.min(high, w.offset + w.width / 2);
      if (to > from) add(from, to, w.floor * level + w.sill, w.floor * level + w.sill + w.height, "glass");
    }
  }
  const innerW = object.width/2-s.wall_thickness, innerD = object.depth/2-s.wall_thickness;
  for (let floor = 0; floor < s.floors.length; floor++) for (const p of roomLayoutGeometry(object, floor).partitions) {
    const n = p.node, low = n.axis === "x" ? p.z1 : p.x1, high = n.axis === "x" ? p.z2 : p.x2;
    const add = (from: number, to: number, bottom: number, top: number) => {
      if (to <= from || top <= bottom) return;
      parts.push({ x: n.axis === "x" ? n.position : (from + to) / 2, z: n.axis === "x" ? (from + to) / 2 : n.position,
        y: floor * level + (bottom + top) / 2, w: n.axis === "x" ? s.wall_thickness : to - from,
        d: n.axis === "x" ? to - from : s.wall_thickness, h: top - bottom, surface: "wall", partition_id: n.id, floor });
    };
    add(low, n.door.offset - n.door.width / 2, 0, level);
    add(n.door.offset + n.door.width / 2, high, 0, level);
    add(n.door.offset - n.door.width / 2, n.door.offset + n.door.width / 2, n.door.height, level);
  }
  box(0, -0.065, 0, innerW*2, 0.16, innerD*2, "floor");
  if (s.floors.length === 2) {
    const stair = buildingStair(object), hole = stair.bounds();
    const slab = (x1: number, x2: number, z1: number, z2: number) => box((x1+x2)/2, level - 0.08, (z1+z2)/2, x2-x1, 0.16, z2-z1, "floor");
    slab(-innerW, hole.x1, -innerD, innerD);
    slab(hole.x2, innerW, -innerD, innerD);
    slab(hole.x1, hole.x2, -innerD, hole.z1);
    slab(hole.x1, hole.x2, hole.z2, innerD);
    for (let i = 0; i < stair.steps; i++) {
      const p = stair.point(0, stair.run / 2 - (i + 0.5) * 0.25), horizontal = stair.direction === "east" || stair.direction === "west";
      box(p.x, (i+1)*stair.rise/2, p.z, horizontal ? 0.25 : stair.width, (i+1)*stair.rise, horizontal ? stair.width : 0.25, "stair");
    }
  }
  box(0, wallHeight - 0.06, 0, innerW*2, 0.12, innerD*2, "ceiling");
  if (!s.footprint) return parts;
  const hole = s.floors.length === 2 ? buildingStair(object).bounds() : null;
  // Clip slabs and partitions to the same envelope used by room membership.
  // Exterior walls and stair treads already have their authoritative shapes.
  return parts.flatMap(p => {
    if (!p.partition_id && p.surface !== "floor" && p.surface !== "ceiling") return [p];
    const bounds = { x1: p.x - p.w / 2, x2: p.x + p.w / 2, z1: p.z - p.d / 2, z2: p.z + p.d / 2 };
    return clipFloorRect(object, bounds, p.surface === "floor" && p.y > 0 && hole ? [hole] : []).map(r => ({ ...p, x: (r.x1 + r.x2) / 2, z: (r.z1 + r.z2) / 2, w: r.x2 - r.x1, d: r.z2 - r.z1 }));
  });
}

export function buildingBlocksPoint(object: PlaceSceneObject, point: {x: number; z: number}, radius = 0.3) {
  const dx = point.x-object.x, dz = point.z-object.z, c = Math.cos(object.heading), s = Math.sin(object.heading);
  const x = dx*c+dz*s, z = -dx*s+dz*c;
  return buildingParts(object).some(p => p.y+p.h/2 > 0.1 && p.y-p.h/2 < 1.8 && Math.abs(x-p.x) < p.w/2+radius && Math.abs(z-p.z) < p.d/2+radius);
}
