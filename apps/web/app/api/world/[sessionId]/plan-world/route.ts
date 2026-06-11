import { NextResponse } from "next/server";
import { readServerEnv } from "@/lib/env";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";
import type { PlanWorldResponse } from "@openflipbook/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

// Describe a place -> a logical object world (B1). A thin proxy to the Modal
// backend's /plan-world, which parses the description into a SceneGraph and runs
// the deterministic solver server-side. The flag gate (WORLD_FROM_DESCRIPTION)
// lives on the backend — it 403s when off and we relay that. No Mongo here; the
// client seeds the returned `solved` geos via /api/world/[id]/map.
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MODAL_API_URL) {
    return NextResponse.json({ error: "MODAL_API_URL is not set" }, { status: 503 });
  }
  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  let body: { description?: string; answers?: string[] };
  try {
    body = (await req.json()) as { description?: string; answers?: string[] };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const description = (body.description ?? "").trim();
  if (!description) {
    return NextResponse.json(
      { error: "missing required field: description" },
      { status: 400 }
    );
  }
  try {
    const upstream = await fetch(joinModalUrl(env.MODAL_API_URL, "/plan-world"), {
      method: "POST",
      headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId, ...modalAuthHeaders() },
      body: JSON.stringify({
        session_id: sessionId,
        description,
        answers: Array.isArray(body.answers) ? body.answers : [],
        trace_id: traceId,
      }),
    });
    const payload = (await upstream.json().catch(() => ({}))) as
      | (Partial<PlanWorldResponse> & { error?: string });
    return NextResponse.json(payload, {
      status: upstream.ok ? 200 : upstream.status,
      headers: { [TRACE_HEADER]: traceId },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `plan-world upstream failed: ${(err as Error).message}`, trace_id: traceId },
      { status: 502, headers: { [TRACE_HEADER]: traceId } }
    );
  }
}
