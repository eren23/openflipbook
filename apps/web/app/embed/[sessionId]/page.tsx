import type { Metadata } from "next";
import { notFound } from "next/navigation";

import EmbedViewer from "@/components/embed-viewer";
import { resolveEmbedStart } from "@/lib/embed-resolve";
import { readServerEnv } from "@/lib/env";
import { formatViewVerdict } from "@/lib/view-verdict";

// Read-only embeddable world viewer. PUBLISH-GATED: only sessions the owner
// put in the gallery render here — a leaked session id must not make a
// private world frameable (the embed exposes the whole session graph, wider
// than one /n/ node). Zero model calls on this surface; navigation hops
// through already-generated nodes only. The gate / `_from-node` sentinel /
// foreign-node rejection live in lib/embed-resolve.ts (unit-tested).

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
  const { sessionId: rawSessionId } = await params;
  const { node: nodeParam } = await searchParams;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    notFound();
  }

  const resolved = await resolveEmbedStart(rawSessionId, nodeParam);
  if (!resolved) notFound();
  const { sessionId, published, start } = resolved;

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
      initialReceipt={
        start.view_verdict ? formatViewVerdict(start.view_verdict) : null
      }
    />
  );
}
