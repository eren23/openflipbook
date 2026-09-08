import type { Entity, SceneView, TransitionContextV1, TransitionSeed, WorldEntityGeo } from "@openflipbook/config";

import { isSafeId } from "./ids";
import { validReferenceBox } from "./place-identity";

export function validTransitionPoint(value: unknown): value is TransitionContextV1["target_point"] {
  if (!value || typeof value !== "object") return false;
  const p = value as TransitionContextV1["target_point"];
  return [p.x_pct, p.y_pct].every(v => Number.isFinite(v) && v >= 0 && v <= 1);
}

/** Camera metadata stays informational. Invalid or oversized legacy views are unknown. */
export function snapshotView(value: unknown): SceneView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as SceneView;
  if (!['map', 'building', 'street', 'eye'].includes(v.level) || typeof v.node_id !== 'string') return null;
  const finite = (xs: unknown[]) => xs.every(x => typeof x === 'number' && Number.isFinite(x));
  if (v.observer != null && (!v.observer.pos || !finite([
    v.observer.pos.x, v.observer.pos.y, v.observer.eye_height,
    v.observer.gaze, v.observer.fov, v.observer.pitch ?? 0,
  ]) || v.observer.fov <= 0 || v.observer.fov >= Math.PI)) return null;
  if (v.map_crop != null && (!finite([v.map_crop.x, v.map_crop.y, v.map_crop.w, v.map_crop.h]) || v.map_crop.w <= 0 || v.map_crop.h <= 0)) return null;
  const json = JSON.stringify(v);
  return json.length <= 8192 ? JSON.parse(json) as SceneView : null;
}

export function captureTransition(
  source: { nodeId: string | null; sceneView?: SceneView | null },
  point: TransitionContextV1['target_point'],
  geoId: string | null = null,
  entities: Entity[] = [],
  geos: WorldEntityGeo[] = [],
): TransitionSeed | undefined {
  if (!source.nodeId || !validTransitionPoint(point)) return undefined;
  const entityId = geos.find(g => g.id === geoId)?.entity_id;
  const bbox = entities.find(e => e.id === entityId)?.appearance_bboxes[source.nodeId];
  return {
    version: 1, source_node_id: source.nodeId, target_point: { ...point },
    target_geo_id: geoId, target_bbox: validReferenceBox(bbox) ? { ...bbox } : null,
    target_provenance: 'tap', source_view: snapshotView(source.sceneView ? { ...source.sceneView, node_id: source.nodeId } : null),
  };
}

export function bindTransitionContext(
  seed: unknown,
  parent: { id: string; image_key: string; scene_view?: SceneView | null } | null,
  click: unknown,
  destination: SceneView | null | undefined,
  relation = 'descend',
): TransitionContextV1 | null {
  if (seed != null) {
    if (!parent || relation !== 'descend' || typeof seed !== 'object') throw new Error('Invalid transition source');
    const s = seed as TransitionSeed;
    const keys = ['version', 'source_node_id', 'target_point', 'target_geo_id', 'target_bbox', 'target_provenance', 'source_view'];
    if (Object.keys(s).some(k => !keys.includes(k)) || s.version !== 1 || s.source_node_id !== parent.id ||
        !validTransitionPoint(s.target_point) || (s.target_geo_id != null && !isSafeId(s.target_geo_id)) ||
        (s.target_bbox != null && !validReferenceBox(s.target_bbox)) ||
        !['tap', 'source_bbox'].includes(s.target_provenance) ||
        (s.source_view != null && (!snapshotView(s.source_view) || s.source_view.node_id !== parent.id))) {
      throw new Error('Invalid transition context');
    }
    if (s.target_provenance === 'tap' && (!validTransitionPoint(click) || click.x_pct !== s.target_point.x_pct || click.y_pct !== s.target_point.y_pct)) throw new Error('Transition tap mismatch');
    if (s.target_provenance === 'source_bbox' && (!s.target_bbox ||
        Math.abs(s.target_point.x_pct - s.target_bbox.x_pct - s.target_bbox.w_pct / 2) > 1e-8 ||
        Math.abs(s.target_point.y_pct - s.target_bbox.y_pct - s.target_bbox.h_pct / 2) > 1e-8)) throw new Error('Transition box mismatch');
    return {
      ...structuredClone(s), source_image_key: parent.image_key,
      source_view: snapshotView(s.source_view), destination_view: snapshotView(destination),
    };
  }
  if (!parent || relation !== 'descend' || !validTransitionPoint(click)) return null;
  return {
    version: 1, source_node_id: parent.id, source_image_key: parent.image_key,
    target_point: { ...click }, target_geo_id: destination?.focus_id ?? null,
    target_bbox: null, target_provenance: 'tap',
    source_view: snapshotView(parent.scene_view), destination_view: snapshotView(destination),
  };
}

export function remapTransition(context: TransitionContextV1 | null | undefined, ids: Map<string, string>): TransitionContextV1 | null {
  if (!context || !ids.has(context.source_node_id)) return null;
  const view = (v: SceneView | null) => v ? { ...v, node_id: ids.get(v.node_id) ?? v.node_id } : null;
  return { ...context, source_node_id: ids.get(context.source_node_id)!, source_view: view(context.source_view), destination_view: view(context.destination_view) };
}
