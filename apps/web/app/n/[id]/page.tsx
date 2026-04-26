import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getNode, type NodeRow } from "@/lib/db";
import { readServerEnv } from "@/lib/env";

interface PermalinkPageProps {
  params: Promise<{ id: string }>;
}

const cachedGetNode = cache(async (id: string): Promise<NodeRow | null> => {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return null;
  }
  try {
    return await getNode(id);
  } catch {
    return null;
  }
});

function publicImageUrl(node: NodeRow): string | null {
  const env = readServerEnv();
  if (!env.R2_PUBLIC_BASE_URL) return null;
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/${node.image_key}`;
}

export async function generateMetadata({
  params,
}: PermalinkPageProps): Promise<Metadata> {
  const { id } = await params;
  const node = await cachedGetNode(id);
  if (!node) {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }
  const imageUrl = publicImageUrl(node);
  const title = node.page_title || node.query || "Generated page";
  const description = `AI-generated page for "${node.query}" — explore openflipbook, an open-source click-to-explore image canvas.`;
  return {
    title,
    description,
    openGraph: {
      type: "article",
      title,
      description,
      url: `/n/${id}`,
      ...(imageUrl
        ? {
            images: [
              {
                url: imageUrl,
                alt: `Illustration for "${node.query}"`,
              },
            ],
          }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(imageUrl ? { images: [imageUrl] } : {}),
    },
    alternates: { canonical: `/n/${id}` },
  };
}

export default async function PermalinkPage({ params }: PermalinkPageProps) {
  const { id } = await params;
  const env = readServerEnv();

  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-2xl font-bold">Persistence not configured</h1>
        <p className="mt-4 opacity-70">
          Set <code>MONGODB_URI</code>, <code>MONGODB_DB</code> and{" "}
          <code>R2_*</code> in your environment to enable permalinks. See{" "}
          <code>docs/BYO-KEYS.md</code>.
        </p>
        <p className="mt-6 text-xs opacity-60">Requested node: <code>{id}</code></p>
      </main>
    );
  }

  const node = await cachedGetNode(id);
  if (!node) notFound();

  const imageUrl = publicImageUrl(node)!;

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">{node.page_title}</h1>
        <a
          href={`/play?continue=${encodeURIComponent(node.session_id)}`}
          className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 text-xs"
        >
          Continue this session
        </a>
      </header>
      <figure className="overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 bg-white shadow-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={`Generated illustration for ${node.query}`}
          className="block h-auto w-full"
        />
      </figure>
      <footer className="text-center text-xs opacity-60">
        Query: <code>{node.query}</code> · Image: {node.image_model} · Prompt:{" "}
        {node.prompt_author_model}
      </footer>
    </main>
  );
}
