import { NextResponse } from "next/server";
import {
  importedEntitiesToGeos,
  validateImportedEntities,
} from "@/lib/azgaar-import";
import { isSafeId } from "@/lib/ids";
import { requireOwner } from "@/lib/session-owner";
import { upsertEntityGeos } from "@/lib/world-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// Map-generator import (Azgaar & friends): the CLIENT parses the export
// file and sends only the capped, normalized entity list — never the
// multi-MB raw JSON. Deterministic geo ids make a re-import an update.
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!isSafeId(sessionId)) {
    return NextResponse.json({ error: "invalid session id" }, { status: 400 });
  }
  const owner = await requireOwner(sessionId);
  if (!owner.ok) return owner.res;

  const body = (await req.json().catch(() => null)) as {
    entities?: unknown;
    map_name?: unknown;
  } | null;
  const entities = validateImportedEntities(body?.entities);
  if (!entities) {
    return NextResponse.json({ error: "invalid entities" }, { status: 400 });
  }
  const geos = importedEntitiesToGeos(entities, new Date().toISOString());
  const snapshot = await upsertEntityGeos(sessionId, geos);
  return NextResponse.json({
    ok: true,
    imported: geos.length,
    total_entities: snapshot.entities.length,
  });
}
