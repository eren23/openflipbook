import { NextResponse } from "next/server";
import { markNodeGeoExtracted, recordError, updateNodeEstimatedView } from "@/lib/db";
import { listPriorEntitiesForExtraction, mergeExtraction } from "@/lib/world";
import { deriveGeoFromExtraction } from "@/lib/world-map";
import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";
import { readServerEnv } from "@/lib/env";
import { envFlag } from "@/lib/env-flag";
import { inlineStoredImage } from "@/lib/r2";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";
import type {
  Entity,
  EntityExtractionResult,
  EntityKind,
  SceneView,
  ViewEstimate,
  ViewSpec,
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
  // A replayed/late extraction can arrive with the node's STORE URL — on the
  // docker stack a localhost minio URL the VLM providers refuse. Inline our
  // own stored bytes (best-effort; see lib/r2.inlineStoredImage).
  if (!body.image_data_url.startsWith("data:")) {
    const inlined = await inlineStoredImage(body.image_data_url);
    if (inlined) body.image_data_url = inlined;
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
  let upstreamViewSpec: ViewSpec | null = null;
  try {
    const upstream = await fetch(
      joinModalUrl(env.MODAL_API_URL, "/extract-entities"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TRACE_HEADER]: traceId,
          ...modalAuthHeaders(),
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
      view_spec?: ViewSpec | null;
    };
    upstreamResult = payload.result;
    upstreamView = payload.view ?? null;
    upstreamViewSpec = payload.view_spec ?? null;
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
    // Whether the geo-seeding step below completed. The durable "fully
    // processed" stamp is set only when this stays true, so a node whose
    // seeding FAILED is left un-stamped and a later visit retries — instead of
    // locking in a half-seeded map that disagrees with the codex forever.
    let geoSeedOk = true;
    // Geometric world (GEOMETRIC_WORLD): seed derived map coordinates from the
    // entities localized on this node — the world map populates for free. Default
    // scene_view = a top-down map so each bbox maps straight into a normalized
    // world crop. Best-effort, off the response path.
    const geoNodeId = body.node_id;
    const sceneView = body.scene_view ?? null;
    // C12: the estimator's confident camera read becomes the node's view truth
    // (never over a user pin — the db helper guards). Best-effort: a failed
    // patch must not break extraction.
    if (geoNodeId && upstreamViewSpec) {
      try {
        await updateNodeEstimatedView(geoNodeId, upstreamViewSpec);
      } catch {
        // best-effort only
      }
    }
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
          // Child frame: seed the interior as a TOP-DOWN map in the SAME
          // MAP_IMAGE_FRAME the city uses — so a child's local pos spans the same
          // {0,0,100,60} frame that tap-routing inside the place reads (geo-tap
          // routes the interior identically to the city). The parent's `scale`,
          // learned in deriveGeoFromExtraction (footprint ÷ interior extent),
          // composes this local frame to a true absolute coordinate.
          const items = merged.snapshot.entities
            .map((e) => toItem(e, true))
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (items.length > 0) {
            await deriveGeoFromExtraction(
              sessionId,
              {
                node_id: geoNodeId,
                level: "map",
                observer: null,
                map_crop: MAP_IMAGE_FRAME,
              },
              16 / 9,
              items,
              "top_down",
              -60,
              parentFrameId,
              upstreamView?.scale_tier,
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
                map_crop: MAP_IMAGE_FRAME,
              },
              16 / 9,
              items,
              upstreamView?.projection ?? "top_down",
              upstreamView?.pitch_deg ?? -60,
              null,
              upstreamView?.scale_tier,
            );
          }
        }
      } catch (err) {
        // Seeding failed: surface it (so the under-seeded map is debuggable)
        // and leave the node un-stamped so a revisit retries — never block the
        // extraction response.
        geoSeedOk = false;
        await recordError({
          trace_id: traceId,
          kind: "extract.geo_seed_failed",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack ?? null : null,
          body_excerpt: null,
          source: "backend",
        }).catch(() => {});
      }
    }
    // Durable "fully processed" stamp — set only after BOTH the codex merge and
    // (when applicable) geo seeding succeeded, or there was nothing to seed.
    // Gates the client's auto-localize so a revisit/reload never re-runs the
    // non-deterministic VLM on an already-complete node. Best-effort: a failed
    // stamp must not break the response.
    if (geoSeedOk) {
      try {
        await markNodeGeoExtracted(body.node_id);
      } catch {
        // best-effort only
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
