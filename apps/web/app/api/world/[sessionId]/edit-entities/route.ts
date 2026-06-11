import { NextResponse } from "next/server";
import { getWorldState } from "@/lib/world";
import {
  applyEntityEdits,
  blastRadius,
  buildGeoReferences,
  getWorldMap,
} from "@/lib/world-map";
import { readServerEnv } from "@/lib/env";
import { envFlag } from "@/lib/env-flag";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";
import type { EntityEditPlan, EntityGeoEdit, SceneView } from "@openflipbook/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

interface EditRequestBody {
  instruction?: string;
  scene_view?: SceneView | null;
  // Preview only: resolve + return the plan (edits + blast-radius) WITHOUT
  // mutating the map, so the UI can confirm before applying. Default false.
  dry_run?: boolean;
}

// NL edit of the geometric world map. Resolves the instruction →
// structured geo edits via the Modal backend's /edit-entities, applies them to
// the world_map, and returns the plan (incl. blast-radius) + the new snapshot.
// Gated by WORLD_OVERRIDE_ENABLED (these edits mutate persisted geo state),
// mirroring the codex-override route next door.
function overridesEnabled(): boolean {
  return envFlag("WORLD_OVERRIDE_ENABLED");
}

export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!overridesEnabled()) {
    return NextResponse.json(
      {
        error:
          "world override is disabled; set WORLD_OVERRIDE_ENABLED=1 to enable (Phase 5)",
      },
      { status: 403 }
    );
  }
  const env = readServerEnv();
  if (!env.MODAL_API_URL) {
    return NextResponse.json({ error: "MODAL_API_URL is not set" }, { status: 503 });
  }
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "MongoDB persistence is not configured" },
      { status: 503 }
    );
  }
  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  let body: EditRequestBody;
  try {
    body = (await req.json()) as EditRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const instruction = (body.instruction ?? "").trim();
  if (!instruction) {
    return NextResponse.json(
      { error: "missing required field: instruction" },
      { status: 400 }
    );
  }

  // The current map + codex, so the backend sees what it may target and the
  // blast-radius is attributed to the right nodes.
  const [map, world] = await Promise.all([
    getWorldMap(sessionId),
    getWorldState(sessionId).catch(() => null),
  ]);
  if (map.entities.length === 0) {
    return NextResponse.json(
      { error: "no geometric entities to edit yet for this session" },
      { status: 409, headers: { [TRACE_HEADER]: traceId } }
    );
  }
  const references = buildGeoReferences(map.entities, world?.entities ?? []);
  const trimmed = map.entities.map((e) => ({
    id: e.id,
    entity_id: e.entity_id,
    label: e.label,
    pos: e.pos,
    height: e.height,
    footprint: e.footprint,
    visual: e.visual,
  }));

  let plan: EntityEditPlan;
  try {
    const upstream = await fetch(
      joinModalUrl(env.MODAL_API_URL, "/edit-entities"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId, ...modalAuthHeaders() },
        body: JSON.stringify({
          session_id: sessionId,
          instruction,
          entities: trimmed,
          references,
          scene_view: body.scene_view ?? null,
          trace_id: traceId,
        }),
      }
    );
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        {
          error: `upstream HTTP ${upstream.status}`,
          detail: text.slice(0, 400),
          trace_id: traceId,
        },
        { status: 502, headers: { [TRACE_HEADER]: traceId } }
      );
    }
    const payload = (await upstream.json()) as { plan: EntityEditPlan };
    plan = payload.plan;
    // Nested propagation: ripple the blast-radius to the edited entities'
    // frame-siblings — moving one repositions the things around it, so their
    // saved scenes are stale too. Union with whatever the backend attributed.
    const rippled = blastRadius(
      plan.edits as EntityGeoEdit[],
      references,
      map.entities,
    );
    plan = {
      ...plan,
      blast_radius: [...new Set([...plan.blast_radius, ...rippled])].sort(),
    };
  } catch (err) {
    return NextResponse.json(
      { error: `edit upstream failed: ${(err as Error).message}`, trace_id: traceId },
      { status: 502, headers: { [TRACE_HEADER]: traceId } }
    );
  }

  // Preview: hand back the plan + blast-radius without touching the map.
  if (body.dry_run) {
    return NextResponse.json(
      { plan, trace_id: traceId },
      { headers: { [TRACE_HEADER]: traceId } }
    );
  }

  try {
    const snapshot = await applyEntityEdits(sessionId, plan.edits as EntityGeoEdit[]);
    return NextResponse.json(
      { plan, snapshot, trace_id: traceId },
      { headers: { [TRACE_HEADER]: traceId } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: `apply failed: ${(err as Error).message}`, trace_id: traceId },
      { status: 500, headers: { [TRACE_HEADER]: traceId } }
    );
  }
}
