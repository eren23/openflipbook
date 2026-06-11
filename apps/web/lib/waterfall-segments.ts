// Pure segment math for the generation-waterfall HUD. Extracted (and fixed)
// because the inline version mislabeled the tail of every run: decode/morph
// events report stage ENDS, but the painter treated every mark as a START —
// so labels shifted one segment left, and a browser-deferred image decode
// (backgrounded tab) painted as a 100s+ "decode" bar (the 184813ms incident).
// Marks may now carry an explicit `end`; gaps before an explicitly-timed mark
// surface honestly as `idle` instead of inflating their neighbour.

export type WaterfallStage =
  | "request"
  | "click_resolving"
  | "click_resolved"
  | "planning"
  | "generating_image"
  | "draft"
  | "verifying"
  | "final"
  | "decode"
  | "idle"
  | "morph";

export interface WaterfallMark {
  stage: WaterfallStage;
  /** Stage start, on the shared trace clock. */
  t: number;
  /** Explicit stage end for self-terminating stages (decode/morph/idle).
   * Absent -> the stage runs until the next mark (or `now` while active). */
  end?: number;
  hint?: string;
}

export interface WaterfallSegment {
  stage: WaterfallStage;
  start: number;
  end: number;
}

/** A gap longer than this before an explicitly-timed mark is rendered as its
 * own `idle` segment (tab hidden, deferred decode) instead of stretching the
 * previous stage's bar. */
export const IDLE_GAP_MS = 250;

export function buildSegments(
  marks: readonly WaterfallMark[],
  startedAt: number,
  activeStage: WaterfallStage | null,
  now: number,
): WaterfallSegment[] {
  const segments: WaterfallSegment[] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const next = marks[i + 1];
    const start = m.t - startedAt;
    const end =
      m.end != null
        ? m.end - startedAt
        : next != null
          ? next.t - startedAt
          : activeStage != null && activeStage === m.stage
            ? Math.max(start + 1, now - startedAt)
            : start + 1;
    segments.push({ stage: m.stage, start, end: Math.max(end, start) });
    // An explicitly-ended stage followed by a much-later mark: the in-between
    // is dead time, not part of either stage.
    if (m.end != null && next != null && next.t - m.end > IDLE_GAP_MS) {
      segments.push({
        stage: "idle",
        start: m.end - startedAt,
        end: next.t - startedAt,
      });
    }
  }
  return segments;
}

/** Insert-point helper for end-reported events (decode): the event arrives at
 * its END carrying a measured duration; reconstruct the start, and surface a
 * leading idle gap when the stage began long after the previous mark ended. */
export function marksForEndReportedStage(
  prev: readonly WaterfallMark[],
  stage: WaterfallStage,
  startT: number,
  durationMs: number,
): WaterfallMark[] {
  const last = prev[prev.length - 1];
  const lastEnd = last == null ? startT : (last.end ?? last.t);
  const out = [...prev];
  if (startT - lastEnd > IDLE_GAP_MS) {
    out.push({ stage: "idle", t: lastEnd, end: startT });
  }
  out.push({ stage, t: startT, end: startT + Math.max(0, durationMs) });
  return out;
}
