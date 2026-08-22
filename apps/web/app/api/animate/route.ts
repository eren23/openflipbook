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
  // A ?continue=-hydrated page carries the R2 PUBLIC URL, not a data URI —
  // on the docker stack that's a localhost minio URL fal refuses ("Input
  // must be a valid HTTPS URL or a Data URI", live-caught 2026-08-22).
  // Same inline-before-forward treatment the resolve-click and
  // generate-page proxies already have; animate was the one that skipped it.
  try {
    const parsed = JSON.parse(body) as { image_data_url?: string };
    if (parsed.image_data_url && !parsed.image_data_url.startsWith("data:")) {
      const inlined = await inlineStoredImage(parsed.image_data_url);
      if (inlined) {
        parsed.image_data_url = inlined;
        body = JSON.stringify(parsed);
      }
    }
  } catch {
    /* non-JSON body — forward as-is, the backend rejects it */
  }
  let upstream: Response;
  try {
    upstream = await fetch(joinModalUrl(modalUrl, "/animate"), {
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
