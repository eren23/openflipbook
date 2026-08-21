import { NextResponse } from "next/server";

import { forkSession } from "@/lib/fork";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** Fork a session into a fresh one the caller can extend as their own.
 * Openness matches the existing share surfaces: anyone who can reach a
 * session (a /n/ link, ?continue=) can fork it — forking is the SAFER
 * alternative to ?continue=, which grants write access to the original.
 * The fork starts unowned (the forker's first write claims it) and
 * unpublished. $0: Mongo doc copies, images by R2 reference. */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 }
    );
  }
  let nodeId: string | null = null;
  try {
    const body = (await req.json()) as { node_id?: string };
    nodeId = body.node_id ?? null;
  } catch {
    /* body optional — lineage just loses the page pointer */
  }
  const forked = await forkSession(id, nodeId);
  if (!forked) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json(forked);
}
