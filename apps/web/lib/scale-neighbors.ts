import type { ScaleTier, WorldEntityGeo } from "@openflipbook/config";

import { siblingsOf } from "./world-geometry";

export interface LogicalNeighbor {
  label: string;
  bearing: number; // radians from the focus, 0 = +x
}

export interface LogicalNeighbors {
  tier: ScaleTier | null;
  // Same-scale sibling labels the session ALREADY knows — passed to the bloom as
  // exclusions so it proposes NEW peers, not places already on the map.
  known: string[];
  // The known neighbours with real bearings (for placement / persistence).
  neighbors: LogicalNeighbor[];
}

/**
 * The logical AROUND cascade (B2, SCALE_AROUND_LOGICAL): the same-scale neighbours
 * the geometry already knows, so "show me more like these" is grounded in real
 * bearings + the focus's rung instead of an arbitrary VLM survey.
 *
 * Geometry first: `siblingsOf` the focus (same `parent_id`) filtered to the same
 * `scale_tier`, each with an `atan2` bearing in the shared frame. The geos carry
 * the codex's labels, so this is geometry + facts in one pass. The `known` labels
 * become `propose_neighbors`' exclusions + its `scale_tier` constraint, so the
 * (cold-start-only) VLM adds NEW peers at the SAME scale rather than re-proposing
 * what's already mapped. Pure; empty for a focus with no seeded siblings → the
 * caller falls back to today's unconstrained bloom.
 */
export function selectNeighbors(
  focusId: string,
  geos: WorldEntityGeo[],
  tierHint?: ScaleTier | null,
): LogicalNeighbors {
  const focus = geos.find((g) => g.id === focusId);
  if (!focus) return { tier: tierHint ?? null, known: [], neighbors: [] };
  const tier = tierHint ?? focus.scale_tier ?? null;
  const neighbors = siblingsOf(geos, focusId)
    .filter((s) => !tier || (s.scale_tier ?? null) === tier)
    .filter((s) => s.label.trim().length > 0)
    .map((s) => ({
      label: s.label.trim(),
      bearing: Math.atan2(s.pos.y - focus.pos.y, s.pos.x - focus.pos.x),
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const known = [...new Set(neighbors.map((n) => n.label))];
  return { tier, known, neighbors };
}
