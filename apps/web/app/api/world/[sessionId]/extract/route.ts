import { NextResponse } from "next/server";
import { listPriorEntitiesForExtraction, mergeExtraction } from "@/lib/world";
import { deriveGeoFromExtraction } from "@/lib/world-map";
import { readServerEnv } from "@/lib/env";
import { envFlag } from "@/lib/env-flag";
import { modalUrl as joinModalUrl } from "@/lib/modal";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";
import type {
  Entity,
  EntityExtractionResult,
  EntityKind,
  SceneView,
  ViewEstimate,
} from "@openflipbook/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

interface ExtractRequestBody {
  node_id?: string;
  image_data_url?: string;
  caption?: string;
  scene_description?: string | null;
  // The view this node renders (the geo-tap intent). When it carries a focus_id
  // (an entered place), this scene's sub-entities seed into that place's CHILD
  // frame instead of the top-level city map.
  scene_view?: SceneView | null;
}

// Post-final extraction trigger. The web client calls this once a generated
// page has been persisted via /api/nodes. We:
//   1. Pull the most-recent slice of the session's existing entities from
//      Mongo (so the VLM can diff rather than re-emit).
//   2. POST to the Modal backend's /extract-entities with the new page +
//      prior slice.
//   3. Merge the returned diff back into Mongo via lib/world.mergeExtraction.
//
// Off the critical path of the next click — the client fires this fire-and-
// forget. Failures return a non-2xx but never block UX.
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MODAL_API_URL) {
    return NextResponse.json(
      { error: "MODAL_API_URL is not set" },
      { status: 503 }
    );
  }
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "MongoDB persistence is not configured" },
      { status: 503 }
    );
  }

  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  let body: ExtractRequestBody;
  try {
    body = (await req.json()) as ExtractRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.node_id || !body.image_data_url) {
    return NextResponse.json(
      { error: "missing required fields: node_id, image_data_url" },
      { status: 400 }
    );
  }

  let priorEntities: Awaited<
    ReturnType<typeof listPriorEntitiesForExtraction>
  > = [];
  // Hint text combines the short page title with the planner's full
  // scene description so the name-overlap scoring in
  // `listPriorEntitiesForExtraction` can pull recurring characters that
  // are mentioned in the prompt back into the prior slice even when
  // recency alone would have dropped them.
  const hint = [body.caption ?? "", body.scene_description ?? ""]
    .filter(Boolean)
    .join("\n");
  try {
    priorEntities = await listPriorEntitiesForExtraction(sessionId, hint);
  } catch {
    // Reading prior entities is best-effort — extraction can still run with
    // an empty slice (just produces more "added" entries that the merge
    // layer reconciles against the on-disk doc anyway).
    priorEntities = [];
  }

  let upstreamResult: EntityExtractionResult;
  let upstreamView: ViewEstimate | null = null;
  try {
    const upstream = await fetch(
      joinModalUrl(env.MODAL_API_URL, "/extract-entities"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TRACE_HEADER]: traceId,
        },
        body: JSON.stringify({
          session_id: sessionId,
          node_id: body.node_id,
          image_data_url: body.image_data_url,
          caption: body.caption ?? "",
          scene_description: body.scene_description ?? null,
          prior_entities: priorEntities,
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
    const payload = (await upstream.json()) as {
      result: EntityExtractionResult;
      view?: ViewEstimate | null;
    };
    upstreamResult = payload.result;
    upstreamView = payload.view ?? null;
  } catch (err) {
    return NextResponse.json(
      {
        error: `extract upstream failed: ${(err as Error).message}`,
        trace_id: traceId,
      },
      { status: 502, headers: { [TRACE_HEADER]: traceId } }
    );
  }

  try {
    const merged = await mergeExtraction({
      session_id: sessionId,
      node_id: body.node_id,
      result: upstreamResult,
    });
    // Geometric world (GEOMETRIC_WORLD): seed derived map coordinates from the
    // entities localized on this node — the world map populates for free. Default
    // scene_view = a top-down map so each bbox maps straight into a normalized
    // world crop. Best-effort, off the response path.
    const geoNodeId = body.node_id;
    const sceneView = body.scene_view ?? null;
    const viewLevel = upstreamView?.level ?? "map";
    // An ENTERED place (the geo-tap carried a focus): seed this scene's
    // sub-entities into that place's CHILD frame, so the interior layout
    // persists + stays consistent across re-entries. Otherwise we only seed a
    // top-down MAP into the city frame — a scene's boxes don't belong in a fake
    // top-down crop.
    const parentFrameId =
      sceneView && sceneView.level !== "map" ? sceneView.focus_id ?? null : null;
    const geoOn = envFlag("GEOMETRIC_WORLD");
    if (geoNodeId && geoOn && (parentFrameId || viewLevel === "map")) {
      try {
        // Map an on-node entity → a seedable geo item (or null to skip). Drops
        // boxes that are huge (a backdrop river → area ~0.7) or specks, and — in
        // a child frame — the focus place itself (it lives one frame up).
        const toItem = (e: Entity, childFrame: boolean) => {
          const bbox = e.appearance_bboxes?.[geoNodeId];
          if (!bbox) return null;
          if (childFrame) {
            if (`geo_${e.id}` === parentFrameId) return null; // skip the parent
          } else if (e.kind !== "place") {
            return null; // top-level map: enterable PLACES only
          }
          const area = bbox.w_pct * bbox.h_pct;
          if (area > 0.5 || area < 0.0005) return null;
          return {
            entity_id: e.id,
            kind: e.kind,
            label: e.name,
            bbox,
            visual: e.appearance,
            state: e.state,
            confidence: e.confidence,
          };
        };
        if (parentFrameId && sceneView) {
          // Child frame: position sub-entities in the place's LOCAL frame
          // (observer at the local origin) so they're relative to the place, not
          // the city. Reuses the entered scene's observer pose + angle.
          const items = merged.snapshot.entities
            .map((e) => toItem(e, true))
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (items.length > 0) {
            const localView: SceneView = {
              ...sceneView,
              observer: sceneView.observer
                ? { ...sceneView.observer, pos: { x: 0, y: 0 } }
                : null,
            };
            await deriveGeoFromExtraction(
              sessionId,
              localView,
              16 / 9,
              items,
              upstreamView?.projection ?? "perspective",
              upstreamView?.pitch_deg ?? 0,
              parentFrameId,
            );
          }
        } else {
          // Top-level city map (parent_id = null) — the original seeding.
          const items = merged.snapshot.entities
            .map((e) => toItem(e, false))
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (items.length > 0) {
            await deriveGeoFromExtraction(
              sessionId,
              {
                node_id: geoNodeId,
                level: "map",
                observer: null,
                map_crop: { x: 0, y: 0, w: 100, h: 60 },
              },
              16 / 9,
              items,
              upstreamView?.projection ?? "top_down",
              upstreamView?.pitch_deg ?? -60,
            );
          }
        }
      } catch {
        /* seeding is best-effort — never block the extraction response */
      }
    }
    // Inline projection of added/updated records so the debug HUD (and any
    // future hover-chip prefetch) can render names without a follow-up GET
    // on the snapshot. Cheap — these are already in memory from the merge.
    const idLookup = new Map<string, Entity>(
      merged.snapshot.entities.map((e) => [e.id, e])
    );
    type EntityDigest = { id: string; name: string; kind: EntityKind };
    const projectName = (id: string): EntityDigest | null => {
      const e = idLookup.get(id);
      return e ? { id, name: e.name, kind: e.kind } : null;
    };
    return NextResponse.json(
      {
        snapshot: merged.snapshot,
        added_ids: merged.added_ids,
        updated_ids: merged.updated_ids,
        added_entities: merged.added_ids
          .map(projectName)
          .filter((e): e is EntityDigest => e !== null),
        updated_entities: merged.updated_ids
          .map(projectName)
          .filter((e): e is EntityDigest => e !== null),
        trace_id: traceId,
      },
      { headers: { [TRACE_HEADER]: traceId } }
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: `merge failed: ${(err as Error).message}`,
        trace_id: traceId,
      },
      { status: 500, headers: { [TRACE_HEADER]: traceId } }
    );
  }
}
