import type { PlaceConnection, PlaceNetwork, PlaceSceneObject } from "@openflipbook/config";
import { footprintPoints, openingPoint } from "./building-footprint";
import { networkView } from "./place-connections";
import type { WalkPose } from "./walk-position";

export interface MapPoint { x: number; z: number }
export interface MapObject {
  place_id: string; object: PlaceSceneObject; x: number; z: number;
  outline: MapPoint[]; door: MapPoint | null;
}
export interface MapPortal {
  connection: PlaceConnection; x: number; z: number;
  from: MapPoint; to: MapPoint;
}

/** The same metre frame as connected walking, including west/north additions. */
export function connectedWorldMap(network: PlaceNetwork, rootPlaceId: string) {
  if (!network.chunks.length || network.chunks.length > 16) throw new Error("World map requires 1 to 16 saved places");
  const ids = new Set<string>();
  for (const chunk of network.chunks) {
    const d = chunk.scene.definition;
    if (ids.has(chunk.scene.place_id) || ![chunk.x, chunk.z, d.width, d.depth].every(Number.isFinite) || d.width <= 0 || d.depth <= 0) throw new Error("World map has an invalid place frame");
    ids.add(chunk.scene.place_id);
  }
  const view = networkView(network, rootPlaceId);
  const objects: MapObject[] = view.chunks.flatMap(chunk => chunk.scene.definition.objects.filter(o => !o.placement).map(object => {
    const x = chunk.x + object.x, z = chunk.z + object.z;
    const transform = (point: MapPoint): MapPoint => ({ x: x + point.x * Math.cos(object.heading) - point.z * Math.sin(object.heading), z: z + point.x * Math.sin(object.heading) + point.z * Math.cos(object.heading) });
    return { place_id: chunk.scene.place_id, object, x, z, outline: footprintPoints(object).map(transform), door: object.structure ? transform(openingPoint(object, object.structure.door)) : null };
  }));
  const portalIds = new Set<string>();
  const portals: MapPortal[] = network.connections.map(connection => {
    if (portalIds.has(connection.id) || !Number.isFinite(connection.width) || connection.width < 1.2 || connection.width > 20) throw new Error("World map has an invalid opening");
    portalIds.add(connection.id);
    const points = [connection.a, connection.b].map(end => {
      const chunk = view.chunks.find(c => c.scene.place_id === end.place_id);
      if (!chunk || !["north", "east", "south", "west"].includes(end.side) || !Number.isFinite(end.offset)) throw new Error("World map opening references a missing boundary");
      const d = chunk.scene.definition, horizontal = end.side === "north" || end.side === "south";
      if (end.offset - connection.width / 2 < 0 || end.offset + connection.width / 2 > (horizontal ? d.width : d.depth)) throw new Error("World map opening exceeds its boundary");
      return { x: chunk.x + (end.side === "west" ? 0 : end.side === "east" ? d.width : end.offset), z: chunk.z + (end.side === "north" ? 0 : end.side === "south" ? d.depth : end.offset) };
    });
    if (Math.hypot(points[0]!.x - points[1]!.x, points[0]!.z - points[1]!.z) > 0.001) throw new Error("World map boundaries no longer align");
    const p = points[0]!, horizontal = connection.a.side === "north" || connection.a.side === "south";
    return { connection, ...p, from: { x: p.x - (horizontal ? connection.width / 2 : 0), z: p.z - (horizontal ? 0 : connection.width / 2) }, to: { x: p.x + (horizontal ? connection.width / 2 : 0), z: p.z + (horizontal ? 0 : connection.width / 2) } };
  });
  return { chunks: view.chunks, width: view.definition.width, depth: view.definition.depth, objects, portals, buildingCount: objects.filter(o => ["building", "house", "tavern"].includes(o.object.kind)).length };
}

export type ConnectedWorldMap = ReturnType<typeof connectedWorldMap>;

/** Only a current, place-local physical pose may become the map's walk marker. */
export function connectedMapWalkPoint(map: ConnectedWorldMap, pose: WalkPose | null): (MapPoint & { yaw: number; place_id: string; space: WalkPose["space"] }) | null {
  const chunk = pose && map.chunks.find(c => c.scene.place_id === pose.place_id);
  if (!pose || !chunk || chunk.scene.revision !== pose.scene_revision || ![pose.position.x, pose.position.z, pose.yaw].every(Number.isFinite)
    || pose.position.x < 0 || pose.position.x > chunk.scene.definition.width || pose.position.z < 0 || pose.position.z > chunk.scene.definition.depth) return null;
  return { x: chunk.x + pose.position.x, z: chunk.z + pose.position.z, yaw: pose.yaw, place_id: pose.place_id, space: pose.space ?? null };
}

/** A sequence of real boundary openings, not a collision-free indoor path. */
export function connectedMapRoute(map: ConnectedWorldMap, fromPlaceId: string, toPlaceId: string) {
  if (!map.chunks.some(c => c.scene.place_id === fromPlaceId) || !map.chunks.some(c => c.scene.place_id === toPlaceId)) return null;
  const queue = [{ place: fromPlaceId, places: [fromPlaceId], portals: [] as MapPortal[] }], seen = new Set([fromPlaceId]);
  for (let i = 0; i < queue.length; i++) {
    const step = queue[i]!;
    if (step.place === toPlaceId) return { places: step.places, portals: step.portals };
    for (const portal of map.portals) {
      const c = portal.connection, next = c.a.place_id === step.place ? c.b.place_id : c.b.place_id === step.place ? c.a.place_id : null;
      if (next && !seen.has(next)) { seen.add(next); queue.push({ place: next, places: [...step.places, next], portals: [...step.portals, portal] }); }
    }
  }
  return null;
}
