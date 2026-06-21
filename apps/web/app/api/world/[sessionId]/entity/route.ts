import { NextResponse } from "next/server";
import {
  deleteEntity,
  mergeEntities,
  pinEntity,
  renameEntity,
  setEntityAppearance,
  undoDeleteEntity,
} from "@/lib/world";
import { removeEntityGeos } from "@/lib/world-map";
import { requireOwner } from "@/lib/session-owner";
import { readServerEnv } from "@/lib/env";
import { envFlag } from "@/lib/env-flag";
import type { WorldEntityMutation } from "@openflipbook/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// User-override CRUD on the codex (pin/rename/merge/delete).
//
// Gated behind `WORLD_OVERRIDE_ENABLED` because there is no real auth yet: the
// only "auth" is knowing a session id (sessions are user-scoped but ids are
// guessable on a deployed instance), and these mutations are destructive enough
// that they shouldn't be callable on a production deploy by accident. Local dev
// sets the flag in `.env.local` to iterate on the UI.
function overridesEnabled(): boolean {
  return envFlag("WORLD_OVERRIDE_ENABLED");
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
  const auth = await requireOwner(sessionId);
  if (!auth.ok) return auth.res;
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
        // Keep the geo map in step with the codex: drop the deleted entity's
        // `geo_<id>` (and re-root any children) so it doesn't linger in the
        // overlay + world bounds. Best-effort — the codex delete is the source
        // of truth; a later re-sighting re-seeds geometry.
        await removeEntityGeos(sessionId, [`geo_${mutation.id}`]).catch(() => {});
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
        // Blind user-create without a name isn't supported; reject early.
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
