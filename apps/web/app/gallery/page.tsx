import Link from "next/link";

import ForkButton from "@/components/fork-button";
import TourButton from "@/components/tour-button";
import { galleryStats, listPublishedSessions } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { countMapEntities } from "@/lib/world-map";

export const dynamic = "force-dynamic";

/** The opt-in public gallery, upgraded from a thumbnail grid to a shelf of
 * WORLDS: each card carries the world's stats (pages / places / forks) and
 * its own tour + fork actions beside the permalink link-through. Sessions
 * appear here only when their owners published them (right-click →
 * "Publish session to gallery"), newest first. */
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
  const ids = rows.map((r) => r.session_id);
  const [stats, places] = await Promise.all([
    galleryStats(ids),
    countMapEntities(ids).catch(() => new Map<string, number>()),
  ]);
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
          {rows.map((row) => {
            const s = stats.get(row.session_id) ?? { pages: 0, forks: 0 };
            const placeCount = places.get(row.session_id) ?? 0;
            return (
              <li
                key={row.session_id}
                className="overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] shadow-sm transition-shadow hover:shadow-md"
              >
                <Link href={`/n/${row.node_id}`} className="block">
                  {base && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${base}/${row.poster_key}`}
                      alt={row.title}
                      className="aspect-video w-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="px-4 pt-3">
                    <h2 className="truncate text-sm font-medium">{row.title}</h2>
                    <p className="mt-1 truncate text-xs opacity-60">{row.query}</p>
                    <p className="mt-1 text-xs opacity-50">
                      {s.pages} page{s.pages === 1 ? "" : "s"}
                      {placeCount > 0 &&
                        ` · ${placeCount} place${placeCount === 1 ? "" : "s"}`}
                      {s.forks > 0 &&
                        ` · ${s.forks} fork${s.forks === 1 ? "" : "s"}`}
                    </p>
                  </div>
                </Link>
                <div className="flex items-center gap-2 px-4 pb-3 pt-2">
                  <TourButton
                    sessionId={row.session_id}
                    continueUrl={`/play?continue=${encodeURIComponent(row.session_id)}`}
                  />
                  <ForkButton sessionId={row.session_id} nodeId={row.node_id} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
