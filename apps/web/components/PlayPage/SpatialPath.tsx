"use client";

import type { Crumb } from "@/lib/breadcrumb";

interface Props {
  // [root … current], from buildBreadcrumb.
  crumbs: Crumb[];
  onNavigate: (nodeId: string) => void;
}

// The path as a zoom-out STACK: ancestors are nested cards behind the current
// scene, newest in front; click an ancestor to zoom out to it. The geometric
// world's spatial alternative to the breadcrumb chrome ("just tabs") — the path
// IS the depth. Additive: the classic breadcrumb stays mounted as a fallback.
export default function SpatialPath({ crumbs, onNavigate }: Props) {
  if (crumbs.length <= 1) return null;
  const n = crumbs.length;
  return (
    <div
      data-testid="spatial-path"
      className="pointer-events-none flex items-end"
      aria-label="zoom-out path"
    >
      {crumbs.map((c, i) => {
        const isCurrent = i === n - 1;
        const depthFromFront = n - 1 - i; // 0 = current scene (foremost)
        return (
          <button
            key={c.nodeId}
            type="button"
            data-testid="spatial-card"
            disabled={isCurrent}
            aria-current={isCurrent ? "page" : undefined}
            onClick={() => onNavigate(c.nodeId)}
            title={isCurrent ? c.title : `zoom out to ${c.title}`}
            style={{
              marginLeft: i === 0 ? 0 : -14,
              zIndex: i + 1,
              transform: `translateY(${depthFromFront * 3}px) scale(${
                1 - depthFromFront * 0.05
              })`,
            }}
            className={
              "pointer-events-auto max-w-[10rem] truncate rounded-md border px-2 py-1 text-[11px] shadow-sm transition " +
              (isCurrent
                ? "cursor-default border-sky-500 bg-white font-medium text-stone-800"
                : "border-black/15 bg-stone-100 text-stone-500 hover:bg-white hover:text-stone-800")
            }
          >
            {c.title}
          </button>
        );
      })}
    </div>
  );
}
