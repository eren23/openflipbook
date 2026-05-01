import { NextResponse } from "next/server";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { error: "MODAL_API_URL not set." },
      { status: 503 }
    );
  }
  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${modalUrl.replace(/\/$/, "")}/resolve-click`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId },
      body,
      signal: req.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw err;
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
      [TRACE_HEADER]: traceId,
    },
  });
}
