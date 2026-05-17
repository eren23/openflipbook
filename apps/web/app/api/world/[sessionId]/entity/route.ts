import { NextResponse } from "next/server";
import {
  deleteEntity,
  mergeEntities,
  pinEntity,
  renameEntity,
  setEntityAppearance,
  undoDeleteEntity,
} from "@/lib/world";
import { readServerEnv } from "@/lib/env";
import type { WorldEntityMutation } from "@openflipbook/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// User-override CRUD on the codex. Phase 5 of the world-memory plan
// (pin/rename/merge/delete) lands the wire surface here; the UI hook-ups
// land alongside the codex panel editing surface. Endpoint exists now so
// the read surface (Phase 2) can rely on a stable shape.
//
// Gated behind `WORLD_OVERRIDE_ENABLED` until Phase 5 adds proper auth.
// Today the only "auth" is knowing a session id (sessions are user-scoped
// but ids are guessable on a deployed instance), and these mutations
// (rename / merge / delete / pin) are destructive enough that we don't
// want them callable on a production deploy by accident. Local dev sets
// the flag in `.env.local` to iterate on the UI.
function overridesEnabled(): boolean {
  const flag = (process.env.WORLD_OVERRIDE_ENABLED ?? "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!overridesEnabled()) {
    return NextResponse.json(
      {
        error:
          "world override CRUD is disabled; set WORLD_OVERRIDE_ENABLED=1 to enable (Phase 5)",
      },
      { status: 403 }
    );
  }
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "MongoDB persistence is not configured" },
      { status: 503 }
    );
  }
  let mutation: WorldEntityMutation;
  try {
    mutation = (await req.json()) as WorldEntityMutation;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    switch (mutation.op) {
      case "rename": {
        const snapshot = await renameEntity(
          sessionId,
          mutation.id,
          mutation.name,
          mutation.aliases ?? null
        );
        return NextResponse.json(snapshot);
      }
      case "merge": {
        const snapshot = await mergeEntities(
          sessionId,
          mutation.source_id,
          mutation.target_id
        );
        return NextResponse.json(snapshot);
      }
      case "delete": {
        const snapshot = await deleteEntity(sessionId, mutation.id);
        return NextResponse.json(snapshot);
      }
      case "undo_delete": {
        const snapshot = await undoDeleteEntity(sessionId, mutation.id);
        return NextResponse.json(snapshot);
      }
      case "pin": {
        const snapshot = await pinEntity(sessionId, mutation.id, mutation.pinned);
        return NextResponse.json(snapshot);
      }
      case "set_appearance": {
        const snapshot = await setEntityAppearance(
          sessionId,
          mutation.id,
          mutation.appearance,
          mutation.reference_image_url ?? null
        );
        return NextResponse.json(snapshot);
      }
      case "create": {
        // Phase 5 won't allow blind user-create without a name; reject early.
        return NextResponse.json(
          { error: "create op not yet supported; will land in Phase 5 UI" },
          { status: 501 }
        );
      }
      default:
        return NextResponse.json(
          { error: "unknown op" },
          { status: 400 }
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}
