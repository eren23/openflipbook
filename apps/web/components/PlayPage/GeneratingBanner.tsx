"use client";

interface Props {
  /** Per-stage status text from the SSE pipeline; falls back to a generic label. */
  statusMsg: string | null;
}

/**
 * Bottom-of-canvas pill shown while the SSE pipeline is producing a
 * page. Pure visual; the parent decides when to render it.
 */
export function GeneratingBanner({ statusMsg }: Props) {
  return (
    <div
      data-testid="generating-banner"
      className="pointer-events-none absolute inset-0 flex items-end bg-black/35"
    >
      <div className="m-4 flex items-center gap-3 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg">
        <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-white/90" />
        <span>{statusMsg ?? "Generating…"}</span>
      </div>
    </div>
  );
}
