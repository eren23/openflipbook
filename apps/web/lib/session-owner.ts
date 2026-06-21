import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { Collection, Document } from "mongodb";

import { getDb } from "./db";
import { isSafeId } from "./ids";

/**
 * Lightweight session ownership — the invisible alternative to a login wall.
 *
 * The first writer to a session is handed an unguessable `ofb_owner` token in an
 * httpOnly cookie and recorded as the owner in `session_owners`. Every later
 * MUTATION (and cost-incurring call) on that session must present the matching
 * cookie. Reads of session CONTENT stay open — permalinks + the public gallery
 * are an intended feature (unlisted-link sharing), so locking reads would break
 * UX; the threat this closes is cross-tenant WRITES / poisoning / griefing /
 * stranger cost-abuse, not viewing.
 *
 * Legacy sessions (created before this existed) have no owner doc → the first
 * caller after deploy claims them (the grandfather path).
 */

const OWNER_COOKIE = "ofb_owner";
const ONE_YEAR_S = 60 * 60 * 24 * 365;
const COLLECTION = "session_owners";

interface OwnerDoc extends Document {
  _id: string; // sessionId
  owner_token: string;
  created_at: Date;
}

async function owners(): Promise<Collection<OwnerDoc>> {
  return (await getDb()).collection<OwnerDoc>(COLLECTION);
}

/** Ownership needs a persistent store; without Mongo there's nothing to own. */
function ownershipStoreConfigured(): boolean {
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
 * Atomically claim the session for `token` if unowned, else verify ownership.
 * Returns "ok" (owner or freshly claimed) or "forbidden" (owned by someone else).
 */
export async function claimOrVerify(
  sessionId: string,
  token: string,
): Promise<"ok" | "forbidden"> {
  const col = await owners();
  try {
    // Insert-if-absent is the atomic claim — a concurrent claim loses on the
    // unique _id and falls through to the verify below.
    await col.insertOne({
      _id: sessionId,
      owner_token: token,
      created_at: new Date(),
    });
    return "ok";
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  const doc = await col.findOne({ _id: sessionId });
  if (!doc) return "ok"; // lost a delete race — treat as claimable
  return doc.owner_token === token ? "ok" : "forbidden";
}

export type OwnerCheck =
  | { ok: true }
  | { ok: false; res: NextResponse };

/**
 * Gate a mutation/cost route on session ownership. Reads (or mints) the
 * `ofb_owner` cookie, claims/verifies the session, and sets the cookie on the
 * outgoing response (Next sets it automatically from the route handler). Returns
 * `{ ok: true }` to proceed or `{ ok: false, res }` with the 403/400 to return.
 */
export async function requireOwner(sessionId: string): Promise<OwnerCheck> {
  if (!isSafeId(sessionId)) {
    return {
      ok: false,
      res: NextResponse.json({ error: "invalid session id" }, { status: 400 }),
    };
  }
  // No store configured → nothing is persisted to own, so ownership can't (and
  // needn't) be enforced. Don't crash the no-persistence demo mode.
  if (!ownershipStoreConfigured()) return { ok: true };
  const store = await cookies();
  let token = store.get(OWNER_COOKIE)?.value ?? null;
  if (!token) {
    token = crypto.randomUUID();
    store.set(OWNER_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: ONE_YEAR_S,
    });
  }
  const verdict = await claimOrVerify(sessionId, token);
  if (verdict === "forbidden") {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "this session belongs to another browser" },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

/**
 * Verify ownership WITHOUT claiming or setting a cookie — for routes that return
 * a STREAMING response (generate-page), where a Set-Cookie may not reliably
 * reach the browser. An UNOWNED session is allowed (the claim + cookie happen on
 * the first non-streaming write, /api/nodes); an owned session requires the
 * matching cookie. Net: a stranger can't generate into someone else's existing
 * session, and the absolute cost is still bounded by the spend caps.
 */
export async function verifyOwnerReadonly(sessionId: string): Promise<OwnerCheck> {
  if (!isSafeId(sessionId)) {
    return {
      ok: false,
      res: NextResponse.json({ error: "invalid session id" }, { status: 400 }),
    };
  }
  if (!ownershipStoreConfigured()) return { ok: true };
  const store = await cookies();
  const token = store.get(OWNER_COOKIE)?.value ?? null;
  const doc = await (await owners()).findOne({ _id: sessionId });
  if (!doc) return { ok: true }; // unowned (new/legacy) — claimed on first write
  if (token && doc.owner_token === token) return { ok: true };
  return {
    ok: false,
    res: NextResponse.json(
      { error: "this session belongs to another browser" },
      { status: 403 },
    ),
  };
}
