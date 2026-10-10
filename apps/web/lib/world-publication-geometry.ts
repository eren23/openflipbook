import type { PlaceConnection, PlaceSceneDefinition, PlaceSceneSnapshot } from "@openflipbook/config";
import { isSafeId } from "./ids";
import { parsePlaceScene, sceneGeos } from "./place-scene";
import { placeNetwork, validateConnections } from "./place-connections";

/** Public geometry contains placement numbers and identity, never private map metadata. */
export interface PublicationPlacement {
  place_id: string;
  entity_id: string;
  pos: { x: number; y: number };
  footprint: { w: number; d: number };
  scale: number;
  heading: number;
  elevation: number;
}
interface PublicationGeometryInput {
  scenes: { place_id: string; revision: number; definition: PlaceSceneDefinition }[];
  placements?: PublicationPlacement[];
  connections?: PlaceConnection[];
}
export function publicationConnection(c: PlaceConnection): PlaceConnection {
  return { id: c.id, version: c.version, kind: c.kind,
    a: { place_id: c.a.place_id, side: c.a.side, offset: c.a.offset },
    b: { place_id: c.b.place_id, side: c.b.side, offset: c.b.offset },
    width: c.width, created_at: c.created_at };
}

/** Rebuild the canonical graph using only a frozen publication, on either client or server. */
export function publicationGeometry(world: PublicationGeometryInput,
  options: { sessionId?: string; sceneIds?: Record<string, string>; updatedAt?: string } = {}) {
  if (!world.scenes.length || world.scenes.length > 16) throw new Error("Invalid published place selection");
  const updated_at = options.updatedAt ?? "1970-01-01T00:00:00.000Z";
  const scenes: PlaceSceneSnapshot[] = world.scenes.map((scene, i) => ({
    id: options.sceneIds?.[scene.place_id] ?? `publication_scene_${i}`,
    session_id: options.sessionId ?? "publication", place_id: scene.place_id, revision: scene.revision,
    definition: parsePlaceScene(scene.definition), source_node_id: null, source_image_key: null, updated_at,
  }));
  const places = new Set(scenes.map(scene => scene.place_id));
  if (places.size !== scenes.length || [...places].some(id => !isSafeId(id))
    || scenes.some(scene => !Number.isSafeInteger(scene.revision) || scene.revision < 1)) throw new Error("Invalid published place identity or revision");
  const placements = world.placements ?? [], frames = new Map(placements.map(p => [p.place_id, p]));
  if (frames.size !== placements.length || placements.some(p => !places.has(p.place_id))
    || world.placements && frames.size !== places.size) throw new Error("Invalid published place placements");
  const geos = scenes.flatMap(scene => {
    const rows = sceneGeos(scene, []), frame = frames.get(scene.place_id);
    if (frame) {
      if (!isSafeId(frame.entity_id) || ![frame.pos.x, frame.pos.y, frame.footprint.w, frame.footprint.d,
        frame.scale, frame.heading, frame.elevation].every(n => Number.isFinite(n) && Math.abs(n) <= 1_000_000)
        || frame.footprint.w <= 0 || frame.footprint.d <= 0 || frame.scale <= 0)
        throw new Error("Invalid published place transform");
      Object.assign(rows[0]!, { entity_id: frame.entity_id, pos: { ...frame.pos }, footprint: { ...frame.footprint },
        scale: frame.scale, heading: frame.heading, elevation: frame.elevation });
    }
    return rows;
  });
  // A shared map/entity identity cannot silently bind geometry from two places.
  if (new Set(geos.map(g => g.id)).size !== geos.length
    || new Set(geos.map(g => g.entity_id)).size !== geos.length) throw new Error("Published places share an object or entity identity");
  const connections = (world.connections ?? []).map(publicationConnection);
  if (connections.length > 256 || connections.some(c => !places.has(c.a.place_id) || !places.has(c.b.place_id)))
    throw new Error("Published connections reference an unselected place");
  validateConnections(connections, scenes, geos);
  // Validate each selected connected component's renderer/collision bounds.
  const checked = new Set<string>();
  for (const scene of scenes) if (!checked.has(scene.place_id)) {
    const network = placeNetwork(scene.place_id, scenes, geos, connections);
    for (const chunk of network?.chunks ?? []) checked.add(chunk.scene.place_id);
  }
  return { scenes, geos, connections };
}

export function publicationPlaceNetwork(world: PublicationGeometryInput, root: string) {
  const { scenes, geos, connections } = publicationGeometry(world);
  return placeNetwork(root, scenes, geos, connections);
}
