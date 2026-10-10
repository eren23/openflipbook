import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import QRCode from "qrcode";

import { getNode } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { postcardLayout, type PostcardNode } from "@/lib/postcard";
import { worldReadHeaders, worldReadResponse } from "@/lib/world-read-response";
import { getStoredBytes } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ nodeId: string }>;
}

export async function GET(req: Request, { params }: Params) {
  const { nodeId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  const row = await getNode(nodeId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const denied = await worldReadResponse(row.session_id);
  if (denied) return denied;

  // Embed bytes after authorization. A renderer fetching the protected URL
  // would have no browser ownership cookie and could not read private art.
  const stored = await getStoredBytes(row.image_key);
  if (!stored || !["image/jpeg", "image/png", "image/webp"].includes(stored.contentType) || stored.bytes.length > 20 * 1024 * 1024) return new Response(null, { status: 503, headers: worldReadHeaders });
  const reqUrl = new URL(req.url);
  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  const permalink = `${baseUrl}/n/${row.id}`;

  const qrDataUrl = await QRCode.toDataURL(permalink, {
    margin: 1,
    width: 280,
    color: { dark: "#2a1a08", light: "#f4ead800" },
  });

  const node: PostcardNode = {
    nodeId: row.id,
    title: row.page_title || row.query,
    imageUrl: `data:${stored.contentType};base64,${stored.bytes.toString("base64")}`,
    citationCount: row.sources.length,
  };

  const download = reqUrl.searchParams.get("download") === "1";
  const filename = `openflipbook-${row.id}.png`;

  return new ImageResponse(postcardLayout(node, baseUrl, qrDataUrl), {
    width: 1080,
    height: 1350,
    headers: { ...worldReadHeaders, ...(download ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}) },
  });
}
