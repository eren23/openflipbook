import type { Collection, Document } from "mongodb";
import type {
  Entity,
  EntityBBox,
  EntityGeoEdit,
  EntityKind,
  EntityState,
  MapCrop,
  ScaleTier,
  SceneView,
  ViewProjection,
  WorldEntityGeo,
  WorldMapSnapshot,
  WorldVec2,
} from "@openflipbook/config";
import { tierStep } from "@openflipbook/config";

import { getDb, recordError } from "./db";
import { envFlag } from "./env-flag";
import { optimisticReplace } from "./optimistic-update";
import {
  applySimilarity,
  estimateGeoFromBBox,
  fitSimilarity,
  localBounds,
  localExtent,
  mapPolygonToCrop,
  siblingsOf,
  toAbsoluteEntities,
  type SimilarityFit,
} from "./world-geometry";

// Per-session geometric world map (entity coordinates). Mirrors the world_state
// machinery in world.ts — same optimistic read-modify-write loop — but kept in
// its own collection so the geometry schema can evolve independently and a
// session can carry entities without geometry. All dormant until GEOMETRIC_WORLD.
const COLLECTION = "world_map";
const SCHEMA_VERSION = 1;
const OPTIMISTIC_RETRY_LIMIT = 4;

// Authority order: a hand-placed coordinate ("user") never gets clobbered by a
// confirmed detection ("extracted"), which never gets clobbered by a heuristic
// bbox back-projection ("derived"). Equal rank → the newer write wins.
const SOURCE_RANK: Record<WorldEntityGeo["source"], number> = {
  user: 2,
  extracted: 1,
  derived: 0,
};

interface WorldMapDoc extends Document {
  _id: string;
  entities: WorldEntityGeo[];
  bounds: MapCrop;
  schema_version: number;
  updated_at: Date;
}

async function collection(): Promise<Collection<WorldMapDoc>> {
  const db = await getDb();
  return db.collection<WorldMapDoc>(COLLECTION);
}

// ── Pure merge core (unit-tested; no Mongo) ──────────────────────────────────

/**
 * INV-4 (one ladder): the coarse `scale_tier` rung and the fine learned `scale`
 * must agree in DIRECTION — they're two resolutions of the same axis, never a
 * parallel system. Seeding a FINER child rung (DEEPER) the child frame should
 * occupy a fraction of the parent footprint (`scale <= 1`); a learned scale pinned
 * the other way while the rungs say "much smaller" is a mis-seed. Pure; returns a
 * warning string or null (agree / unknown rung). The caller WARNS + keeps the
 * learned scale — never blocks (a wrong rung shouldn't break seeding).
 */
export function ladderDisagreement(
  parentTier: ScaleTier | null | undefined,
  childTier: ScaleTier | null | undefined,
  learnedScale: number,
): string | null {
  if (!parentTier || !childTier) return null;
  const step = tierStep(parentTier, childTier); // child finer => +, coarser => -
  if (step > 0 && learnedScale > 1.0001) {
    return `DEEPER (${parentTier}→${childTier}) but learned scale ${learnedScale} > 1`;
  }
  if (step < 0 && learnedScale < 0.9999) {
    return `OUTWARD (${parentTier}→${childTier}) but learned scale ${learnedScale} < 1`;
  }
  return null;
}

function geoDiffers(a: WorldEntityGeo, b: WorldEntityGeo): boolean {
  return (
    a.pos.x !== b.pos.x ||
    a.pos.y !== b.pos.y ||
    a.height !== b.height ||
    a.footprint.w !== b.footprint.w ||
    a.footprint.d !== b.footprint.d ||
    (a.scale ?? 1) !== (b.scale ?? 1) ||
    // Topology + rung: an equal-rank write that re-points (or re-tiers) an entity
    // must register as a change, or an OUTWARD reparent could be silently undone
    // by a later same-source edit that carries the stale parent_id.
    (a.parent_id ?? null) !== (b.parent_id ?? null) ||
    a.scale_tier !== b.scale_tier ||
    a.label !== b.label ||
    a.visual !== b.visual ||
    a.kind !== b.kind ||
    a.entity_id !== b.entity_id ||
    a.source !== b.source ||
    a.confidence !== b.confidence ||
    JSON.stringify(a.state) !== JSON.stringify(b.state)
  );
}

/** Upsert geometry entries by id, honouring source authority. Truly idempotent:
 *  re-applying the same payload is a no-op (keeps prev + its updated_at), so an
 *  unchanged re-seed doesn't dirty the doc / amplify writes. */
export function applyGeoUpsert(
  existing: WorldEntityGeo[],
  incoming: WorldEntityGeo[],
  nowIso: string,
): WorldEntityGeo[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const g of incoming) {
    const prev = byId.get(g.id);
    if (!prev) {
      byId.set(g.id, { ...g, updated_at: nowIso });
      continue;
    }
    const rg = SOURCE_RANK[g.source];
    const rp = SOURCE_RANK[prev.source];
    // Higher authority always wins; equal authority writes only on a real change.
    if (rg > rp || (rg === rp && geoDiffers(prev, g))) {
      byId.set(g.id, { ...g, updated_at: nowIso });
    }
  }
  return [...byId.values()];
}

/** The world bounds = the axis-aligned box covering every entity's footprint.
 *  Nested entities are resolved to the ABSOLUTE frame first — pos AND
 *  footprint together (the old loop resolved pos but used the raw
 *  parent-local footprint, so one post-ascend re-expressed root inflated the
 *  stored bounds by 1/pScale — the "bounds 8000×6828" minimap blowup). */
export function recomputeBounds(entities: WorldEntityGeo[]): MapCrop {
  if (entities.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  return localBounds(toAbsoluteEntities(entities, entities));
}

// ── Structured geo edits (natural-language-editable map) ─────────────────────

const DEFAULT_GEO_HEIGHT = 4;
const DEFAULT_GEO_FOOTPRINT = 6;

function slugLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Re-root (parent_id = null) any survivor whose parent points at a removed id.
 *  Without this, `resolveAbsolutePos` treats the orphan as a root and composes
 *  its LOCAL pos as if it were absolute — silently mis-placing it and skewing
 *  `recomputeBounds`. Pure; entities whose parent survives are returned as-is. */
function rerootOrphans(
  entities: WorldEntityGeo[],
  removedIds: Iterable<string>,
): WorldEntityGeo[] {
  const removed = new Set(removedIds);
  if (removed.size === 0) return entities;
  return entities.map((e) =>
    e.parent_id != null && removed.has(e.parent_id)
      ? { ...e, parent_id: null }
      : e,
  );
}

/** Apply one structured geo edit to the entity list. Pure + total: an edit whose
 *  target id isn't present is a no-op (never throws). Edited/added entities are
 *  stamped `source:"user"` so a later derived re-seed can't clobber the change. */
export function applyEntityEdit(
  entities: WorldEntityGeo[],
  edit: EntityGeoEdit,
  nowIso: string,
): WorldEntityGeo[] {
  if (edit.op === "add") {
    // Unique id: applyGeoUpsert / getWorldMap key entities by id (Map-by-id), so
    // a duplicate id silently drops one entity — and these are source:"user" adds
    // we must never clobber. Two slug-colliding labels ("North Gate" vs
    // "north-gate"), or re-adding an existing one, get a numeric suffix instead.
    const baseId = `geo_user_${slugLabel(edit.label)}`;
    const takenIds = new Set(entities.map((e) => e.id));
    let uniqueId = baseId;
    for (let n = 2; takenIds.has(uniqueId); n += 1) uniqueId = `${baseId}_${n}`;
    const added: WorldEntityGeo = {
      id: uniqueId,
      entity_id: null,
      kind: "place",
      label: edit.label,
      pos: edit.pos,
      height: edit.height ?? DEFAULT_GEO_HEIGHT,
      footprint: edit.footprint ?? { w: DEFAULT_GEO_FOOTPRINT, d: DEFAULT_GEO_FOOTPRINT },
      visual: "",
      state: {},
      confidence: 1,
      source: "user",
      updated_at: nowIso,
    };
    return [...entities, added];
  }
  if (edit.op === "remove") {
    // Drop the target AND re-root its children — leaving a dangling parent_id
    // silently mis-places them (see rerootOrphans).
    return rerootOrphans(
      entities.filter((e) => e.id !== edit.target),
      [edit.target],
    );
  }
  return entities.map((e) => {
    if (e.id !== edit.target) return e;
    const next: WorldEntityGeo = { ...e, source: "user", updated_at: nowIso };
    if (edit.op === "move") {
      next.pos = { x: e.pos.x + edit.dx, y: e.pos.y + edit.dy };
    } else if (edit.op === "set_height") {
      next.height = edit.height;
    } else if (edit.op === "set_appearance") {
      next.visual = edit.visual;
    }
    return next;
  });
}

/** Node ids whose saved render references any edited entity → the re-stage
 *  candidates. Pure union of `references[target]` over edits that carry a target
 *  (an `add` introduces a new entity, so it stales nothing).
 *
 *  Nested propagation: when `geos` is supplied, moving an entity also
 *  stales the scenes that show its FRAME-SIBLINGS — the "things around it" — since
 *  their relative layout just changed. So editing the Tower of Art re-stages
 *  every Unseen University interior, not just the ones with the tower in frame. */
export function blastRadius(
  edits: EntityGeoEdit[],
  references: Record<string, string[]>,
  geos?: Pick<WorldEntityGeo, "id" | "parent_id">[],
): string[] {
  const nodes = new Set<string>();
  const stale = (geoId: string) => {
    for (const n of references[geoId] ?? []) nodes.add(n);
  };
  for (const e of edits) {
    if ("target" in e) {
      stale(e.target);
      if (geos) {
        for (const sib of siblingsOf(geos, e.target)) stale(sib.id);
      }
    }
  }
  return [...nodes].sort();
}

/** geo-id → node ids that show the entity (the blast-radius source), built from
 *  the codex entities' appears_on_node_ids keyed by the geo entity's id. Geo
 *  props with no linked entity_id (or no appearances) are omitted. */
export function buildGeoReferences(
  geos: Pick<WorldEntityGeo, "id" | "entity_id">[],
  codex: Pick<Entity, "id" | "appears_on_node_ids">[],
): Record<string, string[]> {
  const byId = new Map(codex.map((e) => [e.id, e.appears_on_node_ids ?? []]));
  const refs: Record<string, string[]> = {};
  for (const g of geos) {
    const nodes = g.entity_id ? byId.get(g.entity_id) : undefined;
    if (nodes && nodes.length > 0) refs[g.id] = [...nodes];
  }
  return refs;
}

function snapshotFromDoc(doc: WorldMapDoc): WorldMapSnapshot {
  return {
    session_id: doc._id,
    entities: doc.entities,
    bounds: doc.bounds,
    schema_version: doc.schema_version,
    updated_at: doc.updated_at.toISOString(),
  };
}

function emptySnapshot(sessionId: string): WorldMapSnapshot {
  return {
    session_id: sessionId,
    entities: [],
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    schema_version: SCHEMA_VERSION,
    updated_at: new Date(0).toISOString(),
  };
}

// ── Mongo wrappers (optimistic concurrency, mirrors world.ts) ────────────────

export async function getWorldMap(sessionId: string): Promise<WorldMapSnapshot> {
  const col = await collection();
  const doc = await col.findOne({ _id: sessionId });
  return doc ? snapshotFromDoc(doc) : emptySnapshot(sessionId);
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

/** Upsert geometry entries into the session map under optimistic concurrency. */
export async function upsertEntityGeos(
  sessionId: string,
  geos: WorldEntityGeo[],
): Promise<WorldMapSnapshot> {
  const col = await collection();
  const next = await optimisticReplace<WorldMapDoc>(
    col,
    sessionId,
    (existing) => {
      const now = new Date();
      const entities = applyGeoUpsert(
        existing ? existing.entities : [],
        geos,
        now.toISOString(),
      );
      return {
        _id: sessionId,
        entities,
        bounds: recomputeBounds(entities),
        schema_version: SCHEMA_VERSION,
        updated_at: now,
      };
    },
    { retryLimit: OPTIMISTIC_RETRY_LIMIT, isDuplicateKeyError, label: "upsertEntityGeos" },
  );
  return snapshotFromDoc(next);
}

/** Apply a sequence of structured geo edits to the session map under optimistic
 *  concurrency (mirrors upsertEntityGeos). Each edit runs in order through the
 *  pure applyEntityEdit; an empty edit list returns the current snapshot. */
export async function applyEntityEdits(
  sessionId: string,
  edits: EntityGeoEdit[],
): Promise<WorldMapSnapshot> {
  if (edits.length === 0) return getWorldMap(sessionId);
  const col = await collection();
  const next = await optimisticReplace<WorldMapDoc>(
    col,
    sessionId,
    (existing) => {
      const now = new Date();
      const nowIso = now.toISOString();
      let entities = existing ? existing.entities : [];
      for (const edit of edits) entities = applyEntityEdit(entities, edit, nowIso);
      return {
        _id: sessionId,
        entities,
        bounds: recomputeBounds(entities),
        schema_version: SCHEMA_VERSION,
        updated_at: now,
      };
    },
    { retryLimit: OPTIMISTIC_RETRY_LIMIT, isDuplicateKeyError, label: "applyEntityEdits" },
  );
  return snapshotFromDoc(next);
}

/** Remove geometry entries by id under optimistic concurrency — used when a
 *  codex entity is deleted (drop its `geo_<id>`) or to revert a failed ascend
 *  (drop the phantom container). Re-roots any orphaned children so they don't
 *  silently mis-resolve. Missing ids are a no-op. */
export async function removeEntityGeos(
  sessionId: string,
  ids: string[],
): Promise<WorldMapSnapshot> {
  if (ids.length === 0) return getWorldMap(sessionId);
  const removeSet = new Set(ids);
  const col = await collection();
  const next = await optimisticReplace<WorldMapDoc>(
    col,
    sessionId,
    (existing) => {
      const now = new Date();
      const kept = rerootOrphans(
        (existing ? existing.entities : []).filter((e) => !removeSet.has(e.id)),
        ids,
      );
      return {
        _id: sessionId,
        entities: kept,
        bounds: recomputeBounds(kept),
        schema_version: SCHEMA_VERSION,
        updated_at: now,
      };
    },
    { retryLimit: OPTIMISTIC_RETRY_LIMIT, isDuplicateKeyError, label: "removeEntityGeos" },
  );
  return snapshotFromDoc(next);
}

// ── Seeding bridge: extraction → derived map geometry ────────────────────────

export interface ExtractedGeoItem {
  entity_id: string;
  kind: EntityKind;
  label: string;
  bbox: EntityBBox;
  visual?: string;
  state?: EntityState;
  confidence?: number;
  // B2 segmenter (optional): the entity's border polygon in normalized IMAGE
  // space (0..1, as the segmenter returns it) + the inferred ABSOLUTE height
  // in meters. Persisted only when WORLD_SEGMENT_BORDERS is on; borders only
  // on top-down map frames, where the image→frame mapping is linear.
  border?: WorldVec2[];
  height_m?: number;
}

/** Map an extraction pass (entities that have a bbox on this scene) into derived
 *  world geometry and upsert it — the world map populates for free. */
export async function deriveGeoFromExtraction(
  sessionId: string,
  view: SceneView,
  aspect: number,
  items: ExtractedGeoItem[],
  projection: ViewProjection = "top_down",
  pitchDeg = -60,
  // When set, the seeded geometry hangs off this place's child frame (its geo
  // id) — i.e. these are sub-entities INSIDE a place, positioned in its local
  // frame, not top-level city entities.
  parentId: string | null = null,
  // The coarse SCALE_LADDER rung the view estimator read for this frame (B2).
  // Stamped on each seeded geo so a fresh session carries a rung for free.
  scaleTier?: ScaleTier,
): Promise<WorldMapSnapshot> {
  const nowIso = new Date().toISOString();
  // B2 segmenter persistence — storage only, nothing renders these yet.
  const bordersOn = envFlag("WORLD_SEGMENT_BORDERS");
  const geos: WorldEntityGeo[] = items.map((item) => {
    const est = estimateGeoFromBBox(item.bbox, view, aspect, projection, pitchDeg);
    return {
      id: `geo_${item.entity_id}`,
      entity_id: item.entity_id,
      parent_id: parentId,
      kind: item.kind,
      label: item.label,
      pos: est.pos,
      height: est.height,
      footprint: est.footprint,
      ...(scaleTier ? { scale_tier: scaleTier } : {}),
      ...(bordersOn &&
      item.border &&
      item.border.length >= 3 &&
      projection === "top_down" &&
      view.level === "map" &&
      view.map_crop
        ? { border: mapPolygonToCrop(item.border, view.map_crop) }
        : {}),
      ...(bordersOn && item.height_m && item.height_m > 0
        ? { height_m: item.height_m }
        : {}),
      visual: item.visual ?? "",
      state: item.state ?? {},
      // Derived placements are discounted so a later user/extracted write wins.
      confidence: (item.confidence ?? 0.5) * 0.6,
      source: "derived",
      updated_at: nowIso,
    };
  });
  if (geos.length === 0) return getWorldMap(sessionId);
  // Seeding INTO a place's frame → LEARN that place's `scale` so its children
  // resolve INSIDE its footprint (a true absolute coordinate across the
  // universe), not summed flat into the city: scale = the parent's footprint
  // extent ÷ the interior's local extent. Best-effort + clamped so a bad extent
  // can't explode the map; the parent keeps its source authority (scale-only).
  if (parentId) {
    const parent = (await getWorldMap(sessionId)).entities.find(
      (e) => e.id === parentId,
    );
    if (parent) {
      const footprint = Math.max(parent.footprint.w, parent.footprint.d);
      const scale = Math.min(Math.max(footprint / localExtent(geos), 1e-3), 10);
      // INV-4: warn (never block) if the learned scale contradicts the rung step.
      const warn = ladderDisagreement(parent.scale_tier, scaleTier, scale);
      if (warn) {
        // Route to the errors collection (not just console) so a mis-seed is
        // queryable in prod instead of invisible. Best-effort; seeding proceeds.
        await recordError({
          trace_id: null,
          kind: "world-map.inv4",
          message: `${warn} — keeping the learned scale`,
          stack: null,
          body_excerpt: `session=${sessionId} parent=${parentId}`,
          source: "backend",
        }).catch(() => {});
      }
      if ((parent.scale ?? 1) !== scale) geos.push({ ...parent, scale });
    }
  }
  return upsertEntityGeos(sessionId, geos);
}

// ── Plan→image register (AUDIT_BOX §4, the tractable half of metric pose) ────

/** Register the B1 authored plane onto the image register. The solver's
 *  `geo_plan_*` entities and the extraction-seeded `geo_*` entities describe
 *  the same places in two frames that historically never met — the plan
 *  where the description put things, the seeds where the model painted them.
 *  This fits a similarity (same math the recon bench proves recoverable:
 *  fitSimilarity, scale-clamped + optional x-flip) from plan positions to
 *  their label-matched image seeds and re-expresses ALL plan geos into the
 *  image frame — the one frame every consumer (taps, rings, labels, bounds)
 *  already reads. Pure; returns null when there is nothing to do:
 *  no plan geos, fewer than 2 label matches, or the fit is already ≈identity
 *  (a prior registration — keeps the write path idempotent). */
export function registerPlanToImage(
  geos: WorldEntityGeo[],
  nowIso: string,
): { updated: WorldEntityGeo[]; fit: SimilarityFit } | null {
  const plans = geos.filter(
    (g) => g.id.startsWith("geo_plan_") && (g.parent_id ?? null) === null,
  );
  if (plans.length === 0) return null;
  const images = geos.filter(
    (g) =>
      !g.id.startsWith("geo_plan_") &&
      (g.parent_id ?? null) === null &&
      g.entity_id !== null,
  );
  if (images.length === 0) return null;
  const norm = (s: string) => s.toLowerCase().trim();
  // The painter RENAMES features (live case, 2026-07-05 fishing village:
  // plan "White Lighthouse" painted as "North Point Lighthouse", "Wooden
  // Harbor" as "Old Harbor Piers") — exact/substring matching alone found 1
  // anchor out of 5 and the registration never fired. So the tiers are:
  // exact > substring > shared significant tokens (stop-worded, s-stemmed:
  // "lighthouse"/"harbor"/"pine" anchor; "north"/"old"/"white" don't),
  // greedily assigned unique on both sides.
  const GENERIC = new Set([
    "the", "and", "old", "new", "big", "small", "great", "little",
    "north", "south", "east", "west", "upper", "lower", "inner", "outer",
    "central", "grand", "dark", "white", "black", "red", "blue", "green",
    "golden", "silver", "point", "side", "shore", "ridge", "district",
  ]);
  const sig = (s: string) =>
    new Set(
      norm(s)
        .split(/[^a-z0-9]+/)
        .map((t) => t.replace(/s$/, ""))
        .filter((t) => t.length > 2 && !GENERIC.has(t)),
    );
  const candidates: { p: WorldEntityGeo; g: WorldEntityGeo; score: number }[] =
    [];
  for (const p of plans) {
    const a = norm(p.label);
    if (!a) continue;
    const ta = sig(a);
    for (const g of images) {
      const b = norm(g.label);
      if (!b) continue;
      let score = 0;
      if (a === b) score = Infinity;
      else if (a.includes(b) || b.includes(a)) score = 100;
      else for (const t of ta) if (sig(b).has(t)) score++;
      if (score > 0) candidates.push({ p, g, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const usedP = new Set<string>();
  const usedG = new Set<string>();
  const pairs: [WorldVec2, WorldVec2][] = [];
  for (const c of candidates) {
    if (usedP.has(c.p.id) || usedG.has(c.g.id)) continue;
    usedP.add(c.p.id);
    usedG.add(c.g.id);
    pairs.push([c.p.pos, c.g.pos]);
  }
  const fit = fitSimilarity(pairs);
  if (fit === null) return null;
  // Already registered (or trivially in register): skip the churn.
  if (
    !fit.flipX &&
    Math.abs(fit.scale - 1) < 0.02 &&
    Math.abs(fit.tx) < 0.5 &&
    Math.abs(fit.ty) < 0.5
  ) {
    return null;
  }
  const updated = plans.map((p) => ({
    ...p,
    pos: applySimilarity(fit, p.pos),
    footprint: {
      w: p.footprint.w * fit.scale,
      d: p.footprint.d * fit.scale,
    },
    height: p.height * fit.scale,
    updated_at: nowIso,
  }));
  return { updated, fit };
}

export const __test = {
  applyGeoUpsert,
  recomputeBounds,
  applyEntityEdit,
  blastRadius,
  buildGeoReferences,
};
