import { NextResponse } from "next/server";

import { getNode } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { getStoredBytes } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ nodeId: string }>;
}

// The RAW stored render for a node, streamed same-origin. Two consumers:
//   ?download=1 → attachment disposition, so the client's "Download image"
//                 forces a save even though R2 is a different origin (a bare
//                 cross-origin <a download> is ignored by the browser).
//   no param    → inline bytes the "Copy image" path fetches as a same-origin
//                 blob, so it can canvas→PNG for the clipboard without tainting.
// Distinct from /api/postcard/[nodeId], which returns the FRAMED postcard.
export async function GET(req: Request, { params }: Params) {
  const { nodeId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  const row = await getNode(nodeId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const stored = await getStoredBytes(row.image_key);
  if (!stored) return NextResponse.json({ error: "not found" }, { status: 404 });

  const ext = stored.contentType === "image/png" ? "png" : "jpg";
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(new Uint8Array(stored.bytes), {
    headers: {
      "Content-Type": stored.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...(download
        ? { "Content-Disposition": `attachment; filename="openflipbook-${row.id}.${ext}"` }
        : {}),
    },
  });
}
