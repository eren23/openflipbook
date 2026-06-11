"use client";

import { useState } from "react";
import type { ImageTier } from "@openflipbook/config";

import { formatCostRange, projectCost } from "@/lib/cost-estimate";
import {
  type LoopKnobs,
  PRESET_BUNDLES,
  presetFor,
  SPEED_PRESETS,
  type SpeedPreset as Preset,
} from "@/hooks/useSpeedPreset";

interface Props {
  busy: boolean;
  imageTier: ImageTier;
  setImageTier: (t: ImageTier) => void;
  knobs: LoopKnobs;
  setKnobs: (k: LoopKnobs) => void;
}

// The 3-stop speed/quality preset + the live cost chip — the projected spend
// shown BEFORE you spend it. A preset is a shortcut that sets the image tier
// (the existing toggle stays in sync — it's the same store) plus the loop
// knobs; the ⚙ popover exposes the knobs directly, and any hand-tuned combo
// reads as "custom". Presentational; the page owns the state.
export function SpeedPreset({
  busy,
  imageTier,
  setImageTier,
  knobs,
  setKnobs,
}: Props) {
  const [open, setOpen] = useState(false);
  const active = presetFor(imageTier, knobs);
  const bundle = { tier: imageTier, ...knobs };
  const tap = formatCostRange(projectCost(bundle, "tap"));
  const edit = formatCostRange(projectCost(bundle, "edit"));
  const fresh = formatCostRange(projectCost(bundle, "query"));

  const applyPreset = (p: Preset) => {
    const b = PRESET_BUNDLES[p];
    setImageTier(b.tier);
    setKnobs({ maxAttempts: b.maxAttempts, verify: b.verify });
  };

  const knobButton = (pressed: boolean, onClick: () => void, label: string) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-pressed={pressed}
      className={
        "rounded-full px-2.5 py-1 transition-colors disabled:opacity-40 " +
        (pressed
          ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
          : "hover:bg-[var(--color-ink)]/5")
      }
    >
      {label}
    </button>
  );

  return (
    <div className="relative flex items-center gap-1.5 text-xs">
      <div
        role="group"
        aria-label="Speed / quality preset"
        className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)]"
        title="Speed/quality preset — fast (one cheap un-judged shot), balanced (default), quality (premium image + deeper judged retries)"
      >
        <span className="px-2 py-1 opacity-60">speed</span>
        {SPEED_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => applyPreset(p)}
            disabled={busy}
            aria-pressed={active === p}
            className={
              "px-2.5 py-1 transition-colors disabled:opacity-40 " +
              (active === p
                ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                : "hover:bg-[var(--color-ink)]/5")
            }
          >
            {p}
          </button>
        ))}
        {active === "custom" && (
          <span className="bg-[var(--color-ink)] px-2.5 py-1 text-[var(--color-canvas)]">
            custom
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label="Advanced loop controls"
          title="Advanced — retry attempts + verification"
          className="px-2 py-1 transition-colors hover:bg-[var(--color-ink)]/5"
        >
          ⚙
        </button>
      </div>
      <span
        data-testid="cost-chip"
        className="whitespace-nowrap opacity-60"
        title={`Projected spend per action — tap ${tap} · edit ${edit} · new page ${fresh}. Ranges span retries; see docs/COSTS.md.`}
      >
        ≈ {tap}/tap
      </span>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 w-60 rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] p-3 shadow-md">
          <div className="mb-2 flex items-center justify-between">
            <span className="opacity-60">attempts</span>
            <div role="group" aria-label="Max judged attempts" className="flex gap-1">
              {([1, 2, 3] as const).map((n) =>
                knobButton(
                  knobs.maxAttempts === n,
                  () => setKnobs({ ...knobs, maxAttempts: n }),
                  String(n),
                ),
              )}
            </div>
          </div>
          <div className="mb-2 flex items-center justify-between">
            <span className="opacity-60">verify</span>
            <div role="group" aria-label="Judged verification" className="flex gap-1">
              {knobButton(knobs.verify, () => setKnobs({ ...knobs, verify: true }), "on")}
              {knobButton(!knobs.verify, () => setKnobs({ ...knobs, verify: false }), "off")}
            </div>
          </div>
          <p className="mt-2 border-t border-[var(--color-edge)] pt-2 opacity-60">
            tap {tap} · edit {edit} · new page {fresh}
          </p>
        </div>
      )}
    </div>
  );
}
