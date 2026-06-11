import { NextResponse } from "next/server";

import { touchPresence } from "@/lib/db";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

/** Viewer heartbeat: upserts {session, viewer} presence (TTL-expired) and
 * returns the live count. The client beats every ~20s while the tab is on
 * the session. */
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 },
    );
  }
  let viewerId = "";
  try {
    const body = (await req.json()) as { viewer_id?: string };
    viewerId = (body.viewer_id ?? "").slice(0, 64);
  } catch {
    // fall through to the validation below
  }
  if (!viewerId) {
    return NextResponse.json({ error: "missing viewer_id" }, { status: 400 });
  }
  const viewers = await touchPresence(sessionId, viewerId);
  return NextResponse.json({ viewers });
}
