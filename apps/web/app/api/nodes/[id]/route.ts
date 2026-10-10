import { NextResponse } from "next/server";
import { getNode, setNodeDescentClip } from "@/lib/db";
import { descentVideoPath, isDescentClipUrl } from "@/lib/descent-clip";
import { descentProviderUrl, storeDescentVideo } from "@/lib/descent-video-store";
import { CreatorError } from "@/lib/creator-error";
import { readServerEnv } from "@/lib/env";
import { requireOwner } from "@/lib/session-owner";
import { worldReadHeaders, worldReadResponse } from "@/lib/world-read-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  const row = await getNode(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const denied = await worldReadResponse(row.session_id);
  if (denied) return denied;

  const publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");
  return NextResponse.json({
    id: row.id,
    parent_id: row.parent_id,
    session_id: row.session_id,
    query: row.query,
    page_title: row.page_title,
    image_url: `${publicBase}/${row.image_key}`,
    image_key: row.image_key,
    transition_context: row.transition_context ?? null,
    scene_view: row.scene_view,
    relation: row.relation,
    image_model: row.image_model,
    prompt_author_model: row.prompt_author_model,
    aspect_ratio: row.aspect_ratio,
    click_in_parent: row.click_in_parent,
    sources: row.sources,
    geo_extracted: row.geo_extracted,
    descent_video_url: row.descent_video_url,
    created_at: row.created_at,
  }, { headers: worldReadHeaders });
}

// DESCENT_AUTO: store the background-generated arrival clip on the node.
// Owner-gated (a stored URL is served to every future visitor) and
// write-once — the clip is per-edge, not per-view.
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }
  const row = await getNode(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const owner = await requireOwner(row.session_id);
  if (!owner.ok) return owner.res;
  const saved = (url: string | null, durable: boolean) => NextResponse.json({ ok: true, kept: url, durable }, { headers: worldReadHeaders });
  if (row.descent_video) return saved(descentVideoPath(id), true);
  const body = (await req.json().catch(() => null)) as {
    descent_video_url?: unknown;
  } | null;
  const url = body?.descent_video_url;
  if (!isDescentClipUrl(url)) {
    return NextResponse.json({ error: "invalid descent_video_url" }, { status: 400 });
  }
  // A second arrival cannot replace the original paid clip. Replaying the
  // same legacy provider URL may pin its exact bytes without another job.
  if (row.descent_video_url && row.descent_video_url !== url) return saved(row.descent_video_url, false);
  try {
    try { descentProviderUrl(url); }
    catch (error) {
      if (row.descent_video_url) return saved(row.descent_video_url, false);
      throw error;
    }
    const parent = row.parent_id ? await getNode(row.parent_id) : null;
    if (!parent || parent.session_id !== row.session_id) throw new CreatorError("Arrival clip has no parent in this world", 409);
    const video = await storeDescentVideo({ session_id: row.session_id, node_id: id, parent_node_id: parent.id, parent_image_key: parent.image_key, node_image_key: row.image_key, url });
    if (await setNodeDescentClip(id, url, video)) return saved(descentVideoPath(id), true);
    const current = await getNode(id);
    if (current?.descent_video) return saved(descentVideoPath(id), true);
    if (current?.descent_video_url) return saved(current.descent_video_url, false);
    throw new CreatorError("Arrival clip was not saved. Please retry saving this clip.", 409);
  } catch (error) {
    return NextResponse.json({ error: error instanceof CreatorError ? error.message : "Arrival clip storage unavailable. Please retry saving this clip." }, { status: error instanceof CreatorError ? error.status : 503, headers: worldReadHeaders });
  }
}
