import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { buildingParts, buildingStair, storeyHeight } from "./building-structure";
import { floorBounds, roomDoorLinks, roomLayoutGeometry, type RoomBounds } from "./room-layout";
import { buildingEnvelope, openingPoint, outsideFloorRects } from "./building-footprint";

const RADIUS = 0.34;
interface Point { x: number; z: number }
function objectBounds(o: PlaceSceneObject): RoomBounds {
  const c = Math.abs(Math.cos(o.heading)), s = Math.abs(Math.sin(o.heading));
  const x = (o.width * c + o.depth * s) / 2, z = (o.width * s + o.depth * c) / 2;
  return { x1: o.x - x, x2: o.x + x, z1: o.z - z, z2: o.z + z };
}

// Coordinate compression preserves narrow passages without a metre-sized grid.
// Inflated rectangles are conservative for rotated props; Rapier remains the
// runtime authority for movement. This planner does not simulate 3D physics.
export function reachableFloor(bounds: RoomBounds, obstacles: RoomBounds[], start: Point) {
  const area = { x1: bounds.x1 + RADIUS, x2: bounds.x2 - RADIUS, z1: bounds.z1 + RADIUS, z2: bounds.z2 - RADIUS };
  const blocks = obstacles.map(r => ({ x1: Math.max(area.x1, r.x1 - RADIUS), x2: Math.min(area.x2, r.x2 + RADIUS), z1: Math.max(area.z1, r.z1 - RADIUS), z2: Math.min(area.z2, r.z2 + RADIUS) })).filter(r => r.x2 > r.x1 && r.z2 > r.z1);
  const xs = [...new Set([area.x1, area.x2, ...blocks.flatMap(r => [r.x1, r.x2])])].sort((a, b) => a - b);
  const zs = [...new Set([area.z1, area.z2, ...blocks.flatMap(r => [r.z1, r.z2])])].sort((a, b) => a - b);
  const nx = xs.length - 1, nz = zs.length - 1, size = nx * nz;
  if (area.x2 <= area.x1 || area.z2 <= area.z1 || size > 400_000) throw new Error("Floor clearance is too small or too complex to validate");
  const cells = new Uint8Array(size), queue = new Uint32Array(size), xi = new Map(xs.map((x, i) => [x, i])), zi = new Map(zs.map((z, i) => [z, i]));
  for (const b of blocks) for (let z = zi.get(b.z1)!; z < zi.get(b.z2)!; z++) cells.fill(1, z * nx + xi.get(b.x1)!, z * nx + xi.get(b.x2)!);
  const interval = (axis: number[], value: number) => {
    if (value <= axis[0]! || value >= axis.at(-1)!) return -1;
    let lo = 0, hi = axis.length - 1;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (value < axis[mid]!) hi = mid; else lo = mid; }
    return lo;
  };
  const cellAt = (p: Point) => { const x = interval(xs, p.x), z = interval(zs, p.z); return x < 0 || z < 0 ? -1 : z * nx + x; };
  let head = 0, tail = 0;
  const first = cellAt(start);
  if (first >= 0 && !cells[first]) { cells[first] = 2; queue[tail++] = first; }
  const visit = (index: number) => { if (!cells[index]) { cells[index] = 2; queue[tail++] = index; } };
  while (head < tail) {
    const index = queue[head++]!, x = index % nx, z = Math.floor(index / nx);
    if (x > 0) visit(index - 1); if (x + 1 < nx) visit(index + 1);
    if (z > 0) visit(index - nx); if (z + 1 < nz) visit(index + nx);
  }
  return {
    point: (p: Point) => { const index = cellAt(p); return index >= 0 && cells[index] === 2; },
    region: (r: RoomBounds) => {
      for (let i = 0; i < tail; i++) { const index = queue[i]!, x = index % nx, z = Math.floor(index / nx), cx = (xs[x]! + xs[x + 1]!) / 2, cz = (zs[z]! + zs[z + 1]!) / 2;
        if (cx > r.x1 && cx < r.x2 && cz > r.z1 && cz < r.z2) return true;
      }
      return false;
    },
  };
}

export function validateRoomCirculation(definition: PlaceSceneDefinition) {
  for (const building of definition.objects) {
    if (building.kind !== "building" || !building.structure) continue;
    const s = building.structure, furnishings = definition.objects.filter(o => o.placement?.building_id === building.id);
    if (!s.footprint && !s.stair && !s.floors.some(f => f.layout) && !furnishings.length) continue;
    const level = storeyHeight(building), parts = buildingParts(building), bounds = floorBounds(building);
    for (let floor = 0; floor < s.floors.length; floor++) {
      const { rooms, partitions } = roomLayoutGeometry(building, floor), floorObjects = furnishings.filter(o => o.placement?.floor_id === s.floors[floor]!.id);
      const solids: RoomBounds[] = parts.filter(p => (p.surface === "wall" || p.surface === "glass") && p.y + p.h / 2 > floor * level + 0.05 && p.y - p.h / 2 < floor * level + 1.85).map(p => ({ x1: p.x - p.w / 2, x2: p.x + p.w / 2, z1: p.z - p.d / 2, z2: p.z + p.d / 2 }));
      solids.push(...floorObjects.map(objectBounds));
      if (s.footprint) solids.push(...outsideFloorRects(building, bounds));
      const door = s.door, inward = s.wall_thickness + 0.45;
      let start: Point = openingPoint(building, door, inward);
      const required: Point[] = [];
      if (s.floors.length > 1) {
        const stair = buildingStair(building);
        solids.push(stair.bounds());
        if (floor === 0) required.push(stair.point(0, stair.run / 2 + 0.45));
        else start = stair.point(0, -stair.run / 2 - 0.45);
      }
      for (const p of partitions) for (const side of [-1, 1]) {
        const n = p.node, cross = s.wall_thickness / 2 + 0.45;
        required.push(n.axis === "x" ? { x: n.position + side * cross, z: n.door.offset } : { x: n.door.offset, z: n.position + side * cross });
      }
      const reachable = reachableFloor(bounds, solids, start);
      if (!reachable.point(start) || required.some(p => !reachable.point(p)) || rooms.some(r => !(r.cells ?? [r]).some(cell => reachable.region(cell)))) throw new Error(`${s.floors[floor]!.label}: rooms, doors and stairs need a clear walking route`);
      if (s.footprint && !rooms.length && buildingEnvelope(building).floorRects.some(r => !reachable.region(r))) throw new Error("Every compound wing needs a clear walking route");
      for (const object of floorObjects) {
        const r = objectBounds(object), candidates = [{ x: r.x1 - 0.45, z: object.z }, { x: r.x2 + 0.45, z: object.z }, { x: object.x, z: r.z1 - 0.45 }, { x: object.x, z: r.z2 + 0.45 }];
        if (!candidates.some(p => reachable.point(p))) throw new Error(`${object.label} needs a reachable approach`);
      }
      // Validate the semantic adjacency as well as physical clearance.
      const links = roomDoorLinks(building, floor);
      if (rooms.length) {
        const seen = new Set([rooms[0]!.id]);
        for (let i = 0; i < rooms.length; i++) for (const link of links) if (seen.has(link.a) || seen.has(link.b)) { seen.add(link.a); seen.add(link.b); }
        if (seen.size !== rooms.length) throw new Error("Every room needs a connected doorway");
      }
    }
  }
}
