"use client";

import type { ScaleKind } from "@openflipbook/config";

/** One bloomed neighbour. `imageDataUrl` is null while its page is still
 *  generating (the slot shows a shimmer); `nodeId` is null until persisted. */
export interface NeighbourItem {
  key: string;
  subject: string;
  scale: ScaleKind;
  imageDataUrl: string | null;
  nodeId: string | null;
}

interface Props {
  items: NeighbourItem[];
  /** How many neighbours the bloom proposed — drives the "N of M" read and
   *  the trailing pending slots before their pages arrive. */
  total: number;
  /** True once the `expand_done` event lands. */
  done: boolean;
  onPick: (item: NeighbourItem) => void;
  onClose: () => void;
}

// Scale → visual encoding. Card width + chip colour make the scale legible at
// a glance: a "container" reads bigger + warmer than a "component".
const SCALE_META: Record<ScaleKind, { label: string; chip: string; width: string }> = {
  component: { label: "part", chip: "bg-sky-500", width: "w-20" },
  peer: { label: "beside", chip: "bg-slate-500", width: "w-24" },
  container: { label: "around", chip: "bg-amber-500", width: "w-28" },
};

export default function NeighbourTray({ items, total, done, onPick, onClose }: Props) {
  const ready = items.filter((i) => i.imageDataUrl).length;
  const pendingCount = Math.max(0, total - items.length);
  // The bloom finished but proposed nothing usable (e.g. a weak VLM whose
  // neighbours got dropped). Show a brief message instead of a blank bar — the
  // page auto-closes it shortly after.
  const empty = done && items.length === 0;
  // Bloom started but no neighbours known yet (the VLM is still surveying):
  // show activity rather than nothing while it thinks.
  const proposing = !done && total === 0 && items.length === 0;
  const status = empty
    ? "No neighbours found nearby"
    : done
      ? `Around this page · ${ready} neighbour${ready === 1 ? "" : "s"} — tap one`
      : proposing
        ? "Looking around…"
        : `Looking around · ${ready} of ${total}`;

  return (
    <div
      role="region"
      aria-label="Neighbours around this page"
      className="pointer-events-auto fixed bottom-3 left-1/2 z-30 max-w-[min(960px,92vw)] -translate-x-1/2 rounded-2xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)]/95 p-2 shadow-xl backdrop-blur"
    >
      <div className="flex items-center justify-between px-2 pb-1.5 text-[11px] opacity-70">
        <span className="flex items-center gap-1.5">
          {!done && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-teal-500" />
          )}
          {status}
        </span>
        <button
          type="button"
          aria-label="Close neighbours"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-ink)]/10"
        >
          E · close
        </button>
      </div>
      <div className="flex max-w-full items-end gap-1.5 overflow-x-auto pb-1">
        {items.map((it) => {
          const meta = SCALE_META[it.scale];
          const loading = !it.imageDataUrl;
          // Clickable only once persisted — onPick navigates to the node's
          // permalink, so a not-yet-saved card would be a dead click.
          return (
            <button
              key={it.key}
              type="button"
              disabled={loading || !it.nodeId}
              aria-label={`Explore ${it.subject}`}
              title={`${it.subject} · ${it.scale}`}
              onClick={() => onPick(it)}
              className={
                "relative h-16 shrink-0 overflow-hidden rounded-lg border transition disabled:cursor-default " +
                meta.width +
                " border-[var(--color-ink)]/20 enabled:hover:border-teal-500/70 enabled:hover:ring-2 enabled:hover:ring-teal-300/60"
              }
            >
              {it.imageDataUrl ? (
                <img
                  src={it.imageDataUrl}
                  alt=""
                  className="block h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="flex h-full w-full animate-pulse items-center justify-center bg-[var(--color-ink)]/10 text-[11px] opacity-50">
                  …
                </span>
              )}
              <span
                className={
                  "absolute left-1 top-1 rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wide text-white " +
                  meta.chip
                }
              >
                {meta.label}
              </span>
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[9px] text-white">
                {it.subject}
              </span>
            </button>
          );
        })}
        {/* Trailing "still proposing" slots — hidden once done, so a bloom
            with a failed neighbour doesn't leave a slot shimmering forever. */}
        {!done &&
          Array.from({ length: pendingCount }).map((_, i) => (
            <span
              key={`pending-${i}`}
              aria-hidden
              className="h-16 w-24 shrink-0 animate-pulse rounded-lg border border-[var(--color-ink)]/15 bg-[var(--color-ink)]/10"
            />
          ))}
        {/* No total yet (still proposing) — a few placeholders so the survey
            phase reads as "working", not a blank bar. */}
        {proposing &&
          Array.from({ length: 3 }).map((_, i) => (
            <span
              key={`proposing-${i}`}
              aria-hidden
              className="h-16 w-24 shrink-0 animate-pulse rounded-lg border border-[var(--color-ink)]/15 bg-[var(--color-ink)]/10"
            />
          ))}
      </div>
    </div>
  );
}
