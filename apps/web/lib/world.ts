import type { Collection, Document } from "mongodb";
import type {
  Entity,
  EntityBBox,
  EntityExtractionResult,
  EntityKind,
  EntityState,
  EntityUpdate,
  ExtractedEntity,
  WorldContextEntity,
  WorldStateSnapshot,
} from "@openflipbook/config";
import { getDb } from "./db";

const COLLECTION = "world_state";
const SCHEMA_VERSION = 1;
const MIN_ADDED_CONFIDENCE = 0.3;
const MAX_FACTS_PER_ENTITY = 12;
const MAX_PRIOR_ENTITIES_FOR_EXTRACTION = 30;
// Continuity injection (Phase 3) — how many entities to ship into the
// planner's context. Smaller than the extraction prior slice because
// every entity inflates the image-gen prompt with an appearance sentence
// the renderer has to honour; too many and the prompt drifts.
const MAX_CONTINUITY_ENTITIES = 8;

// Phase 7a — causality state-write gate. Raw VLM-emitted state used to
// land directly in the registry, which the Phase 6 planner clause then
// promoted to a sticky cross-page constraint. We now drop low-confidence
// state diffs entirely and restrict keys to a canonical allow-list. The
// load-bearing guard is here; the extractor prompt has a companion nudge.
const MIN_STATE_WRITE_CONFIDENCE = 0.6;

// Canonical state keys the planner is willing to honour. Anything else
// the VLM emits is logged (so we can grow the list deliberately) and
// dropped at the merge layer. The set deliberately stays small to keep
// the planner's CAUSALITY block tractable.
const CANONICAL_STATE_KEYS = new Set([
  // Doors / portals / containers.
  "open",
  "closed",
  "locked",
  "broken",
  // Light + fire.
  "lit",
  "extinguished",
  "burning",
  // Living conditions.
  "wounded",
  "defeated",
  "asleep",
  "awake",
  "alive",
  "dead",
  // Presence / location.
  "present",
  "absent",
  "hidden",
  // Pose / state.
  "posture",
  // Inventory / ownership.
  "held_by",
  "location",
  // Environmental.
  "time",
  "weather",
]);

interface EntityDoc {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
  appearance: string;
  reference_image_url: string | null;
  facts: string[];
  state: EntityState;
  first_seen_node_id: string;
  last_seen_node_id: string;
  appears_on_node_ids: string[];
  // Sparse map node_id → bbox. Pre-Phase-4 docs have no entries; the
  // hover-chip overlay falls back to no-render in that case.
  appearance_bboxes: Record<string, EntityBBox>;
  pinned_by_user: boolean;
  confidence: number;
  updated_at: Date;
  // Phase 7b — soft-delete tombstone. When non-null, the entity is
  // hidden from snapshot reads and excluded from the continuity slice,
  // but its name + aliases STILL participate in the in-payload index
  // so the extractor can't silently re-add the same character. The
  // codex panel offers a brief Undo window; otherwise tombstones
  // accumulate (a future purge sweep collapses them ~30 days out).
  deleted_at?: Date | null;
}

interface WorldStateDoc extends Document {
  _id: string;
  entities: EntityDoc[];
  updated_at: Date;
  schema_version: number;
}

async function collection(): Promise<Collection<WorldStateDoc>> {
  const db = await getDb();
  return db.collection<WorldStateDoc>(COLLECTION);
}

function entityToWire(doc: EntityDoc): Entity {
  return {
    id: doc.id,
    kind: doc.kind,
    name: doc.name,
    aliases: doc.aliases,
    appearance: doc.appearance,
    reference_image_url: doc.reference_image_url,
    facts: doc.facts,
    state: doc.state,
    first_seen_node_id: doc.first_seen_node_id,
    last_seen_node_id: doc.last_seen_node_id,
    appears_on_node_ids: doc.appears_on_node_ids,
    appearance_bboxes: doc.appearance_bboxes ?? {},
    pinned_by_user: doc.pinned_by_user,
    confidence: doc.confidence,
    updated_at: doc.updated_at.toISOString(),
  };
}

function snapshotFromDoc(doc: WorldStateDoc): WorldStateSnapshot {
  return {
    session_id: doc._id,
    entities: doc.entities.map(entityToWire),
    updated_at: doc.updated_at.toISOString(),
  };
}

function emptySnapshot(sessionId: string): WorldStateSnapshot {
  return {
    session_id: sessionId,
    entities: [],
    updated_at: new Date(0).toISOString(),
  };
}

export async function getWorldState(
  sessionId: string
): Promise<WorldStateSnapshot> {
  const col = await collection();
  const doc = await col.findOne({ _id: sessionId });
  if (!doc) return emptySnapshot(sessionId);
  // Snapshot readers never see tombstoned entities. The in-payload merge
  // index DOES still include them (see `applyExtractionToEntities`) so
  // the extractor's re-add gets silently dropped.
  const live: WorldStateDoc = {
    ...doc,
    entities: doc.entities.filter((e) => !e.deleted_at),
  };
  return snapshotFromDoc(live);
}

// Pick the slice of the current registry most likely to overlap a freshly
// generated page. We send name + appearance only — enough for the VLM to
// decide "same as before" vs "new entity" without paying for the whole
// registry every call.
//
// Scoring (higher = more likely to ship): a base recency score (0..1,
// linear over the registry's age range) plus a strong overlap bonus when
// the caption / scene description contains the entity's name or any
// alias as a whole-word substring. Pinned entries get a guaranteed
// inclusion floor so user-curated characters always stay in scope.
export async function listPriorEntitiesForExtraction(
  sessionId: string,
  captionHint?: string
): Promise<Array<Pick<Entity, "id" | "kind" | "name" | "aliases" | "appearance">>> {
  const col = await collection();
  const doc = await col.findOne(
    { _id: sessionId },
    { projection: { entities: 1 } }
  );
  if (!doc || !doc.entities || doc.entities.length === 0) return [];
  // Phase 7b — tombstoned entities are not eligible for the prior slice.
  // The extractor would otherwise see them, match them to a depicted
  // character, and emit a presence-ping that revives the registry entry.
  const liveEntities = doc.entities.filter((e) => !e.deleted_at);
  if (liveEntities.length === 0) return [];

  const hintLower = (captionHint ?? "").toLowerCase();
  const wordBoundary = (needle: string): boolean => {
    if (!needle) return false;
    const n = needle.toLowerCase();
    if (!hintLower.includes(n)) return false;
    // Reject substring-only hits like "ana" in "banana" — match whole
    // words / hyphen-bounded fragments so a generic noun in the caption
    // doesn't falsely pull an unrelated entity into scope.
    const idx = hintLower.indexOf(n);
    const before = idx === 0 ? "" : hintLower[idx - 1] ?? "";
    const after =
      idx + n.length >= hintLower.length
        ? ""
        : hintLower[idx + n.length] ?? "";
    const isBoundary = (c: string) => !c || !/[a-z0-9]/i.test(c);
    return isBoundary(before) && isBoundary(after);
  };

  // Time scale: how far each doc's updated_at sits between oldest and newest.
  // 1.0 = freshest, 0.0 = oldest. Single-entity registries get 1.0 by default.
  const times = liveEntities.map((e) => e.updated_at.getTime());
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const span = Math.max(1, newest - oldest);

  type Scored = (typeof liveEntities)[number] & { _score: number };
  const scored: Scored[] = liveEntities.map((e) => {
    const recency = (e.updated_at.getTime() - oldest) / span;
    const nameHit = wordBoundary(e.name) ? 1 : 0;
    const aliasHit = e.aliases.some(wordBoundary) ? 0.6 : 0;
    const pinBoost = e.pinned_by_user ? 0.4 : 0;
    return { ...e, _score: recency + nameHit + aliasHit + pinBoost };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, MAX_PRIOR_ENTITIES_FOR_EXTRACTION).map((e) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: e.aliases,
    appearance: e.appearance,
  }));
}

interface MergeExtractionInput {
  session_id: string;
  node_id: string;
  result: EntityExtractionResult;
}

export interface MergeExtractionOutput {
  snapshot: WorldStateSnapshot;
  added_ids: string[];
  updated_ids: string[];
}

// Optimistic-concurrency retries. Two parallel extractions for the same
// session would otherwise both read the same doc and the later replaceOne
// would silently overwrite the earlier. We filter the write on
// `updated_at` (the read's seen timestamp) and re-run the merge on
// conflict. 4 attempts is well over the realistic burst — extraction is
// fire-and-forget per page so contention is bursty but rarely deep.
const OPTIMISTIC_RETRY_LIMIT = 4;

// Apply an extraction result to the world_state doc, allocating ids for
// brand-new entities and folding `updated` diffs into the existing records.
// Idempotent at the field level — same payload run twice produces the same
// state (facts are merged uniquely; node_ids are de-duped).
//
// Concurrency: we run a read-modify-write loop. For an existing row, the
// `replaceOne` filter pins on `updated_at` so two parallel writers
// serialise; the loser retries (capped at OPTIMISTIC_RETRY_LIMIT).
// For a fresh row we use `insertOne` and recover from the duplicate-key
// error by falling through into the optimistic-replace path — that
// closes the previous gap where two parallel first-writes could both
// upsert and clobber.
export async function mergeExtraction(
  input: MergeExtractionInput
): Promise<MergeExtractionOutput> {
  const col = await collection();
  let attempt = 0;
  while (true) {
    const existing = await col.findOne({ _id: input.session_id });
    const entities: EntityDoc[] = existing ? existing.entities.map(cloneEntity) : [];
    const now = new Date();
    const result = applyExtractionToEntities(entities, input.node_id, input.result, now);

    const next: WorldStateDoc = {
      _id: input.session_id,
      entities,
      updated_at: now,
      schema_version: SCHEMA_VERSION,
    };

    let ok = false;
    if (existing) {
      const write = await col.replaceOne(
        { _id: input.session_id, updated_at: existing.updated_at },
        next
      );
      ok = write.matchedCount === 1;
    } else {
      // First-write path: insertOne. If another writer beat us, the
      // duplicate-key error sends us around the loop, which now sees
      // the row and uses the optimistic-replace path. Without this,
      // two parallel "create" calls would both upsert and the second
      // would silently overwrite the first.
      try {
        await col.insertOne(next);
        ok = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        ok = false;
      }
    }

    if (ok) {
      return {
        snapshot: snapshotFromDoc(next),
        added_ids: result.added_ids,
        updated_ids: result.updated_ids,
      };
    }
    attempt += 1;
    if (attempt >= OPTIMISTIC_RETRY_LIMIT) {
      throw new Error(
        `mergeExtraction: optimistic concurrency retry exhausted for session ${input.session_id}`
      );
    }
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  // Mongo duplicate-key error is exposed as MongoServerError with code 11000.
  // Defensive against missing fields so we don't swallow unrelated errors.
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === 11000;
}

function cloneEntity(e: EntityDoc): EntityDoc {
  return {
    ...e,
    aliases: e.aliases.slice(),
    facts: e.facts.slice(),
    state: { ...e.state },
    appears_on_node_ids: e.appears_on_node_ids.slice(),
    appearance_bboxes: { ...(e.appearance_bboxes ?? {}) },
  };
}

interface ApplyResult {
  added_ids: string[];
  updated_ids: string[];
}

// Pure merge: applies an extraction result to an in-memory entities array.
// Exported for the optimistic retry loop AND the test surface. Mutates
// `entities` in place. The lowercase-name index is rebuilt incrementally
// so renames/aliases produced earlier in the same payload are visible to
// later entries.
function applyExtractionToEntities(
  entities: EntityDoc[],
  nodeId: string,
  result: EntityExtractionResult,
  now: Date
): ApplyResult {
  const byNameLower = new Map<string, EntityDoc>();
  const indexEntity = (e: EntityDoc) => {
    byNameLower.set(e.name.toLowerCase(), e);
    for (const a of e.aliases) byNameLower.set(a.toLowerCase(), e);
  };
  // Drop stale keys that previously pointed to `entity` but are no longer
  // among its name/aliases. Necessary after a mid-payload rename so a
  // later entry mentioning the OLD name doesn't collapse into the
  // renamed record by accident.
  const reindexEntity = (entity: EntityDoc, oldKeys: string[]) => {
    for (const k of oldKeys) {
      if (byNameLower.get(k) === entity) byNameLower.delete(k);
    }
    indexEntity(entity);
  };
  // Phase 7b — tombstoned entries DO go into the index so the extractor's
  // re-add path can be silently suppressed (see `added` loop below). But
  // they do NOT get presence pings or facts merges; the user explicitly
  // deleted them.
  for (const e of entities) indexEntity(e);

  const added_ids: string[] = [];
  const updated_ids = new Set<string>();

  for (const u of result.updated) {
    const target = byNameLower.get(u.match_name.toLowerCase());
    if (u.confidence < MIN_ADDED_CONFIDENCE && !target?.pinned_by_user) continue;
    if (!target) continue;
    // Phase 7b — tombstoned matches are silently suppressed. The user
    // deleted them; presence pings would defeat the whole point of
    // soft-delete.
    if (target.deleted_at) continue;
    const prevName = target.name;
    const prevAliases = target.aliases;
    applyUpdate(target, u, nodeId, now);
    if (target.name !== prevName || target.aliases !== prevAliases) {
      const oldKeys = [
        prevName.toLowerCase(),
        ...prevAliases.map((a) => a.toLowerCase()),
      ];
      reindexEntity(target, oldKeys);
    }
    updated_ids.add(target.id);
  }

  for (const a of result.added) {
    if (a.confidence < MIN_ADDED_CONFIDENCE) continue;
    const existingMatch = byNameLower.get(a.name.toLowerCase());
    if (existingMatch) {
      // Tombstone wins: re-add by the same name is suppressed (the
      // whole point of soft-delete is to break the whack-a-mole loop).
      if (existingMatch.deleted_at) continue;
      const prevName = existingMatch.name;
      const prevAliases = existingMatch.aliases;
      reconcileAddedIntoExisting(existingMatch, a, nodeId, now);
      updated_ids.add(existingMatch.id);
      if (
        existingMatch.name !== prevName ||
        existingMatch.aliases !== prevAliases
      ) {
        const oldKeys = [
          prevName.toLowerCase(),
          ...prevAliases.map((al) => al.toLowerCase()),
        ];
        reindexEntity(existingMatch, oldKeys);
      } else {
        indexEntity(existingMatch);
      }
      continue;
    }
    const id = crypto.randomUUID();
    // Even for brand-new entities, route state through the gate so a
    // single hallucinated low-confidence state diff can't seed the
    // registry with non-canonical keys. Pinned bypass doesn't apply
    // (the entity didn't exist before this turn).
    const gatedState = mergeEntityState({}, a.state ?? {}, a.confidence, false);
    const doc: EntityDoc = {
      id,
      kind: a.kind,
      name: a.name,
      aliases: a.aliases ?? [],
      appearance: a.appearance,
      reference_image_url: null,
      facts: (a.facts ?? []).slice(0, MAX_FACTS_PER_ENTITY),
      state: gatedState,
      first_seen_node_id: nodeId,
      last_seen_node_id: nodeId,
      appears_on_node_ids: [nodeId],
      appearance_bboxes: a.bbox ? { [nodeId]: a.bbox } : {},
      pinned_by_user: false,
      confidence: a.confidence,
      updated_at: now,
    };
    entities.push(doc);
    indexEntity(doc);
    added_ids.push(id);
  }

  return { added_ids, updated_ids: Array.from(updated_ids) };
}

// Applies an extractor `updated` entry. Empty `changes` is a deliberate
// presence-ping (see `_coerce_entity_update` in providers/llm.py): the
// entity reappeared but nothing new was observed, so we still bump
// last_seen + appears_on + confidence so the entity stays inside the
// recency-based prior slice on the next page.
function applyUpdate(
  target: EntityDoc,
  update: EntityUpdate,
  nodeId: string,
  now: Date
): void {
  const c = update.changes;
  if (typeof c.name === "string" && c.name.trim() && !target.pinned_by_user) {
    // Don't auto-rename pinned entities; user curation wins.
    target.name = c.name.trim();
  }
  if (Array.isArray(c.aliases)) {
    target.aliases = dedupeStrings([...target.aliases, ...c.aliases]);
  }
  if (typeof c.appearance === "string" && c.appearance.trim() && !target.pinned_by_user) {
    target.appearance = c.appearance.trim();
  }
  if (Array.isArray(c.facts) && c.facts.length) {
    target.facts = dedupeStrings([...target.facts, ...c.facts]).slice(
      0,
      MAX_FACTS_PER_ENTITY
    );
  }
  if (c.state && typeof c.state === "object" && !Array.isArray(c.state)) {
    // Incoming-wins on extractor diffs; user-CRUD merges use target-wins.
    // Documented in mergeEntities so the two policies don't drift again.
    // Phase 7a: gate state writes on confidence + canonical key allow-list.
    target.state = mergeEntityState(
      target.state,
      c.state as EntityState,
      update.confidence,
      target.pinned_by_user
    );
  }
  if (!target.appears_on_node_ids.includes(nodeId)) {
    target.appears_on_node_ids.push(nodeId);
  }
  target.last_seen_node_id = nodeId;
  target.updated_at = now;
  // Confidence drifts upward as the entity is seen again — a strong signal
  // of "yes this is a real recurring entity", which dampens user-delete
  // sweeps that filter on low confidence.
  target.confidence = Math.min(
    1,
    Math.max(target.confidence, update.confidence)
  );
}

// Phase 7a — gated state merge. The previous behaviour was a raw spread:
// any key/value the VLM emitted landed in Mongo and got promoted to a
// sticky cross-page constraint by the planner's CAUSALITY clause. We now
// require enough confidence for a write AND restrict keys to a small
// canonical allow-list. Pinned entities bypass the confidence floor (the
// user explicitly trusts that record), but the key filter still applies
// because the planner only knows how to render canonical keys.
export function mergeEntityState(
  target: EntityState,
  incoming: EntityState,
  confidence: number,
  pinnedTarget: boolean
): EntityState {
  if (!pinnedTarget && confidence < MIN_STATE_WRITE_CONFIDENCE) return target;
  const next: EntityState = { ...target };
  for (const [rawKey, rawValue] of Object.entries(incoming ?? {})) {
    const key = rawKey.trim().toLowerCase();
    if (!key || !CANONICAL_STATE_KEYS.has(key)) {
      // Log once per call so we can grow the allow-list deliberately. In
      // the browser this surfaces in the devtools console; in tests it's
      // silenced by vitest's default reporter.
      if (typeof console !== "undefined" && key) {
        console.warn(
          `[world-memory] dropping non-canonical state key "${key}"`
        );
      }
      continue;
    }
    const value = normaliseStateValue(rawValue);
    if (value === undefined) continue;
    next[key] = value;
  }
  return next;
}

function normaliseStateValue(
  raw: string | number | boolean | undefined
): string | number | boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return raw;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "yes") return true;
  if (lower === "false" || lower === "no") return false;
  // Snap to lowercase for short canonical values so the planner sees
  // "open" not "OPEN" or "Open" — same instruction every time, cleaner
  // prompt-cache behaviour.
  if (trimmed.length <= 24) return lower;
  return trimmed;
}

function reconcileAddedIntoExisting(
  target: EntityDoc,
  added: ExtractedEntity,
  nodeId: string,
  now: Date
): void {
  // Only fill blanks for non-pinned entries; never blow away curated values.
  if (!target.pinned_by_user) {
    if (!target.appearance.trim() && added.appearance.trim()) {
      target.appearance = added.appearance.trim();
    }
  }
  if (added.aliases && added.aliases.length) {
    target.aliases = dedupeStrings([...target.aliases, ...added.aliases]);
  }
  if (added.facts && added.facts.length) {
    target.facts = dedupeStrings([...target.facts, ...added.facts]).slice(
      0,
      MAX_FACTS_PER_ENTITY
    );
  }
  if (added.state) {
    target.state = mergeEntityState(
      target.state,
      added.state as EntityState,
      added.confidence,
      target.pinned_by_user
    );
  }
  if (!target.appears_on_node_ids.includes(nodeId)) {
    target.appears_on_node_ids.push(nodeId);
  }
  if (added.bbox) {
    target.appearance_bboxes = {
      ...target.appearance_bboxes,
      [nodeId]: added.bbox,
    };
  }
  target.last_seen_node_id = nodeId;
  target.updated_at = now;
  target.confidence = Math.min(1, Math.max(target.confidence, added.confidence));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Continuity injection (Phase 3) ----------------------------------------
// Pure scoring exposed so the test suite can exercise it without a
// MongoDB. Higher score = more relevant to the upcoming generation.
// Inputs are all the lowercase tokens from the query / click subject /
// parent caption joined; an entity scores when its name or any alias
// appears as a whole-word match. Pinned entries get an inclusion floor
// so user-curated characters always survive into the planner context.
export function scoreEntitiesForContinuity(
  entities: Entity[],
  hintText: string,
  parentNodeId: string | null
): Entity[] {
  if (entities.length === 0) return [];
  const hint = (hintText ?? "").toLowerCase();
  const wholeWordMatch = (needle: string): boolean => {
    if (!needle) return false;
    const n = needle.toLowerCase();
    if (!hint.includes(n)) return false;
    const idx = hint.indexOf(n);
    const before = idx === 0 ? "" : hint[idx - 1] ?? "";
    const after =
      idx + n.length >= hint.length ? "" : hint[idx + n.length] ?? "";
    const isBoundary = (c: string) => !c || !/[a-z0-9]/i.test(c);
    return isBoundary(before) && isBoundary(after);
  };
  type Scored = Entity & { _score: number };
  const scored: Scored[] = entities.map((e) => {
    let score = 0;
    if (wholeWordMatch(e.name)) score += 1.0;
    if (e.aliases.some(wholeWordMatch)) score += 0.6;
    // Entity was on the parent page → there's a real chance the click
    // target is leading into a sub-view that should preserve it.
    if (parentNodeId && e.last_seen_node_id === parentNodeId) score += 0.5;
    if (parentNodeId && e.appears_on_node_ids.includes(parentNodeId)) {
      score += 0.3;
    }
    if (e.pinned_by_user) score += 0.8;
    return { ...e, _score: score };
  });
  // Drop entities with no signal at all; they'd just add noise to the
  // planner. Pinned entries already cleared the floor via the pin boost.
  // Recency is a tiebreaker AFTER signal-gating, not an inclusion driver
  // on its own — a fresh-but-irrelevant entity should not get shipped
  // just because its updated_at is recent.
  const survivors = scored.filter((e) => e._score > 0);
  for (const e of survivors) {
    e._score += Math.min(
      0.1,
      0.1 * Math.exp(-ageHoursFromIso(e.updated_at) / 24)
    );
  }
  return survivors.sort((a, b) => b._score - a._score);
}

function ageHoursFromIso(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 1_000_000;
  return (Date.now() - t) / 3_600_000;
}

function entityToContext(e: Entity): WorldContextEntity {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: e.aliases,
    appearance: e.appearance,
    reference_image_url: e.reference_image_url ?? null,
    state: e.state,
  };
}

/**
 * Resolve the slim slice of the session's world_state to ship into the
 * planner for continuity injection. Pulled by the /api/generate-page
 * proxy before forwarding the request upstream. Best-effort: returns
 * `[]` when the session has no registry yet or the DB is unreachable.
 */
export async function resolveEntitiesForPrompt(args: {
  sessionId: string;
  query: string;
  parentTitle?: string | null;
  parentQuery?: string | null;
  parentNodeId?: string | null;
}): Promise<WorldContextEntity[]> {
  try {
    const col = await collection();
    const doc = await col.findOne(
      { _id: args.sessionId },
      { projection: { entities: 1 } }
    );
    if (!doc || !doc.entities || doc.entities.length === 0) return [];
    // Tombstoned entities never get injected into the planner's
    // continuity context — that would make a deleted character pop
    // back into the next page's prompt.
    const liveDocs = doc.entities.filter((e) => !e.deleted_at);
    if (liveDocs.length === 0) return [];
    const entitiesAsWire = liveDocs.map(entityDocToWire);
    const hint = [
      args.query,
      args.parentTitle ?? "",
      args.parentQuery ?? "",
    ]
      .filter(Boolean)
      .join("\n");
    const scored = scoreEntitiesForContinuity(
      entitiesAsWire,
      hint,
      args.parentNodeId ?? null
    );
    return scored.slice(0, MAX_CONTINUITY_ENTITIES).map(entityToContext);
  } catch {
    return [];
  }
}

function entityDocToWire(doc: EntityDoc): Entity {
  return entityToWire(doc);
}

// User-override helpers --------------------------------------------------
// Land the shapes now so Phase 5 wire-up is purely a route addition; merge
// logic lives in one place.

export async function pinEntity(
  sessionId: string,
  entityId: string,
  pinned: boolean
): Promise<WorldStateSnapshot> {
  return mutate(sessionId, (entities) => {
    const target = entities.find((e) => e.id === entityId);
    if (target) {
      target.pinned_by_user = pinned;
      target.updated_at = new Date();
    }
  });
}

export async function renameEntity(
  sessionId: string,
  entityId: string,
  name: string,
  aliases: string[] | null
): Promise<WorldStateSnapshot> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name cannot be empty");
  return mutate(sessionId, (entities) => {
    const target = entities.find((e) => e.id === entityId);
    if (!target) return;
    // Demote the previous primary name into aliases so the extractor's
    // earlier match_name keys still resolve on the next page.
    const existingAliases = aliases ?? target.aliases;
    target.aliases = dedupeStrings([
      ...existingAliases,
      target.name,
    ]).filter((a) => a.toLowerCase() !== trimmed.toLowerCase());
    target.name = trimmed;
    target.updated_at = new Date();
  });
}

export async function deleteEntity(
  sessionId: string,
  entityId: string
): Promise<WorldStateSnapshot> {
  // Phase 7b — soft-delete. The previous hard-splice triggered a whack-
  // a-mole loop: extractor re-discovered the entity on the next page,
  // user deleted again, repeat. Tombstoning keeps the name + aliases in
  // the in-payload index so the extractor's re-add gets silently
  // suppressed.
  return mutate(sessionId, (entities) => {
    const target = entities.find((e) => e.id === entityId);
    if (target) {
      target.deleted_at = new Date();
      target.updated_at = new Date();
    }
  });
}

export async function undoDeleteEntity(
  sessionId: string,
  entityId: string
): Promise<WorldStateSnapshot> {
  // Restores a tombstoned entity. Powers the codex's "Undo" toast after
  // a delete; also reachable via the WorldEntityMutation wire as
  // `undo_delete`.
  return mutate(sessionId, (entities) => {
    const target = entities.find((e) => e.id === entityId);
    if (target) {
      target.deleted_at = null;
      target.updated_at = new Date();
    }
  });
}

export async function setEntityAppearance(
  sessionId: string,
  entityId: string,
  appearance: string,
  referenceImageUrl: string | null
): Promise<WorldStateSnapshot> {
  const trimmed = appearance.trim();
  if (!trimmed) throw new Error("appearance cannot be empty");
  return mutate(sessionId, (entities) => {
    const target = entities.find((e) => e.id === entityId);
    if (!target) return;
    target.appearance = trimmed;
    if (referenceImageUrl !== undefined) {
      target.reference_image_url = referenceImageUrl;
    }
    target.updated_at = new Date();
  });
}

export async function mergeEntities(
  sessionId: string,
  sourceId: string,
  targetId: string
): Promise<WorldStateSnapshot> {
  if (sourceId === targetId) {
    return getWorldState(sessionId);
  }
  return mutate(sessionId, (entities) => {
    const target = entities.find((e) => e.id === targetId);
    const sourceIdx = entities.findIndex((e) => e.id === sourceId);
    const source = sourceIdx >= 0 ? entities[sourceIdx] : undefined;
    if (!target || !source) return;
    target.aliases = dedupeStrings([
      ...target.aliases,
      source.name,
      ...source.aliases,
    ]);
    target.facts = dedupeStrings([...target.facts, ...source.facts]).slice(
      0,
      MAX_FACTS_PER_ENTITY
    );
    // Unified state-merge policy: later writes win on the same key. The
    // extractor's "updated" diff uses incoming-wins, so consolidations
    // here use source-then-target (target's curated state wins by being
    // applied last). Documented so applyUpdate vs mergeEntities don't
    // drift again.
    target.state = { ...source.state, ...target.state };
    for (const nid of source.appears_on_node_ids) {
      if (!target.appears_on_node_ids.includes(nid)) {
        target.appears_on_node_ids.push(nid);
      }
    }
    // Pin propagation: if either record was user-pinned, the survivor is
    // pinned. Losing curation flags via a merge would be a silent
    // regression of explicit user intent.
    if (source.pinned_by_user) target.pinned_by_user = true;
    target.updated_at = new Date();
    entities.splice(sourceIdx, 1);
  });
}

// Read-modify-write with optimistic concurrency. Same retry budget as
// mergeExtraction so a rename racing an extraction call doesn't silently
// lose either edit. Same first-write fix: insertOne with duplicate-key
// recovery instead of an unfiltered upsert.
async function mutate(
  sessionId: string,
  fn: (entities: EntityDoc[]) => void
): Promise<WorldStateSnapshot> {
  const col = await collection();
  let attempt = 0;
  while (true) {
    const existing = await col.findOne({ _id: sessionId });
    const entities = existing ? existing.entities.map(cloneEntity) : [];
    fn(entities);
    const now = new Date();
    const next: WorldStateDoc = {
      _id: sessionId,
      entities,
      updated_at: now,
      schema_version: SCHEMA_VERSION,
    };

    let ok = false;
    if (existing) {
      const write = await col.replaceOne(
        { _id: sessionId, updated_at: existing.updated_at },
        next
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
        `world.mutate: optimistic concurrency retry exhausted for session ${sessionId}`
      );
    }
  }
}

// Test surface — small wrappers used by unit tests so we don't have to spin
// up MongoDB in CI. Both `applyExtractionToEntities` (pure merge for
// extraction) and `mergeEntitiesPure` (in-memory shape of the merge-CRUD
// operation) are exposed so the database-bound code paths can stay thin.
export const __test = {
  scoreEntitiesForContinuity,
  mergeIntoEntities(
    existing: EntityDoc[],
    nodeId: string,
    result: EntityExtractionResult
  ): {
    entities: EntityDoc[];
    added_ids: string[];
    updated_ids: string[];
  } {
    const entities = existing.map(cloneEntity);
    const now = new Date();
    const out = applyExtractionToEntities(entities, nodeId, result, now);
    return {
      entities,
      added_ids: out.added_ids,
      updated_ids: out.updated_ids,
    };
  },
  mergeEntitiesPure(
    existing: EntityDoc[],
    sourceId: string,
    targetId: string
  ): EntityDoc[] {
    const entities = existing.map(cloneEntity);
    const target = entities.find((e) => e.id === targetId);
    const sourceIdx = entities.findIndex((e) => e.id === sourceId);
    const source = sourceIdx >= 0 ? entities[sourceIdx] : undefined;
    if (!target || !source) return entities;
    target.aliases = dedupeStrings([
      ...target.aliases,
      source.name,
      ...source.aliases,
    ]);
    target.facts = dedupeStrings([...target.facts, ...source.facts]).slice(
      0,
      MAX_FACTS_PER_ENTITY
    );
    target.state = { ...source.state, ...target.state };
    for (const nid of source.appears_on_node_ids) {
      if (!target.appears_on_node_ids.includes(nid)) {
        target.appears_on_node_ids.push(nid);
      }
    }
    if (source.pinned_by_user) target.pinned_by_user = true;
    target.updated_at = new Date();
    entities.splice(sourceIdx, 1);
    return entities;
  },
  makeEntity(overrides: Partial<EntityDoc>): EntityDoc {
    const now = new Date();
    return {
      id: overrides.id ?? "fixed-id",
      kind: overrides.kind ?? "person",
      name: overrides.name ?? "Mira",
      aliases: overrides.aliases ?? [],
      appearance: overrides.appearance ?? "tall keeper",
      reference_image_url: overrides.reference_image_url ?? null,
      facts: overrides.facts ?? [],
      state: overrides.state ?? {},
      first_seen_node_id: overrides.first_seen_node_id ?? "node-1",
      last_seen_node_id: overrides.last_seen_node_id ?? "node-1",
      appears_on_node_ids: overrides.appears_on_node_ids ?? ["node-1"],
      appearance_bboxes: overrides.appearance_bboxes ?? {},
      pinned_by_user: overrides.pinned_by_user ?? false,
      confidence: overrides.confidence ?? 0.7,
      updated_at: overrides.updated_at ?? now,
      deleted_at: overrides.deleted_at ?? null,
    };
  },
};
