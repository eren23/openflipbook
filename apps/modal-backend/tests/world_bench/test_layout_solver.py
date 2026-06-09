"""Golden tests for the deterministic place-layout solver (B1).

Pure CPU, free, always-runs (no marker). Proves the load-bearing guarantees:
relative ordering from relations, count fan-out, "empty stays empty" at solve,
and the blocking clarifiers (over-pack / unanchored). Same discipline as the
geometry golden — same input, same output.
"""
from __future__ import annotations

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
