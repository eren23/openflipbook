import Link from "next/link";

import { listPublishedSessions } from "@/lib/db";
import { readServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** The opt-in public gallery: sessions their owners chose to publish
 * (right-click → "Publish session to gallery"), newest first. Each card
 * fronts the published page and links into its permalink. */
export default async function GalleryPage() {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Gallery</h1>
        <p className="mt-4 opacity-70">Persistence is not configured.</p>
      </main>
    );
  }
  const rows = await listPublishedSessions(60);
  const base = (env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Gallery</h1>
        <Link href="/play" className="text-sm underline opacity-70">
          ← back to the canvas
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="opacity-70">
          Nothing published yet. In a session, right-click a page and choose
          “Publish session to gallery”.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <li key={row.session_id}>
              <Link
                href={`/n/${row.node_id}`}
                className="block overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] shadow-sm transition-shadow hover:shadow-md"
              >
                {base && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${base}/${row.poster_key}`}
                    alt={row.title}
                    className="aspect-video w-full object-cover"
                    loading="lazy"
                  />
                )}
                <div className="px-4 py-3">
                  <h2 className="truncate text-sm font-medium">{row.title}</h2>
                  <p className="mt-1 truncate text-xs opacity-60">{row.query}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
