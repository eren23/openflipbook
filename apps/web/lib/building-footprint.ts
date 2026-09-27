import type { BuildingOpening, BuildingSide, BuildingStructure, PlaceSceneObject } from "@openflipbook/config";
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";

export interface FootprintRect { x1: number; x2: number; z1: number; z2: number }
type Vertex = NonNullable<BuildingStructure["footprint"]>[number];
export const rectangleOutline = (): Vertex[] => [
  { id: "north", x: -0.5, z: -0.5 }, { id: "east", x: 0.5, z: -0.5 },
  { id: "south", x: 0.5, z: 0.5 }, { id: "west", x: -0.5, z: 0.5 },
];
export const footprintPoints = (o: PlaceSceneObject) => (o.structure?.footprint ?? rectangleOutline()).map(p => ({ ...p, x: p.x * o.width, z: p.z * o.depth }));
export const rectPolygon = (r: FootprintRect): Polygon => [[[r.x1, r.z1], [r.x2, r.z1], [r.x2, r.z2], [r.x1, r.z2], [r.x1, r.z1]]];
export const polygonArea = (p: MultiPolygon) => p.reduce((sum, polygon) => sum + polygon.reduce((area, ring, i) => {
  const signed = ring.reduce((a, v, j) => { const next = ring[(j + 1) % ring.length]!; return a + v[0] * next[1] - next[0] * v[1]; }, 0);
  return area + (i === 0 ? 1 : -1) * Math.abs(signed / 2);
}, 0), 0);

export function footprintWalls(o: PlaceSceneObject) {
  const points = footprintPoints(o);
  return points.map((p, i) => {
    const q = points[(i + 1) % points.length]!, horizontal = p.z === q.z;
    const side: BuildingSide = horizontal ? q.x > p.x ? "north" : "south" : q.z > p.z ? "east" : "west";
    return { id: p.id, side, horizontal, low: Math.min(horizontal ? p.x : p.z, horizontal ? q.x : q.z),
      high: Math.max(horizontal ? p.x : p.z, horizontal ? q.x : q.z), edge: horizontal ? p.z : p.x };
  });
}
export function openingWall(o: PlaceSceneObject, opening: BuildingOpening) {
  const walls = footprintWalls(o).filter(w => opening.wall_id ? w.id === opening.wall_id && w.side === opening.side : w.side === opening.side);
  if (walls.length !== 1) throw new Error("Select an identified exterior wall for this opening");
  return walls[0]!;
}
export function openingPoint(o: PlaceSceneObject, opening: BuildingOpening, inward = 0) {
  const wall = openingWall(o, opening), edge = wall.edge + inward * (wall.side === "north" || wall.side === "west" ? 1 : -1);
  return { x: wall.horizontal ? opening.offset : edge, z: wall.horizontal ? edge : opening.offset };
}

// Axis-aligned input is split at every vertex x-coordinate. Polygon clipping
// supplies the exact connected intervals, including concave recesses and holes.
export function polygonRects(polygon: MultiPolygon): FootprintRect[] {
  if (!polygon.length) return [];
  const points = polygon.flat(2), xs = [...new Set(points.map(p => p[0]))].sort((a, b) => a - b);
  const low = Math.min(...points.map(p => p[1])), high = Math.max(...points.map(p => p[1]));
  const result: FootprintRect[] = [];
  for (let i = 1; i < xs.length; i++) {
    const x1 = xs[i - 1]!, x2 = xs[i]!;
    if (x2 - x1 < 1e-8) continue;
    for (const part of polygonClipping.intersection(polygon, rectPolygon({ x1, x2, z1: low, z2: high }))) {
      const zs = part[0]!.map(p => p[1]);
      result.push({ x1, x2, z1: Math.min(...zs), z2: Math.max(...zs) });
    }
  }
  return result;
}
const cache = new Map<string, ReturnType<typeof deriveEnvelope>>();
function deriveEnvelope(o: PlaceSceneObject) {
  const outline: MultiPolygon = [[footprintPoints(o).map(p => [p.x, p.z])]];
  const t = o.structure!.wall_thickness;
  const walls = footprintWalls(o).map(w => {
    const a = w.edge, b = a + t * (w.side === "north" || w.side === "west" ? 1 : -1);
    const rect = w.horizontal ? { x1: w.low - t, x2: w.high + t, z1: Math.min(a, b), z2: Math.max(a, b) } : { x1: Math.min(a, b), x2: Math.max(a, b), z1: w.low - t, z2: w.high + t };
    return { ...w, rects: polygonRects(polygonClipping.intersection(outline, rectPolygon(rect))) };
  });
  const floor = polygonClipping.difference(outline, ...walls.flatMap(w => w.rects.map(rectPolygon)));
  return { outline, walls, floor, floorRects: polygonRects(floor), roofRects: polygonRects(outline) };
}
export function buildingEnvelope(o: PlaceSceneObject) {
  const key = JSON.stringify([o.width, o.depth, o.structure!.wall_thickness, o.structure!.footprint]);
  let value = cache.get(key);
  if (!value) {
    value = deriveEnvelope(o);
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
  }
  return value;
}
export function clipFloorRect(o: PlaceSceneObject, rect: FootprintRect, exclusions: FootprintRect[] = []) {
  if (rect.x2 <= rect.x1 || rect.z2 <= rect.z1) return [];
  const clipped = polygonClipping.intersection(buildingEnvelope(o).floor, rectPolygon(rect));
  return polygonRects(exclusions.length ? polygonClipping.difference(clipped, ...exclusions.map(rectPolygon)) : clipped);
}
export function floorContainsRect(o: PlaceSceneObject, rect: FootprintRect) {
  return rect.x2 > rect.x1 && rect.z2 > rect.z1 && polygonArea(polygonClipping.difference(rectPolygon(rect), buildingEnvelope(o).floor)) < 1e-8;
}
export function footprintContainsPoint(o: PlaceSceneObject, point: { x: number; z: number }, interior = false) {
  const e = buildingEnvelope(o), cells = interior ? e.floorRects : e.roofRects;
  return cells.some(r => point.x >= r.x1 && point.x <= r.x2 && point.z >= r.z1 && point.z <= r.z2);
}
export function outsideFloorRects(o: PlaceSceneObject, bounds: FootprintRect) {
  return polygonRects(polygonClipping.difference(rectPolygon(bounds), buildingEnvelope(o).floor));
}

export function parseBuildingFootprint(o: PlaceSceneObject, identity: (id: unknown) => void): Vertex[] | undefined {
  const ring = o.structure!.footprint;
  if (ring === undefined) return undefined;
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 24) throw new Error("Footprint needs 4 to 24 orthogonal corners");
  const clean = ring.map(p => {
    if (!p || ![p.x, p.z].every(v => typeof v === "number" && Number.isFinite(v) && v >= -0.5 && v <= 0.5)) throw new Error("Footprint corner is outside the building envelope");
    identity(p.id); return { id: p.id, x: p.x, z: p.z };
  });
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i]!, b = clean[(i + 1) % clean.length]!, c = clean[(i + 2) % clean.length]!;
    if ((a.x === b.x) === (a.z === b.z) || (a.x === b.x) === (b.x === c.x)) throw new Error("Footprint edges must turn at right angles");
    if (Math.abs(a.x - b.x) * o.width + Math.abs(a.z - b.z) * o.depth < 0.6) throw new Error("Footprint wall must be at least 0.6 m long");
    for (let j = i + 2; j < clean.length; j++) {
      if (i === 0 && j === clean.length - 1) continue;
      const c = clean[j]!, d = clean[(j + 1) % clean.length]!;
      if (Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) && Math.max(Math.min(a.z, b.z), Math.min(c.z, d.z)) <= Math.min(Math.max(a.z, b.z), Math.max(c.z, d.z))) throw new Error("Footprint cannot cross or touch itself");
    }
  }
  for (const axis of ["x", "z"] as const) if (Math.min(...clean.map(p => p[axis])) !== -0.5 || Math.max(...clean.map(p => p[axis])) !== 0.5) throw new Error("Footprint must retain the full building width and depth");
  const signed = clean.reduce((a, p, i) => { const q = clean[(i + 1) % clean.length]!; return a + p.x * q.z - q.x * p.z; }, 0);
  if (signed <= 0) throw new Error("Footprint corners must run clockwise in plan view");
  const floor = buildingEnvelope({ ...o, structure: { ...o.structure!, footprint: clean } }).floor;
  if (floor.length !== 1 || floor[0]!.length !== 1 || polygonArea(floor) < 4) throw new Error("Footprint must enclose one connected usable floor");
  return clean;
}
