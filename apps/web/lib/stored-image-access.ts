import { getDb } from "./db";
import { CreatorError } from "./creator-error";
import { isSafeId } from "./ids";
import { requireWorldRead } from "./world-access";
import { requireCreator } from "./creator";

export function validStoredImageKey(key: string) {
  const parts = key.split("/");
  return key.length <= 2000 && parts.length >= 2 && isSafeId(parts[0])
    && parts.every(part => part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part));
}

// New artifacts live under a creator-world prefix. A legacy node image is
// readable only when a persisted node references it; an unclaimed import or
// upload prefix must never inherit legacy public-link behavior. Owner forks
// may retain immutable images under the original world's storage prefix.
export async function requireStoredImageRead(key: string) {
  if (!validStoredImageKey(key)) throw new CreatorError("Invalid stored image key", 400);
  const db = await getDb(), prefix = key.split("/")[0]!;
  // Sketch sessions own their private source/candidate bytes before any node
  // is accepted, so their durable owner row also claims the storage prefix.
  const metadata = await db.collection<{ _id: string }>("creator_worlds").findOne({ _id: prefix });
  const owner = metadata ? null : await db.collection<{ _id: string }>("session_owners").findOne({ _id: prefix });
  if (metadata || owner) {
    try { if (metadata) await requireWorldRead(prefix); else await requireCreator(prefix); return; }
    catch (error) { if (!(error instanceof CreatorError) || error.status !== 403) throw error; }
  }
  const nodes = await db.collection<{ session_id: string }>("nodes").find({ image_key: key }).limit(501).toArray();
  if (nodes.length > 500) throw new CreatorError("Image reference inventory exceeds its limit", 413);
  for (const sessionId of new Set(nodes.map(node => node.session_id))) {
    try { await requireWorldRead(sessionId); return; }
    catch (error) { if (!(error instanceof CreatorError) || error.status !== 403) throw error; }
  }
  throw new CreatorError("Stored image is unavailable to this browser", 403);
}
