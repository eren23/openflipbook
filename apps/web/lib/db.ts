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
  await Promise.all([
    nodes.createIndex(
      { session_id: 1, created_at: -1 },
      { name: "session_created_idx" }
    ),
    nodes.createIndex({ parent_id: 1 }, { name: "parent_idx" }),
  ]);
}

async function nodes(): Promise<Collection<NodeDoc>> {
  return (await connect()).collection<NodeDoc>("nodes");
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
  created_at: string;
}

function toRow(doc: NodeDoc): NodeRow {
  const { _id, created_at, ...rest } = doc;
  return { id: _id, ...rest, created_at: created_at.toISOString() };
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

export async function listNodesBySession(
  sessionId: string,
  limit = 50
): Promise<NodeRow[]> {
  const collection = await nodes();
  const docs = await collection
    .find({ session_id: sessionId })
    .sort({ created_at: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toRow);
}
