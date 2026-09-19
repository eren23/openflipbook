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
const PASSES = 24;

/** The share of its current size each of a pair keeps, to clear on one axis.
 *  Shrinking is shared in proportion, so a large neighbour does not flatten a
 *  small one -- but when one of them is already at the floor it cannot give
 *  way, and the other takes the whole of what is left. Solving the pair in one
 *  step is what makes the result settle: a symmetric step that ignores the
 *  floor only ever approaches the answer, and stops wherever the passes run
 *  out. Returns null when the two cannot clear on this axis at all. */
function share(a: number, b: number, room: number, floorA: number, floorB: number): [number, number] | null {
  if (!(room > 0) || !Number.isFinite(room)) return null;
  if (a + b <= room) return [1, 1];
  if (floorA * a + floorB * b > room) return null; // not even at the floor
  const even = room / (a + b);
  if (even >= floorA && even >= floorB) return [even, even];
  // One is pinned at its floor; the other absorbs the rest.
  return even < floorA
    ? [floorA, Math.min(1, (room - floorA * a) / b)]
    : [Math.min(1, (room - floorB * b) / a), floorB];
}

/**
 * The same blocks with narrower footprints. `gap` is the daylight to open
 * between neighbours; everything already clear is returned untouched.
 */
export function carveLanes<T extends Footprinted>(blocks: readonly T[], gap: number = LANE_GAP): T[] {
  const scale = blocks.map(() => 1);
  // A footprint keeps its shape, so one number carries both sides. The floor
  // is on the smaller side, and it is measured against the size the block came
  // in at, which is what lets a carved town be carved again to no effect.
  const floor = blocks.map((b) => {
    const side = Math.min(b.footprint.w, b.footprint.d);
    return side > 0 && Number.isFinite(side) ? Math.min(1, MIN_SIDE / side) : 1;
  });

  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const fa = blocks[i]!.footprint;
        const fb = blocks[j]!.footprint;
        const gapNow = (axis: "x" | "y", ha: number, hb: number) =>
          Math.abs(blocks[i]!.pos[axis] - blocks[j]!.pos[axis]) - gap - (ha * scale[i]! + hb * scale[j]!) / 2;
        if (gapNow("x", fa.w, fb.w) >= -1e-9 || gapNow("y", fa.d, fb.d) >= -1e-9) continue;

        // Take whichever axis asks for the least shrinking; axis-aligned boxes
        // clear each other as soon as one of them separates them.
        let best: [number, number] | null = null;
        for (const [axis, ha, hb] of [["x", fa.w, fb.w], ["y", fa.d, fb.d]] as const) {
          const room = Math.abs(blocks[i]!.pos[axis] - blocks[j]!.pos[axis]) - gap;
          const got = share((ha * scale[i]!) / 2, (hb * scale[j]!) / 2, room, floor[i]! / scale[i]!, floor[j]! / scale[j]!);
          if (got && (!best || got[0] + got[1] > best[0] + best[1])) best = got;
        }
        // Nowhere to go on either axis: give way as far as the floor allows,
        // which is the least overlap this pair can leave.
        const keep = best ?? [floor[i]! / scale[i]!, floor[j]! / scale[j]!];
        const next = [Math.max(floor[i]!, scale[i]! * keep[0]!), Math.max(floor[j]!, scale[j]! * keep[1]!)];
        if (next[0]! < scale[i]! - 1e-12 || next[1]! < scale[j]! - 1e-12) moved = true;
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
