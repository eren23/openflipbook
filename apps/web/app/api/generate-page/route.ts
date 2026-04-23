import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxies to the user's Modal-hosted generate endpoint as SSE.
 * Full implementation lands in step 3 of the build order.
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

  const upstream = await fetch(`${modalUrl.replace(/\/$/, "")}/sse/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream returned HTTP ${upstream.status}` },
      { status: 502 }
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
