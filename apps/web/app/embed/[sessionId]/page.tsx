import type { Metadata } from "next";
import { notFound } from "next/navigation";

import EmbedViewer from "@/components/embed-viewer";
import {
  getNode,
  getPublishedSession,
  getSessionRootNode,
  type NodeRow,
} from "@/lib/db";
import { readServerEnv } from "@/lib/env";

// Read-only embeddable world viewer. PUBLISH-GATED: only sessions the owner
// put in the gallery render here — a leaked session id must not make a
// private world frameable (the embed exposes the whole session graph, wider
// than one /n/ node). Zero model calls on this surface; navigation hops
// through already-generated nodes only.

interface EmbedPageProps {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ node?: string }>;
}

export const metadata: Metadata = {
  // A widget surface, not a destination — the canonical pages are /n/<id>.
  robots: { index: false, follow: false },
  title: "openflipbook world",
};

export default async function EmbedPage({ params, searchParams }: EmbedPageProps) {
  let { sessionId } = await params;
  const { node: nodeParam } = await searchParams;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    notFound();
  }

  // public/embed.js mounts /n/<nodeId> permalinks as /embed/_from-node?node=…
  // (the script can't resolve node → session client-side). Resolve it here;
  // the publish gate below still applies to the resolved session.
  if (sessionId === "_from-node") {
    const viaNode = nodeParam ? await getNode(nodeParam).catch(() => null) : null;
    if (!viaNode) notFound();
    sessionId = viaNode.session_id;
  }

  const published = await getPublishedSession(sessionId).catch(() => null);
  if (!published) notFound();

  let start: NodeRow | null = null;
  if (nodeParam) {
    const candidate = await getNode(nodeParam).catch(() => null);
    // A ?node= from another session must not smuggle a foreign page into
    // this session's published frame.
    if (candidate && candidate.session_id === sessionId) start = candidate;
  }
  if (!start) start = await getSessionRootNode(sessionId).catch(() => null);
  if (!start) notFound();

  const base = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");
  return (
    <EmbedViewer
      sessionId={sessionId}
      initial={{
        id: start.id,
        title: start.page_title || start.query || published.title,
        imageUrl: `${base}/${start.image_key}`,
      }}
      continueUrl={`/play?continue=${encodeURIComponent(sessionId)}`}
    />
  );
}
