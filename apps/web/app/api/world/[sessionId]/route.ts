import { NextResponse } from "next/server";
import { getWorldState } from "@/lib/world";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// Mirrors the same env-flag check on the entity-CRUD route. Surfaced on
// the snapshot so the codex can hide / show edit controls based on the
// deployment's posture without each consumer re-deriving it.
function overridesEnabled(): boolean {
  const flag = (process.env.WORLD_OVERRIDE_ENABLED ?? "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

// Hydrate the world-memory registry for a session. Used by the codex panel
// on mount and by /n/[id] permalink replay. Returns an empty snapshot
// (entities=[]) when persistence is misconfigured or the session has no
// extracted entities yet — keeps the codex surface inert rather than erroring.
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      {
        session_id: sessionId,
        entities: [],
        updated_at: new Date(0).toISOString(),
        persistence_disabled: true,
        override_enabled: false,
      },
      { status: 200 }
    );
  }
  try {
    const snapshot = await getWorldState(sessionId);
    return NextResponse.json({
      ...snapshot,
      override_enabled: overridesEnabled(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 }
    );
  }
}
