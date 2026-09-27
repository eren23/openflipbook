import type { PlaceSceneObject, RoomLayout } from "@openflipbook/config";
import polygonClipping from "polygon-clipping";
import { buildingEnvelope, footprintContainsPoint, polygonRects, rectPolygon } from "./building-footprint";

export interface RoomBounds { x1: number; x2: number; z1: number; z2: number }
export interface RoomRegion extends RoomBounds { id: string; label: string; cells?: RoomBounds[] }
export interface RoomPartition extends RoomBounds { node: Extract<RoomLayout, { type: "split" }> }
export const floorBounds = (object: PlaceSceneObject): RoomBounds => {
  const w = object.width / 2 - object.structure!.wall_thickness, d = object.depth / 2 - object.structure!.wall_thickness;
  return { x1: -w, x2: w, z1: -d, z2: d };
};
export function roomLayoutGeometry(object: PlaceSceneObject, floor: number) {
  const rooms: RoomRegion[] = [], partitions: RoomPartition[] = [], thickness = object.structure!.wall_thickness;
  const visit = (node: RoomLayout, bounds: RoomBounds, depth: number) => {
    if (depth > 6 || rooms.length + partitions.length >= 63) throw new Error("Room layout is too complex");
    if (node.type === "room") {
      if (object.structure!.footprint) {
        const area = polygonClipping.intersection(buildingEnvelope(object).floor, rectPolygon(bounds));
        if (area.length !== 1) throw new Error("Each room must occupy one connected area inside the footprint");
        rooms.push({ ...bounds, id: node.id, label: node.label, cells: polygonRects(area) });
      } else rooms.push({ ...bounds, id: node.id, label: node.label });
      return;
    }
    partitions.push({ ...bounds, node });
    const a = { ...bounds }, b = { ...bounds };
    if (node.axis === "x") { a.x2 = node.position - thickness / 2; b.x1 = node.position + thickness / 2; }
    else { a.z2 = node.position - thickness / 2; b.z1 = node.position + thickness / 2; }
    visit(node.a, a, depth + 1); visit(node.b, b, depth + 1);
  };
  const layout = object.structure!.floors[floor]?.layout;
  if (layout) visit(layout, floorBounds(object), 0);
  return { rooms, partitions };
}
export function roomAt(object: PlaceSceneObject, floor: number, point: { x: number; z: number }) {
  if (object.structure!.footprint && !footprintContainsPoint(object, point, true)) return undefined;
  return roomLayoutGeometry(object, floor).rooms.find(r => point.x > r.x1 && point.x < r.x2 && point.z > r.z1 && point.z < r.z2);
}

export function parseRoomLayout(value: unknown, bounds: RoomBounds, thickness: number, level: number, identity: (id: unknown) => void): RoomLayout {
  let count = 0;
  const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const parse = (value: unknown, area: RoomBounds, depth: number): RoomLayout => {
    if (++count > 63 || depth > 6) throw new Error("Room layout is too complex");
    const n = value as RoomLayout;
    if (!n || !["room", "split"].includes(n.type)) throw new Error("Invalid room layout");
    identity(n.id);
    if (area.x2 - area.x1 < 1.4 || area.z2 - area.z1 < 1.4) throw new Error("Rooms need at least 1.4 m clear width and depth");
    if (n.type === "room") {
      if (typeof n.label !== "string" || !n.label.trim() || n.label.length > 100) throw new Error("Invalid room name");
      return { type: "room", id: n.id, label: n.label.trim() };
    }
    if (!["x", "z"].includes(n.axis) || !number(n.position) || !n.door) throw new Error("Invalid partition");
    identity(n.door.id);
    const low = n.axis === "x" ? area.z1 : area.x1, high = n.axis === "x" ? area.z2 : area.x2;
    const door = n.door;
    if (!number(door.width) || door.width < 1 || !number(door.height) || door.height < 2.1 || door.height > level - 0.2 || !number(door.offset) || door.offset - door.width / 2 < low + 0.1 || door.offset + door.width / 2 > high - 0.1) throw new Error("Interior doorway lacks clearance");
    const a = { ...area }, b = { ...area };
    if (n.axis === "x") { a.x2 = n.position - thickness / 2; b.x1 = n.position + thickness / 2; }
    else { a.z2 = n.position - thickness / 2; b.z1 = n.position + thickness / 2; }
    return { type: "split", id: n.id, axis: n.axis, position: n.position, door: { id: door.id, offset: door.offset, width: door.width, height: door.height }, a: parse(n.a, a, depth + 1), b: parse(n.b, b, depth + 1) };
  };
  return parse(value, bounds, 0);
}

export function roomLayoutIds(layout: RoomLayout): string[] {
  return layout.type === "room" ? [layout.id] : [layout.id, layout.door.id, ...roomLayoutIds(layout.a), ...roomLayoutIds(layout.b)];
}
export function replaceRoomLayout(layout: RoomLayout, id: string, replacement: RoomLayout): RoomLayout {
  if (layout.id === id) return replacement;
  return layout.type === "room" ? layout : { ...layout, a: replaceRoomLayout(layout.a, id, replacement), b: replaceRoomLayout(layout.b, id, replacement) };
}

export function roomDoorLinks(object: PlaceSceneObject, floor: number) {
  const { partitions } = roomLayoutGeometry(object, floor), thickness = object.structure!.wall_thickness;
  return partitions.map(p => {
    const n = p.node, cross = thickness / 2 + 0.05;
    const point = (side: number, along: number) => n.axis === "x" ? { x: n.position + side * cross, z: along } : { x: along, z: n.position + side * cross };
    const a = roomAt(object, floor, point(-1, n.door.offset)), b = roomAt(object, floor, point(1, n.door.offset));
    if (!a || !b || a.id === b.id) throw new Error("Interior doorway must connect two rooms");
    for (const side of [-1, 1]) for (const edge of [-1, 1]) {
      const r = roomAt(object, floor, point(side, n.door.offset + edge * (n.door.width / 2 + 0.02)));
      if (r?.id !== (side < 0 ? a.id : b.id)) throw new Error("Another partition intersects an interior doorway");
    }
    return { id: n.door.id, a: a.id, b: b.id };
  });
}
