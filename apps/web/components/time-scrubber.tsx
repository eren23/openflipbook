"use client";

import { useEffect, useRef, useState } from "react";

export interface ScrubberFrame {
  nodeId: string;
  imageDataUrl: string | null;
  title: string;
}

interface Props {
  frames: ScrubberFrame[];
  currentIdx: number;
  onJump: (idx: number) => void;
  onClose: () => void;
}

export default function TimeScrubber({
  frames,
  currentIdx,
  onJump,
  onClose,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Keep the active thumb in view when the user navigates outside the
  // scrubber (back/forward keys, atlas click, etc).
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const child = track.children[currentIdx] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentIdx]);

  const idxFromClientX = (clientX: number): number | null => {
    const track = trackRef.current;
    if (!track || frames.length === 0) return null;
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left + track.scrollLeft;
    const cellWidth = rect.width / Math.max(1, frames.length);
    // Use child elements when available — accounts for any wrapping/spacing.
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < track.children.length; i++) {
      const c = track.children[i] as HTMLElement;
      const center = c.offsetLeft + c.offsetWidth / 2;
      const delta = Math.abs(center - x);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    return Number.isFinite(bestDelta) ? best : Math.min(frames.length - 1, Math.max(0, Math.floor(x / cellWidth)));
  };

  if (frames.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Session time-scrubber"
      className="pointer-events-auto fixed bottom-3 left-1/2 z-30 max-w-[min(960px,92vw)] -translate-x-1/2 rounded-2xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)]/95 p-2 shadow-xl backdrop-blur"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div className="flex items-center justify-between px-2 pb-1.5 text-[11px] opacity-70">
        <span>
          Step {currentIdx + 1} of {frames.length}
          {hoverIdx !== null && hoverIdx !== currentIdx ? (
            <> · jump to {hoverIdx + 1}</>
          ) : null}
        </span>
        <button
          type="button"
          aria-label="Close time-scrubber"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-ink)]/10"
        >
          T · close
        </button>
      </div>
      <div
        ref={trackRef}
        className="flex max-w-full items-stretch gap-1.5 overflow-x-auto pb-1"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
          const idx = idxFromClientX(e.clientX);
          if (idx !== null && idx !== currentIdx) onJump(idx);
        }}
        onPointerMove={(e) => {
          const idx = idxFromClientX(e.clientX);
          setHoverIdx(idx);
          if (!dragging) return;
          if (idx !== null && idx !== currentIdx) onJump(idx);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => setHoverIdx(null)}
        onPointerCancel={() => setDragging(false)}
      >
        {frames.map((f, i) => {
          const active = i === currentIdx;
          return (
            <button
              key={`${f.nodeId}-${i}`}
              type="button"
              aria-label={`Jump to ${f.title}`}
              title={f.title}
              onClick={(e) => {
                e.stopPropagation();
                onJump(i);
              }}
              className={
                "relative h-12 w-20 shrink-0 overflow-hidden rounded-md border transition " +
                (active
                  ? "border-amber-400 ring-2 ring-amber-300"
                  : "border-[var(--color-ink)]/20 hover:border-[var(--color-ink)]/50")
              }
            >
              {f.imageDataUrl ? (
                <img
                  src={f.imageDataUrl}
                  alt=""
                  className="block h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[9px] opacity-40">
                  {i + 1}
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[9px] text-white">
                {f.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
