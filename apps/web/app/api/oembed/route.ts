import { NextResponse } from "next/server";

import { getNode, getPublishedSession } from "@/lib/db";
import { buildEmbedHtml, parseEmbedTarget } from "@/lib/embed";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// oEmbed provider (JSON only) for openflipbook worlds: paste an /n/<id> or
// /embed/<sessionId> link into a consumer (WordPress, Discourse, ...) and it
// renders the interactive embed. Same publish gate as /embed itself — the
// endpoint must not confirm the existence of unpublished sessions.

export async function GET(req: Request) {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }
  const reqUrl = new URL(req.url);
  const format = reqUrl.searchParams.get("format");
  if (format && format !== "json") {
    // Per the oEmbed spec: 501 for unimplemented formats (no XML here).
    return NextResponse.json({ error: "only format=json" }, { status: 501 });
  }
  const raw = reqUrl.searchParams.get("url");
  const target = raw ? parseEmbedTarget(raw) : null;
  if (!target) {
    return NextResponse.json({ error: "unrecognized url" }, { status: 404 });
  }

  let sessionId: string;
  let nodeId: string | null;
  if (target.kind === "node") {
    const node = await getNode(target.nodeId).catch(() => null);
    if (!node) return NextResponse.json({ error: "not found" }, { status: 404 });
    sessionId = node.session_id;
    nodeId = node.id;
  } else {
    sessionId = target.sessionId;
    nodeId = target.nodeId;
  }

  const published = await getPublishedSession(sessionId).catch(() => null);
  if (!published) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const maxWidthRaw = reqUrl.searchParams.get("maxwidth");
  const maxWidth = maxWidthRaw ? Number(maxWidthRaw) : null;
  const embed = buildEmbedHtml(
    reqUrl.origin,
    sessionId,
    nodeId,
    Number.isFinite(maxWidth ?? NaN) ? maxWidth : null
  );
  const posterBase = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");
  return NextResponse.json({
    version: "1.0",
    type: "rich",
    provider_name: "openflipbook",
    provider_url: reqUrl.origin,
    title: published.title || published.query,
    html: embed.html,
    width: embed.width,
    height: embed.height,
    thumbnail_url: `${posterBase}/${published.poster_key}`,
  });
}
