import { describe, expect, it } from "vitest";

import type { EntityGeoEdit, WorldEntityGeo } from "@openflipbook/config";

import { __test, ladderDisagreement, registerPlanToImage } from "./world-map";

const { applyGeoUpsert, recomputeBounds, applyEntityEdit, blastRadius, buildGeoReferences } =
  __test;

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

  it("a scaled child resolves INSIDE its parent footprint (not flung flat)", () => {
    // Unseen University at (30,18), footprint 10×10, interior scale 0.1. A child
    // at LOCAL (50,50) resolves to absolute (35,23) — inside UU's box — NOT the
    // (80,68) a scaleless translation would give. So world bounds stay tight.
    const uu: WorldEntityGeo = {
      ...geo("geo_uu", "derived", 30, 18),
      footprint: { w: 10, d: 10 },
      scale: 0.1,
    };
    const child: WorldEntityGeo = {
      ...geo("geo_tower", "derived", 50, 50),
      parent_id: "geo_uu",
      footprint: { w: 2, d: 2 },
    };
    const b = recomputeBounds([uu, child]);
    // child reached (36,24) at most — far from a scaleless (81,69).
    expect(b.x + b.w).toBeLessThanOrEqual(37);
    expect(b.y + b.h).toBeLessThanOrEqual(25);
  });

  it("post-ascend re-expressed roots keep the bounds sane (the 8000×6828 blowup)", () => {
    // The OUTWARD reparent shape: P at frame centre with scale=pScale; the old
    // root re-expressed to parent-local pos AND footprint (÷0.005 = ×200). The
    // resolved footprint (×unit) recovers the absolute 40×34 — bounds must be
    // frame-sized, not 8000 wide (the raw-footprint bug the minimap exposed).
    const p: WorldEntityGeo = {
      ...geo("geo_p", "user", 50, 30),
      footprint: { w: 100, d: 60 },
      scale: 0.005,
    };
    const oldRoot: WorldEntityGeo = {
      ...geo("geo_city", "user", -2000, 1000), // resolves to (40, 35)
      parent_id: "geo_p",
      footprint: { w: 8000, d: 6828 }, // 40×34.14 ÷ 0.005
    };
    const b = recomputeBounds([p, oldRoot]);
    expect(b.w).toBeLessThanOrEqual(110); // P's own 100-wide footprint dominates
    expect(b.h).toBeLessThanOrEqual(70);
  });
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

  it("remove re-roots orphaned children instead of leaving a dangling parent_id", () => {
    const parent = geo("geo_uu", "derived", 10, 10);
    const child = { ...geo("geo_tower", "derived", 1, 2), parent_id: "geo_uu" };
    const sibling = { ...geo("geo_lib", "derived", 3, 4), parent_id: "geo_uu" };
    const out = applyEntityEdit([parent, child, sibling], { op: "remove", target: "geo_uu" }, "t");
    expect(out.map((e) => e.id).sort()).toEqual(["geo_lib", "geo_tower"]);
    // Children must NOT keep pointing at the removed parent — else
    // resolveAbsolutePos mis-places them as roots in their own local frame.
    expect(out.every((e) => (e.parent_id ?? null) === null)).toBe(true);
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

  it("add gives a unique id on slug collision so no user entity is dropped", () => {
    // applyGeoUpsert / getWorldMap key entities by id (Map), so two adds that
    // slug to the same base id used to collapse to one — silently dropping a
    // source:"user" placement. Each add must now get a distinct id.
    const a = applyEntityEdit([], { op: "add", label: "North Gate", pos: { x: 0, y: 0 } }, "t");
    const b = applyEntityEdit(a, { op: "add", label: "north-gate", pos: { x: 9, y: 9 } }, "t");
    const ids = b.map((e) => e.id);
    expect(ids).toEqual(["geo_user_north_gate", "geo_user_north_gate_2"]);
    expect(new Set(ids).size).toBe(2);
    // Both survive the Map-by-id merge that used to drop one.
    expect(applyGeoUpsert([], b, "t2")).toHaveLength(2);
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

  it("P7d — with geos, an edit ripples to the target's frame-siblings", () => {
    // Tower + Library + Hall all live inside Unseen University; Palace is city-level.
    const geos = [
      { id: "geo_uu", parent_id: null },
      { id: "geo_tower", parent_id: "geo_uu" },
      { id: "geo_lib", parent_id: "geo_uu" },
      { id: "geo_palace", parent_id: null },
    ];
    const refs = {
      geo_tower: ["n_tower"],
      geo_lib: ["n_lib"],
      geo_palace: ["n_palace"],
    };
    const edits: EntityGeoEdit[] = [{ op: "move", target: "geo_tower", dx: 1, dy: 0 }];
    // Without geos: only the tower's own scenes.
    expect(blastRadius(edits, refs)).toEqual(["n_tower"]);
    // With geos: the Library (its University frame-mate) is stale too — but the
    // unrelated Palace stays untouched.
    expect(blastRadius(edits, refs, geos)).toEqual(["n_lib", "n_tower"]);
  });
});

describe("buildGeoReferences (geo id → node refs)", () => {
  it("maps geo entities to their codex appears_on_node_ids", () => {
    const geos = [
      { id: "geo_a", entity_id: "e1" },
      { id: "geo_b", entity_id: "e2" }, // linked but no appearances → omitted
      { id: "geo_c", entity_id: null }, // map-only prop → omitted
    ];
    const codex = [
      { id: "e1", appears_on_node_ids: ["n1", "n2"] },
      { id: "e2", appears_on_node_ids: [] },
    ];
    expect(buildGeoReferences(geos, codex)).toEqual({ geo_a: ["n1", "n2"] });
  });
});

describe("ladderDisagreement (INV-4: one ladder)", () => {
  it("flags a DEEPER seed whose learned scale magnifies instead of shrinking", () => {
    // child rung finer than parent (DEEPER) but scale > 1 → the interior is bigger
    // than the parent footprint, contradicting the rung.
    expect(ladderDisagreement("city", "district", 3)).toMatch(/DEEPER/);
  });

  it("is silent when the learned scale agrees with the rung step", () => {
    expect(ladderDisagreement("city", "district", 0.2)).toBeNull(); // DEEPER, shrinks ✓
    expect(ladderDisagreement("district", "city", 5)).toBeNull(); // OUTWARD, grows ✓
  });

  it("flags an OUTWARD seed that shrinks instead of growing", () => {
    expect(ladderDisagreement("district", "city", 0.2)).toMatch(/OUTWARD/);
  });

  it("never fires when a rung is unknown (back-compat)", () => {
    expect(ladderDisagreement(null, "city", 99)).toBeNull();
    expect(ladderDisagreement("city", undefined, 99)).toBeNull();
  });
});

describe("registerPlanToImage (plan plane → image register)", () => {
  // Plan geos (solver output): geo_plan_* ids, no codex link. Image seeds:
  // extraction-derived, entity-linked. Labels are the join key.
  const plan = (ref: string, label: string, x: number, y: number): WorldEntityGeo => ({
    ...geo(`geo_plan_${ref}`, "derived", x, y),
    label,
    entity_id: null,
  });
  const img = (id: string, label: string, x: number, y: number): WorldEntityGeo => ({
    ...geo(id, "derived", x, y),
    label,
  });

  it("registers an offset+scaled plan onto its label-matched seeds", () => {
    // True transform: scale 1.5, translate (+10, +10). Two anchors + one
    // unmatched plan entity that must ride along on the fitted transform.
    const geos = [
      plan("tower", "The Tower", 10, 10),
      plan("harbor", "Harbor", 30, 20),
      plan("wood", "Dark Wood", 50, 40),
      img("geo_tower", "the tower", 25, 25),
      img("geo_harbor", "The old Harbor docks", 55, 40), // fuzzy label match
    ];
    const reg = registerPlanToImage(geos, "t9")!;
    expect(reg.fit.scale).toBeCloseTo(1.5);
    expect(reg.fit.tx).toBeCloseTo(10);
    expect(reg.fit.ty).toBeCloseTo(10);
    expect(reg.fit.flipX).toBe(false);
    expect(reg.fit.matched).toBe(2);
    expect(reg.updated).toHaveLength(3); // ALL plans move, matched or not
    const wood = reg.updated.find((g) => g.id === "geo_plan_wood")!;
    expect(wood.pos.x).toBeCloseTo(85); // 1.5·50 + 10
    expect(wood.pos.y).toBeCloseTo(70);
    expect(wood.footprint.w).toBeCloseTo(9); // 6 × 1.5 — sizes scale too
    expect(wood.height).toBeCloseTo(6); // 4 × 1.5
    expect(wood.updated_at).toBe("t9");
  });

  it("null when fewer than 2 label matches (nothing to anchor)", () => {
    expect(
      registerPlanToImage(
        [plan("a", "Tower", 10, 10), plan("b", "Harbor", 30, 20), img("geo_x", "Tower", 40, 40)],
        "t",
      ),
    ).toBeNull();
  });

  it("null when already in register (idempotent write path)", () => {
    expect(
      registerPlanToImage(
        [plan("a", "Tower", 10, 10), plan("b", "Harbor", 30, 20),
         img("geo_a", "Tower", 10, 10), img("geo_b", "Harbor", 30, 20)],
        "t",
      ),
    ).toBeNull();
  });

  it("null without plans, and unlinked map props are not anchors", () => {
    expect(registerPlanToImage([img("geo_a", "Tower", 1, 1)], "t")).toBeNull();
    const prop = { ...img("geo_p", "Tower", 40, 40), entity_id: null };
    expect(
      registerPlanToImage(
        [plan("a", "Tower", 10, 10), plan("b", "Harbor", 30, 20), prop],
        "t",
      ),
    ).toBeNull();
  });
});
