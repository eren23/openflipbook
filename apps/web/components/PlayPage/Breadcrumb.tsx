"use client";

import { useState } from "react";

import type { Crumb } from "@/lib/breadcrumb";

interface Props {
  crumbs: Crumb[];
  onJump: (nodeId: string) => void;
}

function short(title: string): string {
  return title.length > 28 ? title.slice(0, 27) + "…" : title;
}

// The location trail: root … current. Ancestors are buttons (jump straight back
// — the leftmost is the map you started from); the current page is plain text.
// Hidden until you've actually gone in (a single crumb is just the current page).
export default function Breadcrumb({ crumbs, onJump }: Props) {
  // Deep trails collapse to root › … › last two (presentation only — the
  // data stays intact; "…" expands the full trail). A4 cheap fix.
  const [expanded, setExpanded] = useState(false);
  if (crumbs.length < 2) return null;
  const collapsed = !expanded && crumbs.length > 4;
  const visible: (Crumb | "ellipsis")[] = collapsed
    ? [crumbs[0]!, "ellipsis", ...crumbs.slice(-2)]
    : crumbs;
  return (
    <nav
      aria-label="Location"
      data-testid="breadcrumb"
      className="flex flex-wrap items-center gap-0.5 text-xs"
    >
      {visible.map((c, i) => {
        if (c === "ellipsis") {
          return (
            <span key="ellipsis" className="flex items-center gap-0.5">
              <span aria-hidden className="px-0.5 opacity-40">
                ›
              </span>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                title={`Show all ${crumbs.length} steps`}
                className="rounded px-1 py-0.5 opacity-70 hover:bg-[var(--color-ink)]/10 hover:opacity-100"
              >
                …
              </button>
            </span>
          );
        }
        const isLast = i === visible.length - 1;
        return (
          <span key={c.nodeId} className="flex items-center gap-0.5">
            {i > 0 && (
              <span aria-hidden className="px-0.5 opacity-40">
                ›
              </span>
            )}
            {isLast ? (
              <span
                aria-current="page"
                title={c.title}
                className="font-semibold text-[var(--color-ink)]"
              >
                {short(c.title)}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onJump(c.nodeId)}
                title={`Back to ${c.title}`}
                className="rounded px-1 py-0.5 opacity-70 hover:bg-[var(--color-ink)]/10 hover:opacity-100"
              >
                {short(c.title)}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
