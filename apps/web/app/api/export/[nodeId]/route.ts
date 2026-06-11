import { NextResponse } from "next/server";

import { getNodeChain } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import {
  buildFlipbookPdf,
  buildGif,
  buildZip,
  sampleEvenly,
  type ExportPage,
} from "@/lib/export-build";
import { getStoredBytes } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ nodeId: string }>;
}

const GIF_FRAME_CAP = 16;
const CHAIN_CAP = 40;

/** GET /api/export/[nodeId]?fmt=zip|pdf|gif — the root→node path as a
 * shareable artifact. ZIP = pages + graph.json; PDF = the flipbook; GIF =
 * an animated flip (evenly sampled to GIF_FRAME_CAP frames). */
export async function GET(req: Request, { params }: Params) {
  const { nodeId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 },
    );
  }
  const fmt = new URL(req.url).searchParams.get("fmt") ?? "zip";
  if (!["zip", "pdf", "gif"].includes(fmt)) {
    return NextResponse.json({ error: "fmt must be zip|pdf|gif" }, { status: 400 });
  }

  const chain = await getNodeChain(nodeId, CHAIN_CAP);
  if (chain.length === 0) {
    return NextResponse.json({ error: "node not found" }, { status: 404 });
  }

  const wanted =
    fmt === "gif" ? new Set(sampleEvenly(chain.length, GIF_FRAME_CAP)) : null;
  const pages: ExportPage[] = [];
  for (let i = 0; i < chain.length; i++) {
    if (wanted && !wanted.has(i)) continue;
    const row = chain[i]!;
    const stored = await getStoredBytes(row.image_key);
    if (!stored) continue; // a missing blob drops the page, not the export
    pages.push({
      id: row.id,
      parent_id: row.parent_id,
      title: row.page_title || row.query,
      query: row.query,
      created_at: row.created_at,
      bytes: stored.bytes,
    });
  }
  if (pages.length === 0) {
    return NextResponse.json({ error: "no stored pages" }, { status: 404 });
  }

  const stamp = nodeId.slice(0, 8);
  if (fmt === "zip") {
    const bytes = await buildZip(pages);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="openflipbook-${stamp}.zip"`,
      },
    });
  }
  if (fmt === "pdf") {
    const bytes = await buildFlipbookPdf(pages);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="openflipbook-${stamp}.pdf"`,
      },
    });
  }
  // gif: decode JPEGs to RGBA (pure-JS) then encode
  const { decode } = await import("jpeg-js");
  const frames = pages.map((p) => {
    const d = decode(Buffer.from(p.bytes), { useTArray: true, maxMemoryUsageInMB: 1024 });
    return { width: d.width, height: d.height, data: d.data };
  });
  const bytes = await buildGif(frames);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "image/gif",
      "Content-Disposition": `attachment; filename="openflipbook-${stamp}.gif"`,
    },
  });
}
