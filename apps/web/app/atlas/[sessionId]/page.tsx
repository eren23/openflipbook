import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { listNodesBySession, type NodeRow } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import AtlasView, { type AtlasNode } from "@/components/atlas-view";

interface AtlasPageProps {
  params: Promise<{ sessionId: string }>;
}

const cachedSessionNodes = cache(async (sessionId: string): Promise<NodeRow[] | null> => {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return null;
  }
  try {
    const out: NodeRow[] = [];
    let cursor: string | null = null;
    // Paginate so big sessions still hydrate fully (listNodesBySession caps
    // at 200 per call). Cap at 20 pages = 4000 nodes — past that the layout
    // is unrenderable in a browser anyway and we'd rather fail loud than
    // silently truncate the DAG.
    let truncated = true;
    for (let i = 0; i < 20; i++) {
      const { rows, next_cursor } = await listNodesBySession(sessionId, {
        cursor,
        limit: 200,
      });
      out.push(...rows);
      if (!next_cursor) {
        truncated = false;
        break;
      }
      cursor = next_cursor;
    }
    if (truncated) {
      // eslint-disable-next-line no-console
      console.warn(
        `[atlas] session ${sessionId} hit pagination cap of 4000 nodes — DAG may be incomplete and orphan nodes may appear.`
      );
    }
    return out;
  } catch {
    return null;
  }
});

function publicImageUrl(key: string): string | null {
  const env = readServerEnv();
  if (!env.R2_PUBLIC_BASE_URL) return null;
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/${key}`;
}

export async function generateMetadata({
  params,
}: AtlasPageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const nodes = await cachedSessionNodes(sessionId);
  if (!nodes || nodes.length === 0) {
    return {
      title: "Atlas — empty",
      robots: { index: false, follow: false },
    };
  }
  const root = nodes.find((n) => n.parent_id == null) ?? nodes[0]!;
  const title = `Atlas: ${root.page_title || root.query}`;
  const description = `An openflipbook session — ${nodes.length} pages. Pan, zoom, and explore the branching tree.`;
  const ogImage = publicImageUrl(root.image_key);
  return {
    title,
    description,
    openGraph: {
      type: "article",
      title,
      description,
      url: `/atlas/${sessionId}`,
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
    alternates: { canonical: `/atlas/${sessionId}` },
  };
}

export default async function AtlasPage({ params }: AtlasPageProps) {
  const { sessionId } = await params;
  const env = readServerEnv();

  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-2xl font-bold">Atlas needs persistence</h1>
        <p className="mt-4 opacity-70">
          Set <code>MONGODB_URI</code>, <code>MONGODB_DB</code> and{" "}
          <code>R2_*</code> in your environment to view session atlases.
        </p>
        <Link
          href="/play"
          className="mt-6 rounded-full border border-[var(--color-ink)]/40 px-4 py-2 text-sm"
        >
          Back to /play
        </Link>
      </main>
    );
  }

  const rows = await cachedSessionNodes(sessionId);
  if (!rows || rows.length === 0) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-2xl font-bold">No pages in this session yet</h1>
        <p className="mt-4 opacity-70">
          Either the session id is unknown, or nobody has generated a page for{" "}
          it.
        </p>
        <p className="mt-2 text-xs opacity-50">
          <code>{sessionId}</code>
        </p>
        <Link
          href="/play"
          className="mt-6 rounded-full border border-[var(--color-ink)]/40 px-4 py-2 text-sm"
        >
          Start a new session
        </Link>
      </main>
    );
  }

  const publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");
  const nodes: AtlasNode[] = rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    title: row.page_title || row.query,
    query: row.query,
    imageUrl: `${publicBase}/${row.image_key}`,
    clickInParent: row.click_in_parent
      ? {
          xPct: row.click_in_parent.x_pct,
          yPct: row.click_in_parent.y_pct,
        }
      : null,
    createdAt: row.created_at,
    imageModel: row.image_model,
    promptAuthorModel: row.prompt_author_model,
  }));

  const latest = nodes[nodes.length - 1];
  const root = nodes.find((n) => n.parentId == null) ?? nodes[0];

  return (
    <AtlasView
      sessionId={sessionId}
      nodes={nodes}
      latestNodeId={latest?.id ?? null}
      rootTitle={root?.title ?? "session"}
    />
  );
}
