import { NextResponse } from "next/server";

import { countPresence, watchSessionNodes } from "@/lib/db";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

/** The shared-session read-along feed (Wave 8): an SSE stream of this
 * session's node inserts (via a Mongo change stream — needs the compose
 * stack's single-node replica set) plus a periodic live viewer count.
 * On a standalone Mongo the stream says `unsupported` once and ends —
 * the feature soft-degrades, nothing else breaks. */
export async function GET(req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };

      let watcher: Awaited<ReturnType<typeof watchSessionNodes>> | null = null;
      try {
        watcher = await watchSessionNodes(sessionId);
      } catch {
        send({ type: "unsupported" });
        finish();
        return;
      }

      send({ type: "hello", viewers: await countPresence(sessionId).catch(() => 0) });
      const ping = setInterval(() => {
        void countPresence(sessionId)
          .then((viewers) => send({ type: "presence", viewers }))
          .catch(() => {});
      }, 20_000);

      const teardown = () => {
        clearInterval(ping);
        void watcher?.close().catch(() => {});
        finish();
      };
      req.signal.addEventListener("abort", teardown);

      try {
        for await (const ev of watcher) {
          const doc = (ev as { fullDocument?: Record<string, unknown> })
            .fullDocument;
          if (!doc) continue;
          send({
            type: "node_added",
            node: {
              id: String(doc._id),
              parent_id: (doc.parent_id as string | null) ?? null,
              title: String(doc.page_title || doc.query || ""),
              created_at: doc.created_at instanceof Date
                ? doc.created_at.toISOString()
                : String(doc.created_at ?? ""),
            },
          });
        }
      } catch {
        // A standalone Mongo throws here on the first pull; an aborted
        // stream lands here too. Either way: degrade quietly.
        send({ type: "unsupported" });
      } finally {
        teardown();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
