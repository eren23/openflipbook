"use client";

import { useEffect, useRef, useState } from "react";
import type { Citation } from "@openflipbook/config";

interface CitationsChipProps {
  sources: Citation[];
}

export default function CitationsChip({ sources }: CitationsChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!sources || sources.length === 0) return null;

  return (
    <div
      ref={ref}
      className="pointer-events-auto absolute bottom-3 end-3 z-10 select-none"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={`${sources.length} source${sources.length === 1 ? "" : "s"}`}
        title={`${sources.length} source${sources.length === 1 ? "" : "s"}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 rounded-full border border-[var(--color-ink)]/30 bg-[var(--color-paper)]/80 px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] backdrop-blur transition hover:bg-[var(--color-paper)]"
      >
        <span aria-hidden>📎</span>
        <span>{sources.length}</span>
      </button>
      {open && (
        <div className="absolute end-0 bottom-[calc(100%+0.5rem)] w-72 max-w-[80vw] rounded-xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)] p-2 text-xs shadow-lg">
          <p className="px-1 pb-1 opacity-60">Sources the planner used</p>
          <ul className="flex flex-col gap-1">
            {sources.map((s, i) => {
              const host = safeHost(s.url);
              return (
                <li key={`${s.url}-${i}`}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md px-2 py-1.5 hover:bg-[var(--color-ink)]/5"
                  >
                    <div className="line-clamp-2 font-medium">
                      {s.title || host || s.url}
                    </div>
                    {host && (
                      <div className="mt-0.5 truncate opacity-60">{host}</div>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
