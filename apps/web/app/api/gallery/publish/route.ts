import { NextResponse } from "next/server";

import { getNode, publishSession, unpublishSession } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publish a session to the public gallery, fronted by one of its pages.
 * Gated on the backend's moderation hook (instant allow when MODERATE_PROMPTS
 * is off; fail-open on moderation-infra hiccups — same posture as generate).
 * The node must belong to the session, so a guessed node id can't front a
 * stranger's session. */
export async function POST(req: Request) {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 },
    );
  }
  let body: { session_id?: string; node_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.session_id || !body.node_id) {
    return NextResponse.json(
      { error: "missing session_id / node_id" },
      { status: 400 },
    );
  }
  const node = await getNode(body.node_id);
  if (!node || node.session_id !== body.session_id) {
    return NextResponse.json(
      { error: "node not found in this session" },
      { status: 404 },
    );
  }

  if (env.MODAL_API_URL) {
    try {
      const upstream = await fetch(
        joinModalUrl(env.MODAL_API_URL, "/moderate-text"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...modalAuthHeaders() },
          body: JSON.stringify({
            text: `${node.page_title}\n${node.query}\n${node.final_prompt ?? ""}`,
          }),
        },
      );
      const verdict = (await upstream.json()) as {
        allowed?: boolean;
        reason?: string;
      };
      if (verdict.allowed === false) {
        return NextResponse.json(
          { error: `blocked by moderation: ${verdict.reason ?? ""}` },
          { status: 403 },
        );
      }
    } catch {
      // fail-open: moderation infra never blocks a self-hoster's publish
    }
  }

  await publishSession({
    session_id: body.session_id,
    node_id: node.id,
    title: node.page_title || node.query,
    query: node.query,
    poster_key: node.image_key,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 },
    );
  }
  const sessionId = new URL(req.url).searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "missing session_id" }, { status: 400 });
  }
  const removed = await unpublishSession(sessionId);
  return NextResponse.json({ ok: true, removed });
}
