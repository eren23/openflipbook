import type { WorldEntityGeo, WorldVec2 } from "@openflipbook/config";

/** All this needs of a place: where it stands and how much ground it takes.
 *  Declared here rather than imported, so the block renderer can depend on
 *  this file without the two depending on each other. */
type Footprinted = Pick<WorldEntityGeo, "pos" | "footprint">;

/**
 * Extracted footprints are too wide, and they overlap. On the live Lantern
 * Quay map the ten places cover 32% of the whole map and eight pairs of
 * buildings intersect each other -- Bellfounder Hall runs 5.1 units into
 * Lantern Watch. A town packed like that has no street: every point inside it
 * is inside a building, so a camera can only stand against a wall.
 *
 * This narrows footprints about their own centres until neighbours clear each
 * other. Centres never move, so a place stays where the map says it is, and
 * heights are untouched: only the width and depth give way.
 */

/** World units of daylight two buildings must leave between them. */
export const LANE_GAP = 2.5;
/** No footprint is narrowed below this, in world units. The floor is a size
 *  rather than a share, so carving an already-carved town changes nothing:
 *  a pair the floor stops from clearing stays exactly where it stopped. */
const MIN_SIDE = 3;
const PASSES = 6;

function needed(a: Footprinted, b: Footprinted, gap: number): number {
  // Axis-aligned boxes clear each other as soon as ONE axis separates them,
  // so take the axis that asks for the least shrinking.
  const dx = Math.abs(a.pos.x - b.pos.x);
  const dy = Math.abs(a.pos.y - b.pos.y);
  const spanX = (a.footprint.w + b.footprint.w) / 2;
  const spanY = (a.footprint.d + b.footprint.d) / 2;
  const byX = spanX > 0 ? (dx - gap) / spanX : Infinity;
  const byY = spanY > 0 ? (dy - gap) / spanY : Infinity;
  return Math.max(byX, byY);
}

/**
 * The same blocks with narrower footprints. `gap` is the daylight to open
 * between neighbours; everything already clear is returned untouched.
 */
export function carveLanes<T extends Footprinted>(blocks: readonly T[], gap: number = LANE_GAP): T[] {
  const scale = blocks.map(() => 1);
  const size = (i: number) => ({
    ...blocks[i]!,
    footprint: { w: blocks[i]!.footprint.w * scale[i]!, d: blocks[i]!.footprint.d * scale[i]! },
  });

  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = size(i);
        const b = size(j);
        const room = needed(a, b, gap);
        if (room >= 1 || !Number.isFinite(room)) continue;
        // Both give way in proportion, so one large neighbour does not
        // flatten a small one, and neither goes under the floor.
        const step = Math.max(0, room);
        const limit = (k: number) => {
          const f = blocks[k]!.footprint;
          const side = Math.min(f.w, f.d);
          return side > 0 ? Math.min(1, MIN_SIDE / side) : 1;
        };
        const next = [
          Math.max(limit(i), scale[i]! * step),
          Math.max(limit(j), scale[j]! * step),
        ];
        if (next[0]! < scale[i]! - 1e-9 || next[1]! < scale[j]! - 1e-9) moved = true;
        scale[i] = Math.min(scale[i]!, next[0]!);
        scale[j] = Math.min(scale[j]!, next[1]!);
      }
    }
    if (!moved) break;
  }

  return blocks.map((b, i) =>
    scale[i]! >= 1
      ? b
      : ({ ...b, footprint: { w: b.footprint.w * scale[i]!, d: b.footprint.d * scale[i]! } } as T),
  );
}

/** How much daylight the tightest pair has: negative means they intersect. */
export function tightestGap(blocks: readonly Footprinted[]): number {
  let worst = Infinity;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      worst = Math.min(worst, Math.max(
        Math.abs(a.pos.x - b.pos.x) - (a.footprint.w + b.footprint.w) / 2,
        Math.abs(a.pos.y - b.pos.y) - (a.footprint.d + b.footprint.d) / 2,
      ));
    }
  }
  return worst;
}

/** Whether a point stands in the open once the lanes are carved. */
export function standable(blocks: readonly Footprinted[], p: WorldVec2, margin = 0): boolean {
  return !blocks.some((b) =>
    Math.abs(p.x - b.pos.x) <= b.footprint.w / 2 + margin && Math.abs(p.y - b.pos.y) <= b.footprint.d / 2 + margin);
}
