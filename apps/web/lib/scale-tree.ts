import type { WorldEntityGeo } from "@openflipbook/config";
import { tierMetricMultiplier } from "@openflipbook/config";

import { localExtent } from "./world-geometry";

// B2 OUTWARD reparent — the one operation that inverts the frame tree: synthesize
// a coarser parent P and re-root the current root C under it. PURE (no Mongo, no
// Date.now — the caller passes nowIso, like applyGeoUpsert) so INV-1 is a pure,
// golden-testable property over resolveAbsolutePos. The impure persistence (the
// /ascend route) is a thin wrapper around this.

export interface ReparentResult {
  // The full new entities array: P inserted (parent_id:null) + old root C
  // re-pointed under P with the conserving local pos + scale.
  geos: WorldEntityGeo[];
  // P's geo id (so the caller can anchor the P node's scene_view focus).
  parentGeoId: string;
  // P's learned fine frame scale (for logging / the INV-2/INV-4 cross-check).
  learnedScale: number;
}

// The same clamp deriveGeoFromExtraction uses (world-map.ts) so a pathological
// rung ratio or extent can't explode the frame.
const SCALE_MIN = 1e-3;
const SCALE_MAX = 10;
const clampScale = (s: number): number => Math.min(Math.max(s, SCALE_MIN), SCALE_MAX);

/**
 * Re-root `oldRootId` (the current root C) under the synthesized parent `parentGeo`
 * (P), conserving every descendant's ABSOLUTE position (INV-1).
 *
 * P's fine frame scale is the METRIC ratio meters(child)/meters(parent) =
 * `tierMetricMultiplier(parentTier, childTier)` (< 1: a city is a small part of a
 * region), falling back to the footprint÷extent law `deriveGeoFromExtraction`
 * uses when a rung is missing. Whatever the scale, C is re-expressed in P's frame
 * as the exact affine INVERSE of inserting the (P.pos, pScale) frame above it:
 *   C.pos'   = (C.pos − P.pos) / pScale
 *   C.scale' = (C.scale ?? 1) / pScale
 * so `resolveAbsolutePos` composes the same `(x, y)` for C and every descendant
 * as before the reparent — for ANY chosen P.pos / pScale.
 *
 * Guards: C must exist and be a root (rejects a double-ascend); P's id must be new.
 * P and the re-pointed C are stamped `source:"user"` so a later `derived` re-seed
 * can't clobber the new edge (SOURCE_RANK, world-map.ts).
 */
export function reparent(
  geos: WorldEntityGeo[],
  oldRootId: string,
  parentGeo: WorldEntityGeo,
  nowIso: string,
): ReparentResult {
  const child = geos.find((g) => g.id === oldRootId);
  if (!child) {
    throw new Error(`reparent: oldRootId "${oldRootId}" is not in the entity set`);
  }
  if ((child.parent_id ?? null) !== null) {
    throw new Error(
      `reparent: "${oldRootId}" is not a root (parent_id=${child.parent_id}); ` +
        "refusing a double ascend",
    );
  }
  if (geos.some((g) => g.id === parentGeo.id)) {
    throw new Error(`reparent: parent id "${parentGeo.id}" already exists`);
  }

  const parentTier = parentGeo.scale_tier;
  const childTier = child.scale_tier;
  const pScale =
    parentTier && childTier
      ? clampScale(tierMetricMultiplier(parentTier, childTier))
      : clampScale(
          Math.max(parentGeo.footprint.w, parentGeo.footprint.d) / localExtent([child]),
        );

  const newChild: WorldEntityGeo = {
    ...child,
    parent_id: parentGeo.id,
    pos: {
      x: (child.pos.x - parentGeo.pos.x) / pScale,
      y: (child.pos.y - parentGeo.pos.y) / pScale,
    },
    scale: (child.scale ?? 1) / pScale,
    source: "user",
    updated_at: nowIso,
  };
  const newParent: WorldEntityGeo = {
    ...parentGeo,
    parent_id: null,
    scale: pScale,
    source: "user",
    updated_at: nowIso,
  };

  const geosOut = geos.map((g) => (g.id === oldRootId ? newChild : g));
  geosOut.push(newParent);
  return { geos: geosOut, parentGeoId: parentGeo.id, learnedScale: pScale };
}
