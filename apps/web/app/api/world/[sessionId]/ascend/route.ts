import { NextResponse } from "next/server";
import type { ScaleTier, SceneView, WorldEntityGeo } from "@openflipbook/config";

import { deleteNode, getNode, insertNode, updateNodeParent } from "@/lib/db";
import { decodeDataUrl, uploadJpeg } from "@/lib/r2";
import { getWorldMap, upsertEntityGeos } from "@/lib/world-map";
import { reparentRoots } from "@/lib/scale-tree";
import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";
import { readServerEnv } from "@/lib/env";
import { envFlag } from "@/lib/env-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// OUTWARD reparent: the synthesized container image P (from the backend ascend
// branch) + which root to re-root under it + its rung.
interface AscendBody {
  child_node_id: string;
  image_data_url: string;
  parent_tier: ScaleTier;
  page_title: string;
  query?: string;
  image_model?: string;
  prompt_author_model?: string;
  aspect_ratio?: string;
  final_prompt?: string | null;
}

// Atomically re-root the current root C under a synthesized coarser parent P.
// Commit order is chosen so any single failure leaves C + the existing tree fully
// intact and INV-1-safe (the structural node edge is flipped LAST):
//   1. insert P node (a harmless 2nd root until step 3)
//   2. seed geo — reparentRoots re-points every root geo under P (atomic in one
//      optimisticReplace) with the conserving scale; abort + delete P on failure
//   3. re-point C's node parent_id = P (the commit point; single-field $set)
// Geo BEFORE the node re-point: repointing the node first would briefly compose C
// through a P with no geo frame → INV-1 violation.
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;

  if (!(envFlag("SCALE_LADDER_NAV") && envFlag("SCALE_OUTWARD"))) {
    return NextResponse.json(
      { error: "OUTWARD disabled (set SCALE_LADDER_NAV=1 and SCALE_OUTWARD=1)" },
      { status: 403 },
    );
  }
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_BUCKET) {
    return NextResponse.json(
      { error: "MONGODB_URI/MONGODB_DB or R2_* not set — persistence disabled." },
      { status: 503 },
    );
  }

  const body = (await req.json()) as AscendBody;
  if (!body.child_node_id || !body.image_data_url || !body.parent_tier) {
    return NextResponse.json(
      { error: "missing required fields: child_node_id, image_data_url, parent_tier" },
      { status: 400 },
    );
  }

  // Double-ascend guard: C must exist and still be a root.
  const child = await getNode(body.child_node_id);
  if (!child) {
    return NextResponse.json({ error: "child_node_id not found" }, { status: 404 });
  }
  if (child.parent_id !== null) {
    return NextResponse.json(
      { error: "child is not a root (already ascended)", parent_id: child.parent_id },
      { status: 409 },
    );
  }

  // Upload P's image, then mint P's id so its scene_view can self-reference.
  const decoded = decodeDataUrl(body.image_data_url);
  const ext = decoded.contentType === "image/png" ? "png" : "jpg";
  const keyPrefix = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const uploaded = await uploadJpeg(
    `${keyPrefix}/${crypto.randomUUID()}.${ext}`,
    decoded.bytes,
    decoded.contentType,
  );
  const pId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const sceneView: SceneView = {
    node_id: pId,
    level: "map",
    observer: null,
    map_crop: MAP_IMAGE_FRAME,
    focus_id: null,
    scale_tier: body.parent_tier,
  };

  // 1. Insert P node (parent_id:null, relation:"ascend").
  await insertNode({
    id: pId,
    parent_id: null,
    session_id: sessionId,
    query: body.query ?? body.page_title,
    page_title: body.page_title,
    image_key: uploaded.key,
    image_model: body.image_model ?? "",
    prompt_author_model: body.prompt_author_model ?? "",
    aspect_ratio: body.aspect_ratio ?? child.aspect_ratio,
    final_prompt: body.final_prompt ?? null,
    relation: "ascend",
    scale_tier: body.parent_tier,
    scene_view: sceneView,
  });

  // 2. Seed geo — re-point every root geo under P (load-bearing for ascend, NOT
  //    best-effort). Skip cleanly when the world map has no roots yet.
  let learnedScale: number | null = null;
  try {
    const snapshot = await getWorldMap(sessionId);
    const hasRoots = snapshot.entities.some((e) => (e.parent_id ?? null) === null);
    if (hasRoots) {
      const pGeo: WorldEntityGeo = {
        id: `geo_${pId}`,
        entity_id: null,
        parent_id: null,
        kind: "place",
        label: body.page_title,
        pos: { x: MAP_IMAGE_FRAME.w / 2, y: MAP_IMAGE_FRAME.h / 2 },
        height: 4,
        footprint: { w: MAP_IMAGE_FRAME.w, d: MAP_IMAGE_FRAME.h },
        scale_tier: body.parent_tier,
        visual: "",
        state: {},
        confidence: 0.9,
        source: "user",
        updated_at: nowIso,
      };
      const result = reparentRoots(snapshot.entities, pGeo, nowIso);
      learnedScale = result.learnedScale;
      await upsertEntityGeos(sessionId, result.geos);
    }
  } catch (err) {
    // Abort: delete the orphan P node so C + the existing tree are untouched.
    await deleteNode(pId).catch(() => {});
    return NextResponse.json(
      { error: `geo reparent failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // 3. Commit: re-point C's node under P (atomic single-field $set).
  const repointed = await updateNodeParent(body.child_node_id, pId);
  if (!repointed) {
    return NextResponse.json(
      { error: "failed to re-point child (it may have been removed)", parent_node_id: pId },
      { status: 500 },
    );
  }

  return NextResponse.json({
    parent_node_id: pId,
    child_node_id: body.child_node_id,
    learned_scale: learnedScale,
  });
}
