import { describe, expect, it } from "vitest";

import type { EntityGeoEdit, WorldEntityGeo } from "@openflipbook/config";

import { __test } from "./world-map";

const { applyGeoUpsert, recomputeBounds, applyEntityEdit, blastRadius } = __test;

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

describe("applyEntityEdit (P5 structured geo edits)", () => {
  const base = () => [geo("geo_a", "derived", 10, 10)];

  it("move shifts pos by (dx,dy), stamps updated_at, claims user authority", () => {
    const edit: EntityGeoEdit = { op: "move", target: "geo_a", dx: 5, dy: -3 };
    const out = applyEntityEdit(base(), edit, "t9");
    expect(out[0]!.pos).toEqual({ x: 15, y: 7 });
    expect(out[0]!.updated_at).toBe("t9");
    expect(out[0]!.source).toBe("user"); // a deliberate edit outranks re-seeds
  });

  it("set_height and set_appearance change only their field", () => {
    expect(applyEntityEdit(base(), { op: "set_height", target: "geo_a", height: 30 }, "t")[0]!.height).toBe(30);
    expect(
      applyEntityEdit(base(), { op: "set_appearance", target: "geo_a", visual: "red brick" }, "t")[0]!.visual,
    ).toBe("red brick");
  });

  it("remove drops the target", () => {
    expect(applyEntityEdit(base(), { op: "remove", target: "geo_a" }, "t")).toEqual([]);
  });

  it("add appends a user entity with defaults + deterministic id", () => {
    const out = applyEntityEdit(base(), { op: "add", label: "Well", pos: { x: 2, y: 4 } }, "t");
    expect(out).toHaveLength(2);
    const added = out.find((e) => e.label === "Well")!;
    expect(added.id).toBe("geo_user_well");
    expect(added.pos).toEqual({ x: 2, y: 4 });
    expect(added.source).toBe("user");
    expect(added.entity_id).toBeNull();
    expect(added.height).toBeGreaterThan(0);
  });

  it("an edit targeting an unknown id is a no-op (never throws)", () => {
    const before = base();
    expect(applyEntityEdit(before, { op: "move", target: "nope", dx: 1, dy: 1 }, "t")).toEqual(before);
  });
});

describe("blastRadius (which saved scenes go stale)", () => {
  it("unions + sorts + dedupes node refs across edited targets", () => {
    const refs = { geo_a: ["n3", "n1"], geo_b: ["n1", "n2"] };
    const edits: EntityGeoEdit[] = [
      { op: "move", target: "geo_a", dx: 1, dy: 0 },
      { op: "set_height", target: "geo_b", height: 5 },
    ];
    expect(blastRadius(edits, refs)).toEqual(["n1", "n2", "n3"]);
  });

  it("add (no target) contributes nothing; unknown target → empty", () => {
    expect(blastRadius([{ op: "add", label: "x", pos: { x: 0, y: 0 } }], {})).toEqual([]);
    expect(blastRadius([{ op: "remove", target: "ghost" }], { geo_a: ["n1"] })).toEqual([]);
  });
});
