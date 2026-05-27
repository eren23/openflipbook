"use client";

import { useEffect, useState } from "react";

import type { AbortStatsResponse } from "@/lib/trace-types";

const POLL_INTERVAL_MS = 10_000;

export default function AbortPanel({ initial }: { initial: AbortStatsResponse | null }) {
  const [data, setData] = useState<AbortStatsResponse | null>(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/trace/abort-stats?limit=20", { cache: "no-store" });
        const parsed = (await res.json()) as AbortStatsResponse;
        if (!cancelled) {
          setData(parsed);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) return null;
  if (data.error) {
    return (
      <div className="rounded-md border border-red-700 bg-red-900/30 px-3 py-2 text-sm text-red-200">
        abort-stats unavailable: {data.error}
      </div>
    );
  }

  const total = data.total ?? 0;
  const byStage = data.by_stage ?? [];
  const totalWastedUsd = byStage.reduce((sum, row) => sum + row.wasted_usd, 0);
  const totalWastedMs = byStage.reduce((sum, row) => sum + row.wasted_ms, 0);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">stale-click audit</h2>
        <span className="text-xs text-zinc-500">
          {total} aborts • {(totalWastedMs / 1000).toFixed(1)}s wasted • ~$
          {totalWastedUsd.toFixed(4)} estimated
        </span>
      </div>

      {error ? (
        <div className="mb-2 text-xs text-zinc-500">last poll error: {error}</div>
      ) : null}

      {byStage.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No aborts recorded yet. Aborts are tallied per stage when{" "}
          <code className="text-zinc-300">Request.is_disconnected()</code> trips
          during page generation.
        </p>
      ) : (
        <table className="w-full text-left text-xs text-zinc-300">
          <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-1 pr-3">stage</th>
              <th className="py-1 pr-3 text-right">count</th>
              <th className="py-1 pr-3 text-right">wasted s</th>
              <th className="py-1 pr-3 text-right">est $</th>
              <th className="py-1 text-right">$/sec</th>
            </tr>
          </thead>
          <tbody>
            {byStage.map((row) => (
              <tr key={row.stage} className="border-t border-zinc-900">
                <td className="py-1 pr-3">
                  <code className="text-zinc-200">{row.stage}</code>
                </td>
                <td className="py-1 pr-3 text-right">{row.count}</td>
                <td className="py-1 pr-3 text-right">
                  {(row.wasted_ms / 1000).toFixed(2)}
                </td>
                <td className="py-1 pr-3 text-right">${row.wasted_usd.toFixed(5)}</td>
                <td className="py-1 text-right text-zinc-500">
                  ${row.cost_per_sec.toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-3 text-[10px] text-zinc-500">
        Cost rates default to:{" "}
        <code>$0.005/s</code> click-resolve, <code>$0.020/s</code> planner +
        image-gen. Override per stage via{" "}
        <code>ABORT_COST_PER_SEC_&lt;STAGE&gt;</code> env on the backend.
      </p>
    </section>
  );
}
