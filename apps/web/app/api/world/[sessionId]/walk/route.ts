import { NextResponse } from "next/server";

import type { StoredWalk, WalkClipRow } from "@openflipbook/config";

/** One shot as the client posts it: `sees` is a pair per place, matching the
 *  backend's model, not the named shape a stored walk keeps. */
interface PostedShot {
  index: number;
  distance?: number;
  sees?: [string, number][];
}

import { getNode, setNodeWalk } from "@/lib/db";
import { verifyOwnerReadonly } from "@/lib/session-owner";

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
  // A walk is paid for, so it outlives the tab that made it: keep the clips
  // and what each shot was OF on the page the route was drawn on. The
  // keyframes are left behind deliberately -- they return as data URIs, and a
  // node row is read on every visit.
  //
  // Painting is open, like /api/animate; KEEPING it on a node is the owner's,
  // like the clip save in PATCH /api/nodes/[id]. And the node id comes from
  // the body while the session comes from the url, so the node must actually
  // be in that session -- otherwise a caller names their own session and
  // somebody else's node. Readonly: a walk must not claim a session, and this
  // response is a plain Response that may not carry a Set-Cookie.
  const nodeId = typeof payload.node_id === "string" ? payload.node_id : null;
  const node = upstream.ok && nodeId ? await getNode(nodeId).catch(() => null) : null;
  const mayKeep = !!node && node.session_id === sessionId && (await verifyOwnerReadonly(sessionId)).ok;
  if (mayKeep && nodeId) {
    try {
      const done = JSON.parse(text) as { clips?: WalkClipRow[]; spent_usd?: number };
      if (done.clips?.length) {
        const walk: StoredWalk = {
          clips: done.clips,
          // The wire carries `sees` as [label, share] pairs, which is the
          // shape the backend's model takes. Stored rows are read back by
          // name, so name them here rather than keeping tuples in the world.
          shots: (payload.shots as PostedShot[] | undefined)?.map((s) => ({
            index: s.index,
            distance: s.distance ?? 0,
            sees: (s.sees ?? []).map(([label, share]) => ({ label, share })),
          })) ?? [],
          spent_usd: done.spent_usd ?? 0,
          created_at: new Date().toISOString(),
        };
        await setNodeWalk(nodeId, walk);
      }
    } catch {
      // Keeping the walk is a convenience; never fail the response over it.
    }
  }
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "X-Trace-Id": traceId },
  });
}
