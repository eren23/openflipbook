"""Free (unpaid) tests for the VIEW-conformance bench — cases + the gates' brain.

The paid run (view_runner._cli, gated on VIEW_BENCH_RUN) spends on fal gens +
the Gemini judge. These pin the parts that don't: well-formed cases/arms, the
two gates (every deliberate projection lands; no view change costs identity),
and the project_top_down port the positioning probe depends on.
"""
from __future__ import annotations

from providers.geometry import project_top_down
from tests.continuity_bench.view_runner import (
    _ARM_INTENT,
    _ARM_VIEWS,
    _CASES,
    ArmResult,
    CaseResult,
    summarize,
)


def _case(name: str, conf: dict[str, float], same: dict[str, float]) -> CaseResult:
    return CaseResult(
        name=name,
        arms=[
            ArmResult(arm=a, conformance=conf[a], same_place=same[a], conformance_rationale="")
            for a in _ARM_VIEWS
        ],
    )


def test_cases_and_arms_are_well_formed() -> None:
    assert len(_CASES) >= 2
    assert set(_ARM_VIEWS) == {"none", "top_down", "oblique", "isometric", "eye_level"}
    assert _ARM_INTENT["none"] == "eye_level"  # the legacy claim, judged honestly
    for arm, view in _ARM_VIEWS.items():
        if view is not None:
            assert view["projection"] == arm
            assert view["source"] == "user"


def test_summarize_gates() -> None:
    good_conf = {"none": 5.0, "top_down": 9.0, "oblique": 8.0, "isometric": 7.0, "eye_level": 9.0}
    good_same = {"none": 8.0, "top_down": 7.0, "oblique": 7.5, "isometric": 6.5, "eye_level": 9.0}
    s = summarize([_case("a", good_conf, good_same)])
    assert s["view_trustworthy"] is True
    assert s["same_place_floor_held"] is True
    assert s["arms"]["none"]["conformance_mean"] == 5.0  # BEFORE arm reported, not gated
    # an iso that drifts to perspective fails gate 1
    bad_conf = dict(good_conf, isometric=4.0)
    assert summarize([_case("a", bad_conf, good_same)])["view_trustworthy"] is False
    # a view change that loses the place fails gate 2
    bad_same = dict(good_same, oblique=4.0)
    assert summarize([_case("a", good_conf, bad_same)])["same_place_floor_held"] is False


def test_project_top_down_port_matches_ts_semantics() -> None:
    # The line-for-line port of world-geometry.ts projectTopDown: linear in the
    # frame, depth = pos.y (north-first), footprint -> apparent size bins.
    ents = [
        {"id": "b", "label": "South Keep", "pos": {"x": 50.0, "y": 45.0},
         "height": 10.0, "footprint": {"w": 40.0, "d": 30.0}},
        {"id": "a", "label": "North Tower", "pos": {"x": 10.0, "y": 6.0},
         "height": 12.0, "footprint": {"w": 5.0, "d": 5.0}},
    ]
    out = project_top_down(ents, 100.0, 60.0)  # type: ignore[arg-type]
    assert [e["id"] for e in out] == ["a", "b"]  # north (smaller y) first
    north = out[0]
    assert north["x_pct"] == 0.1 and north["y_pct"] == 0.1
    assert north["h_pos"] == "far-left" and north["v_pos"] == "top"
    south = out[1]
    assert south["x_pct"] == 0.5
    assert south["size"] in ("large", "huge")  # 40/100 wide footprint
    assert south["depth"] == 45.0
