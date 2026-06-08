"use client";

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
  if (crumbs.length < 2) return null;
  return (
    <nav
      aria-label="Location"
      data-testid="breadcrumb"
      className="flex flex-wrap items-center gap-0.5 text-xs"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
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
