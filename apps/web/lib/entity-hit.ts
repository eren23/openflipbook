import type { Entity, EntityBBox } from "@openflipbook/config";

import type { EditRegionBox } from "./edit-mask";

/** What the right-click landed on: a codex entity localized on THIS page. */
export interface EntityHit {
  entity: Entity;
  bbox: EntityBBox;
}

/**
 * Hit-test a normalized image point against the entities localized on the
 * given node (their per-node `appearance_bboxes`). Plain bbox containment;
 * when boxes overlap the SMALLEST one wins — right-clicking the lighthouse
 * shouldn't select the whole harbor it sits in. Works without world mode:
 * the bboxes come from extraction, not the geo map.
 */
export function entityAtPoint(
  entities: Entity[],
  nodeId: string | null,
  xPct: number,
  yPct: number
): EntityHit | null {
  if (!nodeId) return null;
  let best: EntityHit | null = null;
  let bestArea = Infinity;
  for (const entity of entities) {
    const bbox = entity.appearance_bboxes?.[nodeId];
    if (!bbox) continue;
    if (
      xPct >= bbox.x_pct &&
      xPct <= bbox.x_pct + bbox.w_pct &&
      yPct >= bbox.y_pct &&
      yPct <= bbox.y_pct + bbox.h_pct
    ) {
      const area = bbox.w_pct * bbox.h_pct;
      if (area < bestArea) {
        best = { entity, bbox };
        bestArea = area;
      }
    }
  }
  return best;
}

/** An entity bbox grown by `pad` per side (clamped) — the edit region for a
 *  one-click fix/remove, with margin so the seam blends past the subject. */
export function padBox(bbox: EntityBBox, pad = 0.04): EditRegionBox {
  const x0 = Math.max(0, bbox.x_pct - pad);
  const y0 = Math.max(0, bbox.y_pct - pad);
  const x1 = Math.min(1, bbox.x_pct + bbox.w_pct + pad);
  const y1 = Math.min(1, bbox.y_pct + bbox.h_pct + pad);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
