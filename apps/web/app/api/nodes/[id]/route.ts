import { NextResponse } from "next/server";
import { getNode, setNodeDescentClip } from "@/lib/db";
import { isDescentClipUrl } from "@/lib/descent-clip";
import { readServerEnv } from "@/lib/env";
import { requireOwner } from "@/lib/session-owner";

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

  const publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");
  return NextResponse.json({
    id: row.id,
    parent_id: row.parent_id,
    session_id: row.session_id,
    query: row.query,
    page_title: row.page_title,
    image_url: `${publicBase}/${row.image_key}`,
    image_model: row.image_model,
    prompt_author_model: row.prompt_author_model,
    aspect_ratio: row.aspect_ratio,
    click_in_parent: row.click_in_parent,
    sources: row.sources,
    geo_extracted: row.geo_extracted,
    descent_video_url: row.descent_video_url,
    created_at: row.created_at,
  });
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
  if (row.descent_video_url) {
    return NextResponse.json({ ok: true, kept: row.descent_video_url });
  }
  const body = (await req.json().catch(() => null)) as {
    descent_video_url?: unknown;
  } | null;
  const url = body?.descent_video_url;
  if (!isDescentClipUrl(url)) {
    return NextResponse.json({ error: "invalid descent_video_url" }, { status: 400 });
  }
  await setNodeDescentClip(id, url);
  return NextResponse.json({ ok: true });
}
