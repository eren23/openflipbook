import { describe, expect, it } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";

import { __test } from "./world-map";

const { applyGeoUpsert, recomputeBounds } = __test;

function geo(
  id: string,
  source: WorldEntityGeo["source"],
  x = 0,
  y = 0,
): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label: id,
    pos: { x, y },
    height: 4,
    footprint: { w: 6, d: 6 },
    visual: "",
    state: {},
    confidence: 0.5,
    source,
    updated_at: "t0",
  };
}

describe("world-map merge core", () => {
  it("applyGeoUpsert is truly idempotent (no-op re-apply keeps updated_at)", () => {
    const a = applyGeoUpsert([], [geo("a", "derived")], "t1");
    const b = applyGeoUpsert(a, [geo("a", "derived")], "t2");
    expect(b).toHaveLength(1);
    expect(b[0]!.pos).toEqual({ x: 0, y: 0 });
    expect(b[0]!.updated_at).toBe("t1"); // unchanged data → no dirty write
  });

  it("equal-rank re-apply with CHANGED data does write (+ new updated_at)", () => {
    const a = applyGeoUpsert([], [geo("a", "derived", 0, 0)], "t1");
    const b = applyGeoUpsert(a, [geo("a", "derived", 5, 5)], "t2");
    expect(b[0]!.pos).toEqual({ x: 5, y: 5 });
    expect(b[0]!.updated_at).toBe("t2");
  });

  it("source authority: derived never clobbers user; user clobbers derived", () => {
    const keepUser = applyGeoUpsert(
      [geo("a", "user", 10, 10)],
      [geo("a", "derived", 99, 99)],
      "t",
    );
    expect(keepUser[0]!.pos).toEqual({ x: 10, y: 10 }); // derived rejected
    const userWins = applyGeoUpsert(
      [geo("a", "derived", 5, 5)],
      [geo("a", "user", 20, 20)],
      "t",
    );
    expect(userWins[0]!.pos).toEqual({ x: 20, y: 20 });
  });

  it("extracted overwrites derived but not user", () => {
    expect(
      applyGeoUpsert([geo("a", "derived", 1, 1)], [geo("a", "extracted", 2, 2)], "t")[0]!.pos,
    ).toEqual({ x: 2, y: 2 });
    expect(
      applyGeoUpsert([geo("a", "user", 1, 1)], [geo("a", "extracted", 2, 2)], "t")[0]!.pos,
    ).toEqual({ x: 1, y: 1 });
  });

  it("equal rank → the newer write wins", () => {
    expect(
      applyGeoUpsert([geo("a", "derived", 1, 1)], [geo("a", "derived", 9, 9)], "t")[0]!.pos,
    ).toEqual({ x: 9, y: 9 });
  });

  it("recomputeBounds covers every footprint", () => {
    // two 6×6 footprints (half-extent 3) at (0,0) and (10,4).
    const b = recomputeBounds([geo("a", "user", 0, 0), geo("b", "user", 10, 4)]);
    expect(b.x).toBeCloseTo(-3);
    expect(b.y).toBeCloseTo(-3);
    expect(b.w).toBeCloseTo(16); // -3 → 13
    expect(b.h).toBeCloseTo(10); // -3 → 7
  });

  it("empty map → zero bounds", () =>
    expect(recomputeBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 }));
});
