import { NextResponse } from "next/server";

import {
  deriveGeoFromExtraction,
  getWorldMap,
  upsertEntityGeos,
} from "@/lib/world-map";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

function geometricWorldEnabled(): boolean {
  const f = (process.env.GEOMETRIC_WORLD ?? "").toLowerCase();
  return f === "1" || f === "true" || f === "yes";
}

function emptyMap(sessionId: string) {
  return {
    session_id: sessionId,
    entities: [],
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    schema_version: 1,
    updated_at: new Date(0).toISOString(),
  };
}

// Hydrate a session's geometric world map. Inert (empty) when GEOMETRIC_WORLD is
// off or persistence is unconfigured — never errors the caller.
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!geometricWorldEnabled()) {
    return NextResponse.json({ ...emptyMap(sessionId), geometric_world_disabled: true });
  }
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ ...emptyMap(sessionId), persistence_disabled: true });
  }
  try {
    return NextResponse.json(await getWorldMap(sessionId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

// Mutate the map: `op:"derive"` seeds from an extraction pass (view + items);
// anything else upserts explicit `geos`. Gated behind GEOMETRIC_WORLD.
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!geometricWorldEnabled()) {
    return NextResponse.json({ error: "geometric world disabled" }, { status: 403 });
  }
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ error: "persistence disabled" }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      op?: string;
      view?: Parameters<typeof deriveGeoFromExtraction>[1];
      aspect?: number;
      items?: Parameters<typeof deriveGeoFromExtraction>[3];
      geos?: Parameters<typeof upsertEntityGeos>[1];
    };
    if (body.op === "derive" && body.view) {
      const snap = await deriveGeoFromExtraction(
        sessionId,
        body.view,
        body.aspect ?? 16 / 9,
        body.items ?? [],
      );
      return NextResponse.json(snap);
    }
    return NextResponse.json(await upsertEntityGeos(sessionId, body.geos ?? []));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
