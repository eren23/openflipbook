"use client";

import { useEffect, useRef } from "react";

interface QuickbarItem {
  nodeId: string | null;
  title: string;
  query: string;
}

interface Props {
  query: string;
  setQuery: (q: string) => void;
  items: QuickbarItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * `/`-keyboard quickbar. Filters the trail by title or query, surfaces
 * the most-recent 8 matches, picks the top result on Enter. Click-outside
 * dismisses; Esc handling lives on the page so it cooperates with other
 * overlays (help, context menu).
 */
export function Quickbar({ query, setQuery, items, onPick, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const lower = query.trim().toLowerCase();
  const matches = items
    .filter(
      (p): p is QuickbarItem & { nodeId: string } =>
        !!p.nodeId &&
        (lower
          ? p.title.toLowerCase().includes(lower) || p.query.toLowerCase().includes(lower)
          : true),
    )
    .slice(-8)
    .reverse();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[20vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] p-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) onPick(matches[0].nodeId);
          }}
          placeholder="Jump to page…"
          className="w-full rounded-md border border-[var(--color-edge)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-ink)]"
        />
        <ul className="mt-2 max-h-72 overflow-auto text-sm">
          {matches.length === 0 && <li className="px-2 py-3 opacity-60">No matches yet.</li>}
          {matches.map((m) => (
            <li key={m.nodeId}>
              <button
                type="button"
                className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-ink)]/10"
                onClick={() => onPick(m.nodeId)}
              >
                <span className="block truncate font-display">{m.title}</span>
                <span className="block truncate text-xs opacity-60">{m.query}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
