import type { Collection, Document } from "mongodb";

import { getDb } from "./db";

/**
 * Request idempotency — a client retry / double-submit / proxy replay shouldn't
 * re-run the full paid model stack or insert a duplicate node. Backed by a Mongo
 * collection whose `_id` is the (namespaced) Idempotency-Key; the unique `_id`
 * makes the first-claim atomic. No-op when Mongo isn't configured.
 *
 * Keys are namespaced by caller ("gen:" / "node:") so the same trace id can key
 * both a generation dedup and a node-create dedup without colliding.
 */

const COLLECTION = "idempotency_keys";

interface KeyDoc extends Document {
  _id: string;
  result?: unknown;
  created_at: Date;
}

async function keys(): Promise<Collection<KeyDoc>> {
  return (await getDb()).collection<KeyDoc>(COLLECTION);
}

function configured(): boolean {
  return Boolean(process.env.MONGODB_URI && process.env.MONGODB_DB);
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

/**
 * Atomically claim a key. "fresh" = first time (caller should do the work);
 * "duplicate" = already seen (caller should refuse / return the cached result).
 * Fails OPEN ("fresh") when Mongo isn't configured.
 */
export async function claimIdempotencyKey(
  key: string,
): Promise<"fresh" | "duplicate"> {
  if (!configured()) return "fresh";
  try {
    await (await keys()).insertOne({ _id: key, created_at: new Date() });
    return "fresh";
  } catch (err) {
    if (isDuplicateKeyError(err)) return "duplicate";
    throw err;
  }
}

/** The cached JSON result for a key, or null if none/unconfigured. */
export async function getIdempotentResult<T>(key: string): Promise<T | null> {
  if (!configured()) return null;
  const doc = await (await keys()).findOne({ _id: key });
  return (doc?.result as T | undefined) ?? null;
}

/** Persist (or claim+persist) the JSON result for a key so a replay returns it. */
export async function saveIdempotentResult(
  key: string,
  result: unknown,
): Promise<void> {
  if (!configured()) return;
  await (await keys()).updateOne(
    { _id: key },
    { $set: { result, created_at: new Date() } },
    { upsert: true },
  );
}
