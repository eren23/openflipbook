import { NextResponse } from "next/server";

import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { inlineStoredImage } from "@/lib/r2";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Paint a drawn route: a keyframe per shot, a clip between neighbours.
 *
 *  A proxy, like /api/animate — the work is the modal backend's /walk. The
 *  client owns the geometry (it renders each camera's block control and says
 *  what that camera sees), because the renderer is the web app's.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const modalApi = process.env.MODAL_API_URL;
  if (!modalApi) {
    return NextResponse.json({ error: "MODAL_API_URL not set." }, { status: 503 });
  }
  const { sessionId } = await params;
  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  // A ?continue=-hydrated page carries the R2 PUBLIC url, not a data URI, and
  // on the docker stack that is a localhost minio url fal refuses. Same
  // inline-before-forward the animate proxy already does.
  const style = payload.style_ref_url;
  if (typeof style === "string" && !style.startsWith("data:")) {
    payload.style_ref_url = (await inlineStoredImage(style)) ?? style;
  }
  payload.session_id = sessionId;

  let upstream: Response;
  try {
    upstream = await fetch(joinModalUrl(modalApi, "/walk"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TRACE_HEADER]: traceId,
        ...modalAuthHeaders(),
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return new Response(null, { status: 499 });
    throw err;
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "X-Trace-Id": traceId },
  });
}
