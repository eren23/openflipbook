// The cost projection behind the speed preset's chip — the number you see
// BEFORE you spend it. Price constants are mirrored from docs/COSTS.md
// (June 2026, fal model pages + OpenRouter); the vitest next door pins the
// projections to that doc's headline per-operation numbers so the two can't
// silently drift apart. Honest ranges, not false precision: `low` is the
// accept-at-one outcome, `high` is every retry spent.

import type { ImageTier } from "@openflipbook/config";

export type CostAction = "tap" | "edit" | "query";

export interface CostBundle {
  tier: ImageTier;
  /** Judged-loop attempts, clamped server-side to [1, 4]. */
  maxAttempts: number;
  /** false -> the judged loops are skipped (one un-judged shot). */
  verify: boolean;
}

export interface CostRange {
  low: number;
  high: number;
}

// fal — the dollar driver (docs/COSTS.md "The models we call").
const IMAGE_PRICE: Record<ImageTier, number> = {
  fast: 0.039, // nano-banana
  balanced: 0.15, // nano-banana-pro
  pro: 0.24, // riverflow-v2.5-pro
};
// flux-pro/v1/fill $0.05/MP ≈ $0.10 per mask edit at 16:9.
const INPAINT_PRICE = 0.1;
// One Gemini Flash round-trip (judge / VLM / planner) — pennies that stack
// up in COUNT, not dollars.
const VLM_CALL = 0.0015;

// Per-operation call counts (docs/COSTS.md "What each operation costs").
const TAP_VLM_FIRST = 9; // click + plan + 4 judges + 3 extraction
const TAP_VLM_RETRY = 4; // 4 more judges per extra attempt
const TAP_VLM_UNJUDGED = 5; // click + plan + 3 extraction, no judges
const EDIT_VLM_FIRST = 5; // polish + 2 judges + 2 extraction
const EDIT_VLM_RETRY = 2; // 2 more judges per extra attempt
const EDIT_VLM_UNJUDGED = 3; // polish + 2 extraction
const QUERY_VLM = 4; // plan + extract + detect + view

/** Projected dollar range for one action under the bundle. The fresh `query`
 * path is never looped, so its range collapses to a point. */
export function projectCost(bundle: CostBundle, action: CostAction): CostRange {
  const attempts = bundle.verify
    ? Math.max(1, Math.min(4, Math.round(bundle.maxAttempts)))
    : 1;
  const image = IMAGE_PRICE[bundle.tier];
  switch (action) {
    case "query":
      return point(image + QUERY_VLM * VLM_CALL);
    case "tap": {
      if (!bundle.verify) return point(image + TAP_VLM_UNJUDGED * VLM_CALL);
      const low = image + TAP_VLM_FIRST * VLM_CALL;
      const high =
        attempts * image +
        (TAP_VLM_FIRST + (attempts - 1) * TAP_VLM_RETRY) * VLM_CALL;
      return { low, high };
    }
    case "edit": {
      if (!bundle.verify)
        return point(INPAINT_PRICE + EDIT_VLM_UNJUDGED * VLM_CALL);
      const low = INPAINT_PRICE + EDIT_VLM_FIRST * VLM_CALL;
      const high =
        attempts * INPAINT_PRICE +
        (EDIT_VLM_FIRST + (attempts - 1) * EDIT_VLM_RETRY) * VLM_CALL;
      return { low, high };
    }
  }
}

/** "$0.16–0.32", or "$0.05" when the range collapses. Two decimals — the
 * projection is honest to about a cent, no further. */
export function formatCostRange(range: CostRange): string {
  const lo = dollars(range.low);
  const hi = dollars(range.high);
  return lo === hi ? `$${lo}` : `$${lo}–${hi}`;
}

function point(value: number): CostRange {
  return { low: value, high: value };
}

function dollars(value: number): string {
  return value.toFixed(2);
}
