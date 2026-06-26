import type { WorldEntityGeo, WorldVec2 } from "@openflipbook/config";
import { tierMetricMultiplier } from "@openflipbook/config";

import { clamp } from "./clamp";
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
const clampScale = (s: number): number => clamp(s, SCALE_MIN, SCALE_MAX);

// P's fine frame scale: the METRIC ratio meters(child)/meters(parent) =
// `tierMetricMultiplier(parentTier, childTier)` (< 1: a city is a small part of a
// region), falling back to the footprint÷extent law `deriveGeoFromExtraction`
// uses when a rung is missing. Guards a NaN / 0 / ∞ ratio (a malformed footprint
// or an off-ladder tier) that would poison every coordinate → identity frame (1).
// NOTE: the result is CLAMPED — astronomical hops (≤ star_system) floor to 1e-3.
function learnPScale(
  parentGeo: WorldEntityGeo,
  childTier: WorldEntityGeo["scale_tier"],
  childExtent: number,
): number {
  const parentTier = parentGeo.scale_tier;
  const raw =
    parentTier && childTier
      ? tierMetricMultiplier(parentTier, childTier)
      : Math.max(parentGeo.footprint.w, parentGeo.footprint.d) / childExtent;
  return Number.isFinite(raw) && raw > 0 ? clampScale(raw) : 1;
}

// Re-express a former root R inside P's frame so abs(R) and ALL its descendants
// are conserved (INV-1): the exact affine inverse of inserting the (P.pos, pScale)
// frame above R. resolveAbsolutePos composes the same (x, y) as before for any
// chosen P.pos / pScale, because the inserted pScale frame and the /pScale here
// cancel identically.
function reExpressUnder(
  node: WorldEntityGeo,
  parentId: string,
  parentPos: WorldVec2,
  pScale: number,
  nowIso: string,
): WorldEntityGeo {
  return {
    ...node,
    parent_id: parentId,
    pos: { x: (node.pos.x - parentPos.x) / pScale, y: (node.pos.y - parentPos.y) / pScale },
    scale: (node.scale ?? 1) / pScale,
    source: "user", // protect the new edge from a later derived re-seed (SOURCE_RANK)
    updated_at: nowIso,
  };
}

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

  const pScale = learnPScale(parentGeo, child.scale_tier, localExtent([child]));
  const newChild = reExpressUnder(child, parentGeo.id, parentGeo.pos, pScale, nowIso);
  const newParent = makeRootParent(parentGeo, pScale, nowIso);

  const geosOut = geos.map((g) => (g.id === oldRootId ? newChild : g));
  geosOut.push(newParent);
  return { geos: geosOut, parentGeoId: parentGeo.id, learnedScale: pScale };
}

// P always lands as a fresh root with the learned fine scale.
function makeRootParent(
  parentGeo: WorldEntityGeo,
  pScale: number,
  nowIso: string,
): WorldEntityGeo {
  return { ...parentGeo, parent_id: null, scale: pScale, source: "user", updated_at: nowIso };
}

// The most-common rung among a set of geos (insertion order breaks ties), or
// undefined if none carry one. P has ONE `scale` field that `resolveAbsolutePos`
// applies uniformly to all its children, so a single shared pScale is unavoidable;
// the MODAL rung makes it representative of the majority (a uniform-tier map — the
// normal case — is exact) instead of an arbitrary first root. A genuinely mixed
// set is a relative-scale approximation; INV-1 is conserved either way.
function modalTier(geos: WorldEntityGeo[]): WorldEntityGeo["scale_tier"] {
  const counts = new Map<NonNullable<WorldEntityGeo["scale_tier"]>, number>();
  for (const g of geos) {
    if (g.scale_tier) counts.set(g.scale_tier, (counts.get(g.scale_tier) ?? 0) + 1);
  }
  let best: WorldEntityGeo["scale_tier"];
  let bestN = 0;
  for (const [t, n] of counts) {
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}

/**
 * The OUTWARD reparent the session geo store actually needs: a map is seeded as
 * MANY top-level roots (its buildings), not one — so re-point EVERY current root
 * under the synthesized parent P, conserving each one's absolute position (INV-1).
 * One shared `pScale` (P has a single `scale` field) from the roots' MODAL rung
 * (or their joint extent) re-expresses every root via the same affine inverse.
 * Non-root entities (sub-place interiors) are untouched — they ride along as P's
 * grandchildren, still conserved.
 */
export function reparentRoots(
  geos: WorldEntityGeo[],
  parentGeo: WorldEntityGeo,
  nowIso: string,
): ReparentResult {
  const roots = geos.filter((g) => (g.parent_id ?? null) === null);
  if (roots.length === 0) {
    throw new Error("reparentRoots: no root entities to reparent");
  }
  if (geos.some((g) => g.id === parentGeo.id)) {
    throw new Error(`reparentRoots: parent id "${parentGeo.id}" already exists`);
  }
  const childTier = modalTier(roots);
  const pScale = learnPScale(parentGeo, childTier, localExtent(roots));
  const rootIds = new Set(roots.map((r) => r.id));
  const newParent = makeRootParent(parentGeo, pScale, nowIso);
  const geosOut = geos.map((g) =>
    rootIds.has(g.id) ? reExpressUnder(g, parentGeo.id, parentGeo.pos, pScale, nowIso) : g,
  );
  geosOut.push(newParent);
  return { geos: geosOut, parentGeoId: parentGeo.id, learnedScale: pScale };
}
