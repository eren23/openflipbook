import type { Entity, SceneView } from "@openflipbook/config";
import { finerTier } from "@openflipbook/config";

import { entityAtPoint } from "./entity-hit";

/**
 * Scene-level closeup (the descent ladder inside entered scenes). Geometry
 * inside perspective scenes is bearing-recovered, NOT image-registered — so
 * the only exact crop source is the codex's per-node `appearance_bboxes`.
 * A tap on a localized entity zooms it (Kontext `place_closeup`); the tap on
 * the entity whose closeup you're already on transitions (enter).
 */

const PAD = 1.6;
const MIN_FRAC = 0.18;
const DEGENERATE_FRAC = 0.85;

export type SceneCloseupSpec =
  | {
      kind: "closeup";
      name: string;
      regionBox: { x: number; y: number; w: number; h: number };
      sceneView: SceneView;
    }
  | { kind: "transition"; name: string };

export function sceneCloseupSpec(
  entities: Entity[],
  nodeId: string | null,
  click: { x_pct: number; y_pct: number },
  currentView: SceneView | null | undefined,
): SceneCloseupSpec | null {
  // Map frames have their own (geometry-registered) ladder.
  if (!currentView || currentView.level === "map") return null;
  const hit = entityAtPoint(entities, nodeId, click.x_pct, click.y_pct);
  if (!hit || !hit.entity.name.trim()) return null;
  // The seeding convention: a codex entity's geo id is geo_<entity_id>
  // (deriveGeoFromExtraction), so the closeup's focus links up once the
  // entity's geometry lands.
  const geoId = `geo_${hit.entity.id}`;
  if (currentView.closeup === true && currentView.focus_id === geoId) {
    return { kind: "transition", name: hit.entity.name };
  }
  const cx = hit.bbox.x_pct + hit.bbox.w_pct / 2;
  const cy = hit.bbox.y_pct + hit.bbox.h_pct / 2;
  const w = Math.min(Math.max(hit.bbox.w_pct * PAD, MIN_FRAC), 1);
  const h = Math.min(Math.max(hit.bbox.h_pct * PAD, MIN_FRAC), 1);
  if (w >= DEGENERATE_FRAC && h >= DEGENERATE_FRAC) {
    // Already fills the frame — a closeup would be a no-op; go in.
    return { kind: "transition", name: hit.entity.name };
  }
  return {
    kind: "closeup",
    name: hit.entity.name,
    regionBox: {
      x: Math.min(Math.max(cx - w / 2, 0), 1 - w),
      y: Math.min(Math.max(cy - h / 2, 0), 1 - h),
      w,
      h,
    },
    sceneView: {
      node_id: "", // the caller stamps the generating node's id
      level: currentView.level,
      observer: currentView.observer ?? null,
      map_crop: null,
      focus_id: geoId,
      closeup: true,
      ...(currentView.scale_tier
        ? { scale_tier: finerTier(currentView.scale_tier) }
        : {}),
    },
  };
}
