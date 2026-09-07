import type { Entity, SceneView, WorldEntityGeo } from "@openflipbook/config";
import { MAP_IMAGE_FRAME } from "./geo-tap";
import { toAbsoluteEntities } from "./world-geometry";

/** Image-local detections outrank projected footprints; containment ambiguity
 * is resolved only for ancestors, never by guessing between adjacent places. */
export function placeCandidates(
  geos: WorldEntityGeo[], entities: Entity[], nodeId: string,
  view: SceneView | null | undefined, point: { x_pct: number; y_pct: number },
): WorldEntityGeo[] {
  const inside = view && view.level !== "map" ? view.focus_id : null;
  const frame = !inside && view?.map_crop ? view.map_crop : MAP_IMAGE_FRAME;
  const display = inside ? geos.filter(e => e.parent_id === inside) : toAbsoluteEntities(geos, geos);
  const registry = new Map(entities.map(e => [e.id, e]));
  const hits = display.filter(e => {
    if (e.kind !== "place") return false;
    const b = e.entity_id ? registry.get(e.entity_id)?.appearance_bboxes[nodeId] : null;
    if (b) return point.x_pct >= b.x_pct && point.x_pct <= b.x_pct + b.w_pct && point.y_pct >= b.y_pct && point.y_pct <= b.y_pct + b.h_pct;
    if (inside) return false; // World coordinates are not image pixels in a perspective view.
    const x = frame.x + point.x_pct * frame.w;
    const y = frame.y + point.y_pct * frame.h;
    return Math.abs(x - e.pos.x) <= e.footprint.w / 2 && Math.abs(y - e.pos.y) <= e.footprint.d / 2;
  });
  const byId = new Map(geos.map(e => [e.id, e]));
  const ancestors = new Set<string>();
  for (const hit of hits) {
    let parent = hit.parent_id;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      ancestors.add(parent); visited.add(parent); parent = byId.get(parent)?.parent_id;
    }
  }
  return hits.filter(e => !ancestors.has(e.id)).map(e => byId.get(e.id)!);
}
