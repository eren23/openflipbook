import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { readServerEnv, requireMongo } from "./env";

declare global {
  var __endlessCanvasMongo: { client: MongoClient; db: Db } | undefined;
}

async function connect(): Promise<Db> {
  if (globalThis.__endlessCanvasMongo) {
    return globalThis.__endlessCanvasMongo.db;
  }
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
}

async function ensureIndexes(db: Db): Promise<void> {
  const nodes = db.collection<NodeDoc>("nodes");
  const errors = db.collection<ErrorDoc>("errors");
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
  ]);
}

async function nodes(): Promise<Collection<NodeDoc>> {
  return (await connect()).collection<NodeDoc>("nodes");
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
  created_at: Date;
}

export interface NodeInsert {
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
  created_at: string;
}

function toRow(doc: NodeDoc): NodeRow {
  const { _id, created_at, click_in_parent, sources, ...rest } = doc;
  return {
    id: _id,
    ...rest,
    click_in_parent: click_in_parent ?? null,
    sources: Array.isArray(sources) ? sources : [],
    created_at: created_at.toISOString(),
  };
}

export async function insertNode(n: NodeInsert): Promise<NodeRow> {
  const collection = await nodes();
  const doc: NodeDoc = {
    _id: crypto.randomUUID(),
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
  const db = await connect();
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
  const db = await connect();
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
