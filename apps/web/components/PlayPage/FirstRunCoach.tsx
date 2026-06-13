"use client";

import { BloomGlyph } from "./BloomGlyph";

export type FirstRunCoachVariant = "pre" | "post";

interface Props {
  onShowHelp: () => void;
  /** World mode is on → also teach the enter affordance (the pulsing rings). */
  worldHint?: boolean;
  /** Pre-first-page hint vs post-first-page tap/around pairing. Default post. */
  variant?: FirstRunCoachVariant;
}

/**
 * Persistent bottom-of-page hint chip. Pre variant nudges a first query; post
 * variant teaches the two generative moves as a *pair* — tap a region to go IN
 * (depth), or bloom the world AROUND the page (breadth, the `E` / Around
 * action). Stays out of the visual centre — the rendered illustration is what
 * matters.
 */
export function FirstRunCoach({
  onShowHelp,
  worldHint = false,
  variant = "post",
}: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-[92vw] flex-wrap items-center justify-center gap-2.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-canvas)]/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
        {variant === "pre" ? (
          <>
            <span className="whitespace-nowrap opacity-80">
              Ask anything above — I&apos;ll draw the first page
            </span>
            <span className="opacity-40">·</span>
            <span className="whitespace-nowrap opacity-80">
              then tap anywhere to go deeper
            </span>
          </>
        ) : (
          <>
            {/* The two moves, side by side, so the in/around duality is obvious. */}
            <span className="whitespace-nowrap opacity-80">Tap to go in</span>
            <span className="opacity-40">·</span>
            {worldHint && (
              <>
                <span className="flex items-center gap-1.5 whitespace-nowrap opacity-80">
                  <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-emerald-600/70" />
                  rings = enterable places
                </span>
                <span className="opacity-40">·</span>
              </>
            )}
            <span className="flex items-center gap-1.5 whitespace-nowrap opacity-80">
              <BloomGlyph className="h-3.5 w-3.5 text-teal-600" />
              around
              <kbd className="rounded border border-[var(--color-edge)] px-1 font-mono text-[10px]">
                E
              </kbd>
            </span>
            <span className="opacity-40">·</span>
            <button
              type="button"
              aria-label="shortcuts"
              onClick={onShowHelp}
              className="rounded-full border border-[var(--color-edge)] px-2 py-0.5 font-mono text-xs hover:bg-[var(--color-ink)]/10"
              title="Show all shortcuts"
            >
              ?
            </button>
            <span className="whitespace-nowrap opacity-80">shortcuts</span>
            <span className="opacity-40">·</span>
            <span className="font-mono text-xs opacity-80">T</span>
            <span className="opacity-80">scrubber</span>
          </>
        )}
      </div>
    </div>
  );
}
