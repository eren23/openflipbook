import type { Collection, Document } from "mongodb";
import type {
  EntityBBox,
  EntityGeoEdit,
  EntityKind,
  EntityState,
  MapCrop,
  SceneView,
  WorldEntityGeo,
  WorldMapSnapshot,
} from "@openflipbook/config";

import { getDb } from "./db";
import { estimateGeoFromBBox } from "./world-geometry";

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

function geoDiffers(a: WorldEntityGeo, b: WorldEntityGeo): boolean {
  return (
    a.pos.x !== b.pos.x ||
    a.pos.y !== b.pos.y ||
    a.height !== b.height ||
    a.footprint.w !== b.footprint.w ||
    a.footprint.d !== b.footprint.d ||
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

/** The world bounds = the axis-aligned box covering every entity's footprint. */
export function recomputeBounds(entities: WorldEntityGeo[]): MapCrop {
  if (entities.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entities) {
    const hw = e.footprint.w / 2;
    const hd = e.footprint.d / 2;
    minX = Math.min(minX, e.pos.x - hw);
    maxX = Math.max(maxX, e.pos.x + hw);
    minY = Math.min(minY, e.pos.y - hd);
    maxY = Math.max(maxY, e.pos.y + hd);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── Structured geo edits (Phase 5: NL-editable map) ──────────────────────────

const DEFAULT_GEO_HEIGHT = 4;
const DEFAULT_GEO_FOOTPRINT = 6;

function slugLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
    const added: WorldEntityGeo = {
      id: `geo_user_${slugLabel(edit.label)}`,
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
    return entities.filter((e) => e.id !== edit.target);
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
 *  (an `add` introduces a new entity, so it stales nothing). */
export function blastRadius(
  edits: EntityGeoEdit[],
  references: Record<string, string[]>,
): string[] {
  const nodes = new Set<string>();
  for (const e of edits) {
    if ("target" in e) {
      for (const n of references[e.target] ?? []) nodes.add(n);
    }
  }
  return [...nodes].sort();
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
  let attempt = 0;
  while (true) {
    const existing = await col.findOne({ _id: sessionId });
    const now = new Date();
    const entities = applyGeoUpsert(
      existing ? existing.entities : [],
      geos,
      now.toISOString(),
    );
    const next: WorldMapDoc = {
      _id: sessionId,
      entities,
      bounds: recomputeBounds(entities),
      schema_version: SCHEMA_VERSION,
      updated_at: now,
    };
    let ok = false;
    if (existing) {
      const write = await col.replaceOne(
        { _id: sessionId, updated_at: existing.updated_at },
        next,
      );
      ok = write.matchedCount === 1;
    } else {
      try {
        await col.insertOne(next);
        ok = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        ok = false;
      }
    }
    if (ok) return snapshotFromDoc(next);
    attempt += 1;
    if (attempt >= OPTIMISTIC_RETRY_LIMIT) {
      throw new Error(
        `upsertEntityGeos: optimistic concurrency retry exhausted for ${sessionId}`,
      );
    }
  }
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
}

/** Map an extraction pass (entities that have a bbox on this scene) into derived
 *  world geometry and upsert it — the world map populates for free. */
export async function deriveGeoFromExtraction(
  sessionId: string,
  view: SceneView,
  aspect: number,
  items: ExtractedGeoItem[],
): Promise<WorldMapSnapshot> {
  const nowIso = new Date().toISOString();
  const geos: WorldEntityGeo[] = items.map((item) => {
    const est = estimateGeoFromBBox(item.bbox, view, aspect);
    return {
      id: `geo_${item.entity_id}`,
      entity_id: item.entity_id,
      kind: item.kind,
      label: item.label,
      pos: est.pos,
      height: est.height,
      footprint: est.footprint,
      visual: item.visual ?? "",
      state: item.state ?? {},
      // Derived placements are discounted so a later user/extracted write wins.
      confidence: (item.confidence ?? 0.5) * 0.6,
      source: "derived",
      updated_at: nowIso,
    };
  });
  if (geos.length === 0) return getWorldMap(sessionId);
  return upsertEntityGeos(sessionId, geos);
}

export const __test = {
  applyGeoUpsert,
  recomputeBounds,
  applyEntityEdit,
  blastRadius,
};
