import { NextResponse } from "next/server";

import { forkSession } from "@/lib/fork";
import { readServerEnv } from "@/lib/env";
import { getOrCreateOwnerToken } from "@/lib/session-owner";
import { checkCreatorOrigin, checkCreatorWrite, CreatorError, creatorJson } from "@/lib/creator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** Fork a session into a fresh one the caller can extend as their own.
 * Openness matches the existing share surfaces: anyone who can reach a
 * session (a /n/ link, ?continue=) can fork it — forking is the SAFER
 * alternative to ?continue=, which grants write access to the original.
 * The new copy is immediately owned by the forker and unpublished.
 * $0: Mongo doc copies, images by R2 reference. */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 }
    );
  }
  try {
    checkCreatorOrigin(req);
    let body: { node_id?: string | null; request_id?: string } = {};
    if (req.body) {
      checkCreatorWrite(req);
      const text = await req.text();
      if (text.length > 4096) throw new CreatorError("Fork request is too large", 413);
      try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid fork JSON", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new CreatorError("Invalid fork request", 400);
    }
    await getOrCreateOwnerToken();
    const forked = await forkSession(id, body.node_id ?? null, body.request_id);
    return forked ? creatorJson(forked) : creatorJson({ error: "session not found" }, 404);
  } catch (e) {
    return creatorJson({ error: e instanceof CreatorError ? e.message : "Fork unavailable. Retry the same request." }, e instanceof CreatorError ? e.status : 503);
  }
}
