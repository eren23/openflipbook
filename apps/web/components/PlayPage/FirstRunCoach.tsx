"use client";

interface Props {
  onShowHelp: () => void;
}

/**
 * Persistent bottom-of-page hint chip. Surfaces the two shortcut keys most
 * people miss without reading docs (`?` for the full help overlay, `T` for
 * the time-scrubber). Stays out of the visual centre — the rendered
 * illustration is what matters.
 */
export function FirstRunCoach({ onShowHelp }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-[var(--color-edge)] bg-[var(--color-canvas)]/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
        <span className="opacity-80">Tap any region to explore.</span>
        <span className="opacity-40">·</span>
        <button
          type="button"
          onClick={onShowHelp}
          className="rounded-full border border-[var(--color-edge)] px-2 py-0.5 font-mono text-xs hover:bg-[var(--color-ink)]/10"
          title="Show all shortcuts"
        >
          ?
        </button>
        <span className="opacity-80">shortcuts</span>
        <span className="opacity-40">·</span>
        <span className="font-mono text-xs opacity-80">T</span>
        <span className="opacity-80">scrubber</span>
      </div>
    </div>
  );
}
