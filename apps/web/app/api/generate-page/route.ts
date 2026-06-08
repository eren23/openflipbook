import { NextResponse } from "next/server";
import type { GenerateRequestBody } from "@openflipbook/config";
import { resolveEntitiesForPrompt } from "@/lib/world";
import { getWorldMap } from "@/lib/world-map";
import { modalUrl as joinModalUrl } from "@/lib/modal";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxies to the user's Modal-hosted generate endpoint as SSE.
 *
 * Before forwarding, we resolve the session's world-memory registry and attach
 * a slim continuity slice (`world_context`) to the outgoing body so the planner
 * can preserve recurring characters / places without the user having to
 * re-describe them. Mongo lives on this side; the backend stays stateless.
 */
export async function POST(req: Request) {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      {
        error:
          "MODAL_API_URL is not set. Run `modal deploy` in apps/modal-backend and paste the printed URL into .env.local.",
      },
      { status: 503 }
    );
  }

  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  // Parse once so we can inject world_context. Fall back to the raw text
  // path if anything looks malformed — we don't want this enrichment to
  // ever block generation.
  const rawText = await req.text();
  let upstreamBody = rawText;
  try {
    const parsed = JSON.parse(rawText) as GenerateRequestBody;
    if (parsed && parsed.session_id && parsed.query && !parsed.world_context) {
      const world_context = await resolveEntitiesForPrompt({
        sessionId: parsed.session_id,
        query: parsed.query,
        parentTitle: parsed.parent_title ?? null,
        parentQuery: parsed.parent_query ?? null,
        parentNodeId: parsed.current_node_id || null,
      });
      if (world_context.length > 0) {
        // FIX C: join geometric size (footprint/height) from the session's
        // world_map so the planner can keep recurring entities at a consistent
        // relative scale across pages. Best-effort — a missing/empty map just
        // omits sizes and the planner behaves exactly as before.
        try {
          const geo = await getWorldMap(parsed.session_id);
          const sizeById = new Map(
            geo.entities
              .filter((g) => g.entity_id)
              .map((g) => [
                g.entity_id as string,
                { footprint: g.footprint, height: g.height },
              ])
          );
          for (const wc of world_context) {
            const s = sizeById.get(wc.id);
            if (s) {
              wc.footprint = s.footprint;
              wc.height = s.height;
            }
          }
        } catch {
          // size enrichment is best-effort; never block generation
        }
        upstreamBody = JSON.stringify({ ...parsed, world_context });
      }
    }
  } catch {
    // Body is presumably already the right shape (or malformed enough
    // that the backend will surface the error). Forward verbatim.
    upstreamBody = rawText;
  }

  const upstream = await fetch(joinModalUrl(modalUrl, "/sse/generate"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [TRACE_HEADER]: traceId,
    },
    body: upstreamBody,
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream returned HTTP ${upstream.status}`, trace_id: traceId },
      { status: 502, headers: { [TRACE_HEADER]: traceId } }
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      [TRACE_HEADER]: traceId,
    },
  });
}
