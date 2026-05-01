import { NextResponse } from "next/server";
import { listRecentErrors, recordError } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { TRACE_HEADER } from "@/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingError {
  trace_id?: string | null;
  kind?: string;
  message?: string;
  stack?: string;
  body_excerpt?: string;
  source?: "client" | "backend";
}

export async function POST(req: Request) {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 }
    );
  }

  let body: IncomingError;
  try {
    body = (await req.json()) as IncomingError;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  // Coerce every field to string before .slice — the body is `as IncomingError`
  // (a cast, not validation) so a buggy client could send numbers/booleans
  // and we'd 500 on `.slice` if we trusted the type.
  const traceId =
    req.headers.get(TRACE_HEADER) ??
    (typeof body.trace_id === "string" ? body.trace_id : null);
  const kind = String(body.kind ?? "client").slice(0, 64);
  const message = String(body.message ?? "(no message)").slice(0, 2000);
  const stack = body.stack != null ? String(body.stack).slice(0, 4000) : null;
  const bodyExcerpt =
    body.body_excerpt != null
      ? String(body.body_excerpt).slice(0, 1000)
      : null;

  await recordError({
    trace_id: traceId,
    kind,
    message,
    stack,
    body_excerpt: bodyExcerpt,
    source: body.source === "backend" ? "backend" : "client",
  });
  return NextResponse.json({ ok: true, trace_id: traceId });
}

export async function GET(req: Request) {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ errors: [] }, { status: 200 });
  }
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const errors = await listRecentErrors(Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ errors });
}
