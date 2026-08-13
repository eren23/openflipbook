import { NextResponse } from "next/server";

import { listNodesBySession } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { buildWorldZip, type WorldExportNode } from "@/lib/export-build";
import { getStoredBytes } from "@/lib/r2";
import { getWorldState } from "@/lib/world";
import { getWorldMap } from "@/lib/world-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// Bound memory on a runaway session: export the first NODE_CAP nodes and set a
// header so the truncation isn't silent. A session that large is already an
// outlier; the whole-DAG walk stays O(nodes) regardless.
const NODE_CAP = 500;

/** GET /api/export/session/[sessionId] — the whole-world bundle (ZIP): every
 * branch's image + graph.json (topology + provenance + poses) + world-map.json
 * (geometry) + entities.json (registry). Session-scoped, unlike the node-path
 * /api/export/[nodeId]. */
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  // The whole DAG — listNodesBySession is cursor-paged, so accumulate up to the
  // cap. Sorted by created_at, so graph.json reads chronologically.
  const rows: Awaited<ReturnType<typeof listNodesBySession>>["rows"] = [];
  let cursor: string | null = null;
  do {
    const page = await listNodesBySession(sessionId, { cursor, limit: 200 });
    rows.push(...page.rows);
    cursor = page.next_cursor;
  } while (cursor && rows.length < NODE_CAP);
  if (rows.length === 0) {
    return NextResponse.json({ error: "session not found or empty" }, { status: 404 });
  }
  const capped = rows.slice(0, NODE_CAP);
  const truncated = rows.length > NODE_CAP || (cursor != null && rows.length >= NODE_CAP);
  if (truncated) {
    console.warn(
      `[export.world] session ${sessionId} exceeds ${NODE_CAP} nodes — bundle truncated`,
    );
  }

  const [worldMap, entities] = await Promise.all([
    getWorldMap(sessionId),
    getWorldState(sessionId),
  ]);

  const nodes: WorldExportNode[] = [];
  for (const r of capped) {
    const stored = await getStoredBytes(r.image_key);
    nodes.push({
      id: r.id,
      parent_id: r.parent_id,
      title: r.page_title || r.query,
      query: r.query,
      created_at: r.created_at,
      relation: r.relation,
      scale_tier: r.scale_tier,
      click_in_parent: r.click_in_parent,
      scene_view: r.scene_view,
      sources: r.sources,
      bytes: stored ? stored.bytes : null,
    });
  }

  const bytes = await buildWorldZip(nodes, worldMap, entities);
  const stamp = sessionId.slice(0, 8);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="openflipbook-world-${stamp}.zip"`,
      ...(truncated ? { "X-Export-Truncated": String(NODE_CAP) } : {}),
    },
  });
}
