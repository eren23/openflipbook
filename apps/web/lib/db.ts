import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import type { ScaleTier, SceneView } from "@openflipbook/config";
import { readServerEnv, requireMongo } from "./env";

declare global {
  // Singleton pool sentinel. Both `lib/db.ts` and `lib/world.ts` share this
  // — they MUST go through `getDb()` here so the index-init runs exactly
  // once per Node worker regardless of which module gets called first on a
  // cold start. Earlier we had two duplicate sentinels; whichever module
  // won the race would skip the other's index init.
  var __endlessCanvasMongo: { client: MongoClient; db: Db } | undefined;
  // In-flight bootstrap promise. Memoised so concurrent first callers
  // (e.g. two parallel SSE routes hitting the worker right after cold
  // start) share one client + one ensureIndexes call. Without this the
  // un-memoised `if (!globalThis.__endlessCanvasMongo) connect()` opens
  // two MongoClients per worker and runs ensureIndexes twice on the same
  // collection.
  var __endlessCanvasMongoBootstrap: Promise<Db> | undefined;
}

/** Shared Mongo handle. Lazily connects, registers indexes once. */
export async function getDb(): Promise<Db> {
  if (globalThis.__endlessCanvasMongo) {
    return globalThis.__endlessCanvasMongo.db;
  }
  if (globalThis.__endlessCanvasMongoBootstrap) {
    return globalThis.__endlessCanvasMongoBootstrap;
  }
  const bootstrap = (async () => {
    const cfg = requireMongo(readServerEnv());
    const client = new MongoClient(cfg.uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    const db = client.db(cfg.db);
    await ensureIndexes(db);
    globalThis.__endlessCanvasMongo = { client, db };
    return db;
  })();
  globalThis.__endlessCanvasMongoBootstrap = bootstrap;
  try {
    return await bootstrap;
  } finally {
    // Once settled, drop the in-flight memo so a later transient failure
    // (e.g. process recovers from a network blip) can retry. The
    // happy-path returns above via `__endlessCanvasMongo` and never
    // hits this branch again.
    globalThis.__endlessCanvasMongoBootstrap = undefined;
  }
}

async function ensureIndexes(db: Db): Promise<void> {
  const nodes = db.collection<NodeDoc>("nodes");
  const errors = db.collection<ErrorDoc>("errors");
  const world = db.collection("world_state");
  // Geometric world model — per-session map of entity coordinates. `_id` is the
  // session id (auto-indexed); the sparse secondary index supports atlas anchor
  // lookups that link a map entity back to its Codex Entity. Created up front so
  // we don't migrate a populated collection later.
  const worldMap = db.collection("world_map");
  await Promise.all([
    nodes.createIndex(
      { session_id: 1, created_at: -1 },
      { name: "session_created_idx" }
    ),
    nodes.createIndex({ parent_id: 1 }, { name: "parent_idx" }),
    nodes.createIndex(
      { parent_id: 1, created_at: -1 },
      { name: "parent_created_idx" }
    ),
    errors.createIndex({ ts: -1 }, { name: "errors_ts_idx" }),
    // World-memory layer. `_id` is the session id (auto-indexed). The secondary
    // index supports atlas-overlay queries; created eagerly to avoid migrating a
    // populated collection later.
    world.createIndex(
      { "entities.appears_on_node_ids": 1 },
      { name: "world_entity_appears_idx", sparse: true }
    ),
    worldMap.createIndex(
      { "entities.entity_id": 1 },
      { name: "world_map_entity_idx", sparse: true }
    ),
  ]);
}

async function nodes(): Promise<Collection<NodeDoc>> {
  return (await getDb()).collection<NodeDoc>("nodes");
}

export interface ClickInParent {
  x_pct: number;
  y_pct: number;
}

export interface NodeSource {
  url: string;
  title: string | null;
}

export interface NodeDoc extends Document {
  _id: string;
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_key: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string | null;
  click_in_parent: ClickInParent | null;
  // Web-search citations the planner used. Backwards-compatible: missing on
  // pre-citations nodes and treated as []. Domain-deduped, max ~3.
  sources?: NodeSource[] | null;
  // M3 scale-space: how this node relates to its parent ("descend" = tap-in /
  // default, "expand" = bloomed neighbour, "ascend" = OUTWARD container) + its
  // size vs the parent's focal subject. Optional + defaulted for back-compat.
  relation?: "descend" | "expand" | "ascend" | null;
  scale?: "component" | "peer" | "container" | null;
  // B2 scale ladder: the coarse absolute rung this node's frame sits at.
  // Optional + null for pre-B2 rows.
  scale_tier?: ScaleTier | null;
  // Geometric world (GEOMETRIC_WORLD): the observer pose + view level this
  // scene was rendered from. Optional + null for pre-geometry / classic nodes.
  scene_view?: SceneView | null;
  created_at: Date;
}

export interface NodeInsert {
  // Optional caller-supplied id (default: a fresh UUID). Lets the OUTWARD reparent
  // build the new parent's self-referential scene_view.node_id before inserting.
  id?: string;
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_key: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string | null;
  click_in_parent?: ClickInParent | null;
  sources?: NodeSource[] | null;
  relation?: "descend" | "expand" | "ascend" | null;
  scale?: "component" | "peer" | "container" | null;
  scale_tier?: ScaleTier | null;
  scene_view?: SceneView | null;
}

export interface NodeRow {
  id: string;
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_key: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string | null;
  click_in_parent: ClickInParent | null;
  sources: NodeSource[];
  relation: "descend" | "expand" | "ascend";
  scale: "component" | "peer" | "container";
  scale_tier: ScaleTier | null;
  // The observer pose + view level this node was rendered from. Null on
  // pre-geometry / classic nodes. Read back on revisit so the minimap scopes to
  // the right frame and the entered angle is reproducible.
  scene_view: SceneView | null;
  created_at: string;
}

export function toRow(doc: NodeDoc): NodeRow {
  const {
    _id,
    created_at,
    click_in_parent,
    sources,
    relation,
    scale,
    scale_tier,
    scene_view,
    ...rest
  } = doc;
  return {
    id: _id,
    ...rest,
    click_in_parent: click_in_parent ?? null,
    sources: Array.isArray(sources) ? sources : [],
    relation: relation ?? "descend",
    scale: scale ?? "peer",
    scale_tier: scale_tier ?? null,
    scene_view: scene_view ?? null,
    created_at: created_at.toISOString(),
  };
}

export async function insertNode(n: NodeInsert): Promise<NodeRow> {
  const collection = await nodes();
  const doc: NodeDoc = {
    _id: n.id ?? crypto.randomUUID(),
    parent_id: n.parent_id,
    session_id: n.session_id,
    query: n.query,
    page_title: n.page_title,
    image_key: n.image_key,
    image_model: n.image_model,
    prompt_author_model: n.prompt_author_model,
    aspect_ratio: n.aspect_ratio,
    final_prompt: n.final_prompt,
    click_in_parent: n.click_in_parent ?? null,
    sources: n.sources ?? null,
    relation: n.relation ?? "descend",
    scale: n.scale ?? "peer",
    scale_tier: n.scale_tier ?? null,
    scene_view: n.scene_view ?? null,
    created_at: new Date(),
  };
  await collection.insertOne(doc);
  return toRow(doc);
}

export async function getNode(id: string): Promise<NodeRow | null> {
  const collection = await nodes();
  const doc = await collection.findOne({ _id: id });
  return doc ? toRow(doc) : null;
}

/** Re-point an existing node's parent — the ONLY mutate path on the nodes
 *  collection, for the OUTWARD reparent (re-root the old root under a synthesized
 *  parent). A single-field `$set` on one doc, atomic in Mongo. Returns whether the
 *  node existed. Deliberately narrow (parent_id only) so it can't be misused to
 *  rewrite arbitrary topology. */
export async function updateNodeParent(id: string, parentId: string | null): Promise<boolean> {
  const collection = await nodes();
  const res = await collection.updateOne({ _id: id }, { $set: { parent_id: parentId } });
  return res.matchedCount === 1;
}

/** Delete a node by id — used only to roll back an orphaned parent P when an
 *  OUTWARD reparent aborts after inserting P but before re-pointing the child. */
export async function deleteNode(id: string): Promise<boolean> {
  const collection = await nodes();
  const res = await collection.deleteOne({ _id: id });
  return res.deletedCount === 1;
}

export interface ListNodesResult {
  rows: NodeRow[];
  next_cursor: string | null;
}

export async function listNodesByParent(
  parentId: string,
  opts: { limit?: number } = {}
): Promise<NodeRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const collection = await nodes();
  const docs = await collection
    .find({ parent_id: parentId })
    .sort({ created_at: 1, _id: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toRow);
}

export async function listNodesBySession(
  sessionId: string,
  opts: { cursor?: string | null; limit?: number } = {}
): Promise<ListNodesResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const collection = await nodes();
  const filter: Record<string, unknown> = { session_id: sessionId };
  // Cursor format: "<iso_ts>|<_id>" — `_id` is a UUID tiebreaker so two
  // documents inserted within the same millisecond don't get skipped on
  // page boundaries. Old-format cursors (no pipe, ISO only) are accepted
  // for forward-compat; they fall back to the original $gt-on-timestamp
  // filter and may miss ms-tied rows.
  if (opts.cursor) {
    const [tsPart, idPart] = opts.cursor.split("|");
    const cursorDate = new Date(tsPart ?? opts.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      if (idPart) {
        filter.$or = [
          { created_at: { $gt: cursorDate } },
          { created_at: cursorDate, _id: { $gt: idPart } },
        ];
      } else {
        filter.created_at = { $gt: cursorDate };
      }
    }
  }
  const docs = await collection
    .find(filter)
    .sort({ created_at: 1, _id: 1 })
    .limit(limit)
    .toArray();
  const rows = docs.map(toRow);
  const lastDoc = docs[docs.length - 1];
  const next_cursor =
    docs.length === limit && lastDoc
      ? `${lastDoc.created_at.toISOString()}|${lastDoc._id}`
      : null;
  return { rows, next_cursor };
}

export interface ErrorDoc extends Document {
  _id?: string;
  trace_id: string | null;
  ts: Date;
  kind: string;
  message: string;
  stack?: string | null;
  body_excerpt?: string | null;
  source: "client" | "backend";
}

export interface ErrorRow {
  trace_id: string | null;
  ts: string;
  kind: string;
  message: string;
  stack: string | null;
  body_excerpt: string | null;
  source: "client" | "backend";
}

export async function recordError(input: Omit<ErrorRow, "ts">): Promise<void> {
  const db = await getDb();
  const collection = db.collection<ErrorDoc>("errors");
  await collection.insertOne({
    _id: crypto.randomUUID(),
    trace_id: input.trace_id,
    ts: new Date(),
    kind: input.kind,
    message: input.message,
    stack: input.stack ?? null,
    body_excerpt: input.body_excerpt ?? null,
    source: input.source,
  });
}

export async function listRecentErrors(limit = 50): Promise<ErrorRow[]> {
  const db = await getDb();
  const collection = db.collection<ErrorDoc>("errors");
  const docs = await collection
    .find({})
    .sort({ ts: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
  return docs.map((doc) => ({
    trace_id: doc.trace_id ?? null,
    ts: doc.ts.toISOString(),
    kind: doc.kind,
    message: doc.message,
    stack: doc.stack ?? null,
    body_excerpt: doc.body_excerpt ?? null,
    source: doc.source,
  }));
}
