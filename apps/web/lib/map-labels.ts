import type { WorldVec2 } from "@openflipbook/config";

/**
 * Pure label layout for the DOM-labels overlay (MapLabelOverlay): greedy
 * collision avoidance over normalized (0..1) label boxes. Labels prefer to
 * sit just above their anchor point; an overlapping label nudges DOWN below
 * the colliding one (cartographic convention: never sideways, the anchor
 * line stays readable), then clamps into the frame.
 */

export interface LabelInput {
  id: string;
  name: string;
  // Anchor point in normalized image space (0..1) — the entity's centre.
  xPct: number;
  yPct: number;
}

export interface PlacedLabel extends LabelInput {
  // Top-left of the label box, normalized; the component renders from these.
  leftPct: number;
  topPct: number;
  wPct: number;
  hPct: number;
}

// Box-size estimate in normalized units: ~per-character width and line
// height for the small cartouche font, relative to a typical map render.
const CHAR_W = 0.0075;
const LINE_H = 0.035;
const GAP = 0.006;
const MAX_NAME = 28;

function overlaps(a: PlacedLabel, b: PlacedLabel): boolean {
  return (
    a.leftPct < b.leftPct + b.wPct &&
    b.leftPct < a.leftPct + a.wPct &&
    a.topPct < b.topPct + b.hPct &&
    b.topPct < a.topPct + a.hPct
  );
}

const clamp01 = (v: number, span: number): number =>
  Math.min(Math.max(v, 0), 1 - span);

export function layoutLabels(items: LabelInput[]): PlacedLabel[] {
  // Stable order: top-to-bottom, then left-to-right — northern labels claim
  // their spot first, southern ones nudge around them.
  const sorted = [...items].sort(
    (a, b) => a.yPct - b.yPct || a.xPct - b.xPct || (a.id < b.id ? -1 : 1),
  );
  const placed: PlacedLabel[] = [];
  for (const item of sorted) {
    const name =
      item.name.length > MAX_NAME
        ? `${item.name.slice(0, MAX_NAME - 1)}…`
        : item.name;
    const wPct = Math.min(name.length * CHAR_W, 0.5);
    const box: PlacedLabel = {
      ...item,
      name,
      wPct,
      hPct: LINE_H,
      leftPct: clamp01(item.xPct - wPct / 2, wPct),
      // Prefer sitting just above the anchor.
      topPct: clamp01(item.yPct - LINE_H - GAP, LINE_H),
    };
    // Nudge below each collider in placement order; one pass per existing
    // label is enough for a greedy, non-overlapping result.
    let moved = true;
    let guard = 0;
    while (moved && guard < 20) {
      moved = false;
      guard += 1;
      for (const other of placed) {
        if (overlaps(box, other)) {
          box.topPct = clamp01(other.topPct + other.hPct + GAP, box.hPct);
          moved = true;
        }
      }
    }
    placed.push(box);
  }
  return placed;
}

/** Anchor points from geo entities seeded in `frame` (top-level map). */
export function anchorsFromGeo(
  entities: { id: string; label: string; pos: WorldVec2 }[],
  frame: { x: number; y: number; w: number; h: number },
): LabelInput[] {
  return entities
    .filter((e) => e.label.trim())
    .map((e) => ({
      id: e.id,
      name: e.label.trim(),
      xPct: (e.pos.x - frame.x) / frame.w,
      yPct: (e.pos.y - frame.y) / frame.h,
    }))
    .filter((a) => a.xPct >= 0 && a.xPct <= 1 && a.yPct >= 0 && a.yPct <= 1);
}
