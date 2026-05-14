"use client";

import { STYLE_PRESETS } from "@/lib/styles";

interface Props {
  onPick: (presetId: string) => void;
  onSkip: () => void;
}

/**
 * Empty-state style picker on /play. Renders the 8 preset tiles plus a
 * skip link that drops to a bare query box. No internal state — the
 * orchestrator handles what to do on pick/skip.
 */
export function StyleGallery({ onPick, onSkip }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 py-10">
      <div className="text-center">
        <h2 className="text-xl font-medium tracking-tight">
          Pick a style — or skip and let the planner choose.
        </h2>
        <p className="mt-1 text-sm opacity-60">
          Whatever you pick locks the look for every page in this session.
          You can still re-pin a page later.
        </p>
      </div>

      <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
        {STYLE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            aria-label={p.name}
            className="ec-style-tile group relative aspect-[4/3] overflow-hidden rounded-md text-left shadow-sm transition-transform hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink)]"
            style={{
              background: `linear-gradient(135deg, ${p.gradient[0]}, ${p.gradient[1]})`,
              color: p.textColor,
            }}
          >
            <span
              aria-hidden
              className="absolute inset-0 bg-gradient-to-b from-transparent to-black/55"
            />
            <span className="absolute bottom-2 left-3 z-10 text-xs font-semibold uppercase tracking-wider drop-shadow-sm">
              {p.name}
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="text-sm opacity-60 underline-offset-4 transition hover:opacity-100 hover:underline"
      >
        Skip — just give me a query box
      </button>
    </div>
  );
}
