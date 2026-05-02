"use client";

import { useMemo } from "react";
import { layoutPages, type LayoutInput } from "@/lib/world-layout";

interface SessionMinimapProps {
  pages: LayoutInput[];
  activeNodeId: string | null;
  onExpand: () => void;
  onJump: (nodeId: string) => void;
}

const W = 180;
const H = 110;

export default function SessionMinimap({
  pages,
  activeNodeId,
  onExpand,
  onJump,
}: SessionMinimapProps) {
  const filtered = useMemo(
    () =>
      pages.filter((p): p is LayoutInput & { nodeId: string } =>
        Boolean(p.nodeId)
      ),
    [pages]
  );

  const { laid, box } = useMemo(() => {
    const result = layoutPages(filtered);
    if (result.pages.length === 0) {
      return { laid: result.pages, box: { x: 0, y: 0, w: 1, h: 1, scale: 1 } };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of result.pages) {
      minX = Math.min(minX, p.rect.x);
      minY = Math.min(minY, p.rect.y);
      maxX = Math.max(maxX, p.rect.x + p.rect.w);
      maxY = Math.max(maxY, p.rect.y + p.rect.h);
    }
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const pad = 6;
    const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
    return { laid: result.pages, box: { x: minX, y: minY, w, h, scale } };
  }, [filtered]);

  if (laid.length === 0) return null;

  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-30 rounded-xl border border-[var(--color-ink)]/30 bg-[var(--color-canvas)]/85 p-1.5 shadow-xl backdrop-blur">
      <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[10px] uppercase tracking-wide opacity-60">
        <span>session</span>
        <button
          type="button"
          onClick={onExpand}
          className="rounded-full border border-[var(--color-ink)]/30 px-2 py-0.5 text-[10px] hover:bg-[var(--color-ink)]/10"
          title="Open the full map (M)"
        >
          expand
        </button>
      </div>
      <div
        className="relative rounded bg-[var(--color-ink)]/5"
        style={{
          width: W,
          height: H,
          backgroundImage:
            "radial-gradient(rgba(15,15,15,0.18) 0.5px, transparent 0.5px)",
          backgroundSize: "8px 8px",
        }}
      >
        {laid.map((p) => {
          const isActive = p.nodeId === activeNodeId;
          return (
            <button
              key={p.nodeId}
              type="button"
              onClick={() => onJump(p.nodeId)}
              className={
                "absolute rounded-sm transition-transform " +
                (isActive ? "ofb-mini-active" : "")
              }
              style={{
                left: 6 + (p.rect.x - box.x) * box.scale,
                top: 6 + (p.rect.y - box.y) * box.scale,
                width: Math.max(2, p.rect.w * box.scale),
                height: Math.max(2, p.rect.h * box.scale),
                background: isActive
                  ? "rgba(239,68,68,0.95)"
                  : "rgba(15,15,15,0.55)",
                outline: isActive
                  ? "2px solid rgba(239,68,68,0.6)"
                  : "none",
                outlineOffset: isActive ? 2 : 0,
              }}
              title={p.title}
            />
          );
        })}
      </div>
      <div className="mt-1 px-1 text-[10px] opacity-50">{laid.length} pages</div>
    </div>
  );
}
