"""Golden tests for the deterministic place-layout solver (B1).

Pure CPU, free, always-runs (no marker). Proves the load-bearing guarantees:
relative ordering from relations, count fan-out, "empty stays empty" at solve,
and the blocking clarifiers (over-pack / unanchored). Same discipline as the
geometry golden — same input, same output.
"""
from __future__ import annotations

import math

from providers.layout_solver import (
    EmptyRegion,
    PlannedEntity,
    PlannedRelation,
    SceneGraph,
    _aabb,
    _intersects,
    solve_layout,
)


def _coffee_shop() -> SceneGraph:
    return SceneGraph(
        place_label="corner coffee shop",
        entities=[
            PlannedEntity("counter", "item", "zinc counter", "a long zinc counter",
                          footprint={"w": 30, "d": 4}),
            PlannedEntity("stool", "item", "stool", "a metal stool", count=4,
                          footprint={"w": 2, "d": 2}),
            PlannedEntity("shelf", "item", "mug shelf", "a shelf of mugs",
                          footprint={"w": 30, "d": 2}),
            PlannedEntity("door", "item", "door", "a glass door",
                          footprint={"w": 4, "d": 1}),
        ],
        relations=[
            PlannedRelation("counter", "on_wall", "back_wall"),
            PlannedRelation("stool", "in_front_of", "counter"),
            PlannedRelation("shelf", "behind", "counter"),
            PlannedRelation("door", "on_wall", "left_wall"),
        ],
        empty_regions=[EmptyRegion("queue", "front-right corner reserved for a queue")],
    )


def _by_label(geos: list[dict], label: str) -> list[dict]:
    return [g for g in geos if g["label"] == label]


def test_coffee_shop_solves_without_blocking() -> None:
    res = solve_layout(_coffee_shop())
    assert res.blocked is False
    # 4 stools fanned out + counter + shelf + door = 7 instances.
    assert len(res.geos) == 7
    assert len(_by_label(res.geos, "stool")) == 4
    for g in res.geos:
        assert g["source"] == "derived"
        assert g["confidence"] == 0.6
        assert g["entity_id"] is None


def test_relations_set_relative_order() -> None:
    res = solve_layout(_coffee_shop())
    counter = _by_label(res.geos, "zinc counter")[0]["pos"]["y"]
    shelf = _by_label(res.geos, "mug shelf")[0]["pos"]["y"]
    stools = [g["pos"]["y"] for g in _by_label(res.geos, "stool")]
    # +y is SOUTH/toward-viewer: a stool is IN FRONT (greater y), the shelf BEHIND (<= y).
    assert min(stools) > counter
    assert shelf <= counter


def test_count_fans_out_without_overlap() -> None:
    res = solve_layout(_coffee_shop())
    stools = _by_label(res.geos, "stool")
    assert len(stools) == 4
    for i in range(len(stools)):
        for j in range(i + 1, len(stools)):
            a = _aabb((stools[i]["pos"]["x"], stools[i]["pos"]["y"]), stools[i]["footprint"])
            b = _aabb((stools[j]["pos"]["x"], stools[j]["pos"]["y"]), stools[j]["footprint"])
            assert not _intersects(a, b), "fanned-out stools must not overlap"


def test_empty_region_stays_empty_at_solve() -> None:
    res = solve_layout(_coffee_shop())
    # the declared-empty front-right corner -> reserved bottom-right quadrant.
    reserved = (50.0, 30.0, 100.0, 60.0)
    for g in res.geos:
        box = _aabb((g["pos"]["x"], g["pos"]["y"]), g["footprint"])
        assert not _intersects(box, reserved), f"{g['label']} landed in the reserved region"


def test_over_pack_blocks_and_asks() -> None:
    # A tiny 10x10 place can't hold five 6x6 objects -> blocking clarifier.
    g = SceneGraph(
        place_label="broom closet",
        bounds_hint={"w": 10, "h": 10},
        entities=[PlannedEntity(f"box{i}", "item", f"crate {i}", "a wooden crate",
                                footprint={"w": 6, "d": 6}) for i in range(5)],
    )
    res = solve_layout(g)
    assert res.blocked is True
    assert any("fit" in c.lower() for c in res.clarifiers)


def test_unanchored_object_asks_where() -> None:
    g = SceneGraph(
        place_label="empty room",
        entities=[PlannedEntity("lamp", "item", "floor lamp", "a brass floor lamp")],
    )
    res = solve_layout(g)
    assert any("where is the floor lamp" in c.lower() for c in res.clarifiers)


def test_contradictions_block() -> None:
    g = SceneGraph(
        place_label="vault",
        entities=[PlannedEntity("window", "item", "window", "a window")],
        contradictions=["a window in an underground vault with no exterior wall"],
    )
    assert solve_layout(g).blocked is True


def test_on_top_of_sets_elevation() -> None:
    g = SceneGraph(
        place_label="study",
        entities=[
            PlannedEntity("desk", "item", "desk", "an oak desk", footprint={"w": 6, "d": 3}, height=4),
            PlannedEntity("lamp", "item", "lamp", "a small lamp", footprint={"w": 1, "d": 1}, height=2),
        ],
        relations=[PlannedRelation("lamp", "on_top_of", "desk")],
    )
    res = solve_layout(g)
    lamp = _by_label(res.geos, "lamp")[0]
    assert lamp["elevation"] == 4  # sits on the 4-tall desk


def test_solver_is_deterministic() -> None:
    a = solve_layout(_coffee_shop())
    b = solve_layout(_coffee_shop())
    assert a.geos == b.geos
    assert a.clarifiers == b.clarifiers


def test_inside_sits_within_container_flat() -> None:
    g = SceneGraph(
        place_label="kitchen",
        entities=[
            PlannedEntity("cabinet", "item", "cabinet", "an oak cabinet", footprint={"w": 6, "d": 3}),
            PlannedEntity("mug", "item", "mug", "a clay mug", footprint={"w": 1, "d": 1}),
        ],
        relations=[PlannedRelation("mug", "inside", "cabinet")],
    )
    res = solve_layout(g)
    cab = _by_label(res.geos, "cabinet")[0]
    mug = _by_label(res.geos, "mug")[0]
    # nested prop shares its container's spot (not de-overlapped away); flat v1.
    assert mug["pos"] == cab["pos"]
    assert mug["parent_id"] is None


def test_facing_heads_toward_the_object() -> None:
    g = SceneGraph(
        place_label="office",
        entities=[
            PlannedEntity("desk", "item", "desk", "a desk", footprint={"w": 6, "d": 3}),
            PlannedEntity("chair", "item", "chair", "a chair", footprint={"w": 2, "d": 2}),
        ],
        relations=[PlannedRelation("chair", "facing", "desk")],
    )
    chair = _by_label(solve_layout(g).geos, "chair")[0]
    # placed to the right of the desk -> faces WEST back at it (heading ~ ±pi).
    assert abs(abs(chair["heading"]) - math.pi) < 0.1


def test_centre_empty_region_is_central_not_a_corner() -> None:
    from providers.layout_solver import _region_rect

    rect = _region_rect(EmptyRegion("c", "the centre of the room kept open"), 100, 60)
    assert rect[0] > 0 and rect[1] > 0  # not anchored at the origin corner
    cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    assert abs(cx - 50) < 1 and abs(cy - 30) < 1  # centred in the room


def test_wall_object_survives_a_central_clear_region() -> None:
    # The wizard-study case the demo caught: a desk on the back wall + a globe on
    # it must NOT collide with a "centre kept clear" region -> solves, not blocked.
    g = SceneGraph(
        place_label="study",
        entities=[
            PlannedEntity("desk", "item", "desk", "an oak desk", footprint={"w": 6, "d": 3}, height=4),
            PlannedEntity("globe", "item", "globe", "a brass globe", footprint={"w": 1, "d": 1}, height=1),
        ],
        relations=[
            PlannedRelation("desk", "near", "back_wall"),
            PlannedRelation("globe", "on_top_of", "desk"),
        ],
        empty_regions=[EmptyRegion("circle", "the centre of the room kept open")],
    )
    assert solve_layout(g).blocked is False


def test_solver_output_passes_geometry_invariants() -> None:
    """The solver geos must satisfy the geometry invariants (the anchor guarding
    the description->map output), not just the per-test shape asserts."""
    from providers.geometry_checks import check_geo_entities

    issues = check_geo_entities(solve_layout(_coffee_shop()).geos)
    assert issues == [], f"solver output violates invariants: {[str(i) for i in issues]}"


# ── P4 sub-frame nesting (nest_inside; the parity twin lives in
#    apps/web/lib/world-geometry.test.ts "solver nest_inside parity") ─────────


def _kitchen() -> SceneGraph:
    return SceneGraph(
        place_label="kitchen",
        entities=[
            PlannedEntity("cabinet", "item", "cabinet", "an oak cabinet", footprint={"w": 6, "d": 3}),
            PlannedEntity("mug", "item", "mug", "a clay mug", footprint={"w": 1, "d": 1}),
        ],
        relations=[PlannedRelation("mug", "inside", "cabinet")],
    )


def _resolve_abs(geos: list[dict]) -> dict[str, tuple[float, float, float]]:
    """Python twin of world-geometry.ts resolveAbsoluteFrame: (x, y, unit)."""
    by_id = {g["id"]: g for g in geos}

    def one(g: dict) -> tuple[float, float, float]:
        chain, seen = [], set()
        node: dict | None = g
        while node is not None and node["id"] not in seen:
            seen.add(node["id"])
            chain.append(node)
            node = by_id.get(node.get("parent_id") or "")
        x = y = 0.0
        scale_accum = unit = 1.0
        for n in reversed(chain):
            x += n["pos"]["x"] * scale_accum
            y += n["pos"]["y"] * scale_accum
            unit = scale_accum
            scale_accum *= n.get("scale") or 1.0
        return (x, y, unit)

    return {g["id"]: one(g) for g in geos}


def test_nest_inside_reexpresses_child_in_container_frame() -> None:
    res = solve_layout(_kitchen(), nest_inside=True)
    cab = _by_label(res.geos, "cabinet")[0]
    mug = _by_label(res.geos, "mug")[0]
    assert mug["parent_id"] == cab["id"] == "geo_plan_cabinet"
    # Interior unit: container footprint extent / canonical frame extent.
    assert cab["scale"] == 0.06  # max(6,3)/100
    # The mug sat on the cabinet's centre in the flat solve -> local origin,
    # footprint re-expressed into interior units.
    assert mug["pos"] == {"x": 0.0, "y": 0.0}
    assert mug["footprint"] == {"w": 16.667, "d": 16.667}


def test_nest_inside_absolute_geometry_matches_flat() -> None:
    """The promotion is a pure re-expression: resolving the nested chain must
    reproduce the flat solve's absolute pos and footprint for every entity —
    the invariant that makes the world model safe (the corruption P4 feared)."""
    flat = solve_layout(_kitchen()).geos
    nested = solve_layout(_kitchen(), nest_inside=True).geos
    flat_by_id = {g["id"]: g for g in flat}
    resolved = _resolve_abs(nested)
    for g in nested:
        fx, fy = flat_by_id[g["id"]]["pos"]["x"], flat_by_id[g["id"]]["pos"]["y"]
        x, y, unit = resolved[g["id"]]
        assert abs(x - fx) < 1e-6 and abs(y - fy) < 1e-6, g["id"]
        ffp = flat_by_id[g["id"]]["footprint"]
        assert abs(g["footprint"]["w"] * unit - ffp["w"]) < 1e-2, g["id"]
        assert abs(g["footprint"]["d"] * unit - ffp["d"]) < 1e-2, g["id"]


def test_nest_inside_two_level_chain_composes() -> None:
    """mug inside cabinet inside pantry: the nested container's scale is in
    PARENT units, so the chain's cumulative unit equals the world divisor."""
    g = SceneGraph(
        place_label="cellar",
        entities=[
            PlannedEntity("pantry", "item", "pantry", "a walk-in pantry", footprint={"w": 20, "d": 10}),
            PlannedEntity("cabinet", "item", "cabinet", "an oak cabinet", footprint={"w": 6, "d": 3}),
            PlannedEntity("mug", "item", "mug", "a clay mug", footprint={"w": 1, "d": 1}),
        ],
        relations=[
            PlannedRelation("cabinet", "inside", "pantry"),
            PlannedRelation("mug", "inside", "cabinet"),
        ],
    )
    flat = solve_layout(g).geos
    nested = solve_layout(g, nest_inside=True).geos
    by_label = {e["label"]: e for e in nested}
    assert by_label["cabinet"]["parent_id"] == "geo_plan_pantry"
    assert by_label["mug"]["parent_id"] == "geo_plan_cabinet"
    flat_by_id = {e["id"]: e for e in flat}
    resolved = _resolve_abs(nested)
    for e in nested:
        fx, fy = flat_by_id[e["id"]]["pos"]["x"], flat_by_id[e["id"]]["pos"]["y"]
        x, y, unit = resolved[e["id"]]
        assert abs(x - fx) < 1e-3 and abs(y - fy) < 1e-3, e["id"]
        assert abs(e["footprint"]["w"] * unit - flat_by_id[e["id"]]["footprint"]["w"]) < 0.05, e["id"]


def test_nest_inside_output_passes_geometry_invariants() -> None:
    from providers.geometry_checks import check_geo_entities

    res = solve_layout(_kitchen(), nest_inside=True)
    assert check_geo_entities(res.geos) == []


def test_nest_inside_default_off_is_flat() -> None:
    assert solve_layout(_kitchen()).geos == solve_layout(_kitchen(), nest_inside=False).geos
    for g in solve_layout(_kitchen()).geos:
        assert g["parent_id"] is None and "scale" not in g
