import type { Metadata } from "next";

import AbortPanel from "./abort-panel";
import TraceList from "./trace-list";
import type { AbortStatsResponse, TraceRecentResponse } from "@/lib/trace-types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "openflipbook — trace dashboard",
};

async function fetchBackend<T>(path: string): Promise<T | null> {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return { ok: false, error: "MODAL_API_URL not set" } as unknown as T;
  }
  try {
    const res = await fetch(`${modalUrl.replace(/\/$/, "")}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` } as unknown as T;
    }
    return (await res.json()) as T;
  } catch (err) {
    return { ok: false, error: (err as Error).message } as unknown as T;
  }
}

export default async function TracePage() {
  const [initialTraces, initialAborts] = await Promise.all([
    fetchBackend<TraceRecentResponse>("/trace/recent?limit=50"),
    fetchBackend<AbortStatsResponse>("/trace/abort-stats?limit=20"),
  ]);
  return (
    <div className="min-h-screen bg-zinc-950 font-sans">
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-10 text-zinc-100">
        <header className="flex items-baseline justify-between gap-4">
          <h1 className="text-xl font-semibold">trace dashboard</h1>
          <span className="text-xs text-zinc-400">
            in-memory ring buffer (TRACE_BUFFER_MAX, default 200) • process-local
          </span>
        </header>

        <AbortPanel initial={initialAborts} />

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-zinc-100">recent traces</h2>
          <p className="max-w-3xl text-sm text-zinc-300">
            Recent completed traces grouped by{" "}
            <code className="text-zinc-100">x-trace-id</code>. Click a row to expand
            its flamegraph. Categories are coloured by span-name prefix (vlm,
            planner, image, video, world, prefetch, persist, network).
          </p>
          <TraceList initial={initialTraces} />
        </section>
      </main>
    </div>
  );
}
