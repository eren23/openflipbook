"use client";

import { useEffect, useRef, useState } from "react";

// Read-only navigable world viewer for the /embed surface. Zero model calls:
// every navigation is a hop to an ALREADY-GENERATED node via the public
// children endpoint (the share-continue zero-generate hydration contract).
// Taps on unexplored ground get a hint instead of dead silence — the /n/
// permalink "dead taps" lesson, made an explicit UX contract at the frontier.

export interface EmbedNode {
  id: string;
  title: string;
  imageUrl: string;
}

interface ChildRow {
  id: string;
  page_title: string;
  image_url: string;
  click_in_parent: { x_pct: number; y_pct: number } | null;
}

interface EmbedViewerProps {
  initial: EmbedNode;
  continueUrl: string;
}

export default function EmbedViewer({ initial, continueUrl }: EmbedViewerProps) {
  const [current, setCurrent] = useState<EmbedNode>(initial);
  const [stack, setStack] = useState<EmbedNode[]>([]);
  const [children, setChildren] = useState<ChildRow[]>([]);
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  const hintTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChildren([]);
    (async () => {
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(current.id)}/children`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const json = (await res.json()) as { children: ChildRow[] };
        if (!cancelled) setChildren(json.children ?? []);
      } catch {
        /* frontier stays dotless; the continue link is always visible */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current.id]);

  const enter = (c: ChildRow) => {
    setStack((s) => [...s, current]);
    setCurrent({ id: c.id, title: c.page_title, imageUrl: c.image_url });
    setHint(null);
  };

  const back = () => {
    setStack((s) => {
      const prev = s[s.length - 1];
      if (prev) setCurrent(prev);
      return s.slice(0, -1);
    });
    setHint(null);
  };

  // A tap that misses every dot = unexplored ground: show a transient hint
  // anchored at the tap instead of doing nothing.
  const onGroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHint({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 2600);
  };

  const dots = children.filter(
    (c): c is ChildRow & { click_in_parent: { x_pct: number; y_pct: number } } =>
      c.click_in_parent != null
  );

  return (
    <div className="flex h-dvh flex-col bg-[#faf7f1] text-[#1c1917]">
      <header className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          {stack.length > 0 && (
            <button
              type="button"
              onClick={back}
              className="rounded-full border border-black/25 px-2.5 py-0.5 hover:bg-black/5"
            >
              ← back
            </button>
          )}
          <span className="truncate font-medium">{current.title}</span>
        </div>
        <span className="shrink-0 opacity-50">
          {dots.length > 0
            ? `${dots.length} place${dots.length === 1 ? "" : "s"} to enter`
            : "world frontier"}
        </span>
      </header>

      <div
        className="relative min-h-0 flex-1 cursor-pointer overflow-hidden"
        onClick={onGroundClick}
        data-testid="embed-stage"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.imageUrl}
          alt={current.title}
          className="h-full w-full object-contain"
          draggable={false}
        />
        {dots.map((c) => (
          <button
            key={c.id}
            type="button"
            title={`Enter ${c.page_title}`}
            onClick={(e) => {
              e.stopPropagation();
              enter(c);
            }}
            className="group absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${c.click_in_parent.x_pct * 100}%`,
              top: `${c.click_in_parent.y_pct * 100}%`,
            }}
          >
            <span className="block h-3.5 w-3.5 rounded-full border-2 border-white bg-amber-500 shadow-md transition-transform group-hover:scale-125" />
            <span className="pointer-events-none absolute left-1/2 top-4 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white group-hover:block">
              {c.page_title}
            </span>
          </button>
        ))}
        {hint && (
          <a
            href={continueUrl}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/80 px-3 py-1 text-[11px] text-white shadow-lg"
            style={{
              left: `${hint.x * 100}%`,
              top: `${Math.min(hint.y * 100 + 4, 92)}%`,
            }}
          >
            unexplored — continue this world on openflipbook →
          </a>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 px-3 py-2 text-[11px]">
        <span className="opacity-50">an openflipbook world</span>
        <a
          href={continueUrl}
          target="_blank"
          rel="noopener"
          className="rounded-full border border-black/25 px-3 py-1 font-medium hover:bg-black/5"
        >
          Continue this world →
        </a>
      </footer>
    </div>
  );
}
