import { NextResponse } from "next/server";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { inlineStoredImage } from "@/lib/r2";
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
  let body = await req.text();
  // Reopened nodes resolve clicks against their STORE URL — on the docker
  // stack a localhost minio URL the VLM providers refuse to fetch. Inline
  // our own stored bytes (best-effort; see lib/r2.inlineStoredImage).
  try {
    const parsed = JSON.parse(body) as { image_data_url?: string };
    if (parsed?.image_data_url && !parsed.image_data_url.startsWith("data:")) {
      const inlined = await inlineStoredImage(parsed.image_data_url);
      if (inlined) {
        parsed.image_data_url = inlined;
        body = JSON.stringify(parsed);
      }
    }
  } catch {
    // malformed body -> forward verbatim, the backend surfaces the error
  }
  let upstream: Response;
  try {
    upstream = await fetch(joinModalUrl(modalUrl, "/resolve-click"), {
      method: "POST",
      headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId, ...modalAuthHeaders() },
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
