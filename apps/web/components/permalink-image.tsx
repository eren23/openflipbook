"use client";

import { useEffect, useState } from "react";
import HeatmapOverlay from "@/components/heatmap-overlay";

interface PermalinkImageProps {
  nodeId: string;
  imageUrl: string;
  query: string;
  sessionId: string;
}

export default function PermalinkImage({
  nodeId,
  imageUrl,
  query,
  sessionId,
}: PermalinkImageProps) {
  const [showHeatmap, setShowHeatmap] = useState(false);

  // Persist last-viewed session so the landing's "open your last atlas" link
  // resolves. Cheap, no PII.
  useEffect(() => {
    try {
      window.localStorage.setItem("openflipbook.lastSession", sessionId);
    } catch {
      /* no-op */
    }
  }, [sessionId]);

  // Restore the heatmap pref so a curious viewer doesn't have to keep
  // re-toggling across pages.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem("openflipbook.heatmap");
      if (v === "1") setShowHeatmap(true);
    } catch {
      /* no-op */
    }
  }, []);

  const toggle = () => {
    setShowHeatmap((cur) => {
      const next = !cur;
      try {
        window.localStorage.setItem("openflipbook.heatmap", next ? "1" : "0");
      } catch {
        /* no-op */
      }
      return next;
    });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <a
            href={`/atlas/${encodeURIComponent(sessionId)}`}
            className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 hover:bg-[var(--color-ink)]/5"
          >
            Open atlas
          </a>
          <button
            type="button"
            onClick={toggle}
            className={
              "rounded-full border px-3 py-1 " +
              (showHeatmap
                ? "border-red-500 bg-red-500 text-white"
                : "border-[var(--color-ink)]/40 hover:bg-[var(--color-ink)]/5")
            }
            title="Show where children of this page were tapped"
          >
            {showHeatmap ? "hide taps" : "show what others tapped"}
          </button>
        </div>
        <span className="opacity-50">node {nodeId.slice(0, 8)}</span>
      </div>
      <figure className="relative overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 bg-white shadow-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={`Generated illustration for ${query}`}
          className="block h-auto w-full"
        />
        {showHeatmap && <HeatmapOverlay parentId={nodeId} />}
      </figure>
    </>
  );
}
