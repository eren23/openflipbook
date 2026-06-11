"use client";

import { useEffect, useState } from "react";
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
  /** Running backend spend estimate for this session ($); null/absent until
   * the first final frame lands. */
  sessionSpend?: number | null | undefined;
  /** Dev-only explicit model override (NEXT_PUBLIC_DEV_PROVIDERS=1): rides
   * the wire's image_model field per request. null = the tier decides. */
  devModel?: string | null | undefined;
  setDevModel?: ((m: string | null) => void) | undefined;
}

const DEV_PROVIDERS = process.env.NEXT_PUBLIC_DEV_PROVIDERS === "1";

interface RegistryModel {
  slug: string;
  label: string;
  est_cost: number;
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
  sessionSpend,
  devModel,
  setDevModel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<RegistryModel[] | null>(null);
  useEffect(() => {
    if (!open || !DEV_PROVIDERS || models !== null) return;
    let cancelled = false;
    void fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { models?: RegistryModel[] } | null) => {
        if (!cancelled) setModels(j?.models ?? []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, models]);
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
        title={`Projected spend per action — tap ${tap} · edit ${edit} · new page ${fresh}. Ranges span retries; see docs/COSTS.md.${
          typeof sessionSpend === "number"
            ? ` Session so far ≈ $${sessionSpend.toFixed(2)} (backend estimate).`
            : ""
        }`}
      >
        ≈ {tap}/tap
        {typeof sessionSpend === "number" && (
          <span data-testid="session-spend">
            {" "}
            · session ≈ ${sessionSpend.toFixed(2)}
          </span>
        )}
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
          {DEV_PROVIDERS && setDevModel && (
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="opacity-60">model</span>
              <select
                aria-label="Dev image model override"
                value={devModel ?? ""}
                disabled={busy}
                onChange={(e) => setDevModel(e.target.value || null)}
                className="max-w-[9.5rem] rounded-full border border-[var(--color-edge)] bg-transparent px-2 py-1 text-xs disabled:opacity-40"
              >
                <option value="">tier decides</option>
                {(models ?? []).map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.label} (${m.est_cost.toFixed(2)})
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="mt-2 border-t border-[var(--color-edge)] pt-2 opacity-60">
            tap {tap} · edit {edit} · new page {fresh}
          </p>
        </div>
      )}
    </div>
  );
}
