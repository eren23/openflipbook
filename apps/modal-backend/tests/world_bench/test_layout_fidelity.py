"""P3 layout-fidelity aggregation gate (free).

The judge→score math is deterministic + tolerant. The LIVE A/B (generate
with/without the layout clause + judge) is layout_runner.run — run it via
`make eval-layout` (paid; needs keys). conftest scrubs FAL_KEY/OPENROUTER so a
live judge can't fire from inside pytest, which is why the A/B lives in the runner.
"""
from __future__ import annotations

import pytest

from tests.world_bench._score import aggregate_layout_fidelity


def test_perfect_judge_scores_one() -> None:
    j = {
        "entities": [{"label": "a", "present": True, "position_ok": 10, "size_ok": 10}],
        "depth_order_ok": 10,
    }
    r = aggregate_layout_fidelity(j)
    assert r.score == pytest.approx(1.0)
    assert r.presence_rate == 1.0
    assert r.per_entity["a"] == pytest.approx(1.0)


def test_absent_entity_scores_zero() -> None:
    j = {
        "entities": [{"label": "a", "present": False, "position_ok": 0, "size_ok": 0}],
        "depth_order_ok": 0,
    }
    assert aggregate_layout_fidelity(j).score == 0.0


def test_partial_match_is_a_mid_score() -> None:
    j = {
        "entities": [{"label": "a", "present": True, "position_ok": 6, "size_ok": 4}],
        "depth_order_ok": 8,
    }
    assert 0.5 < aggregate_layout_fidelity(j).score < 0.75


def test_garbage_judge_scores_zero_or_presence_only() -> None:
    assert aggregate_layout_fidelity({}).score == 0.0
    assert aggregate_layout_fidelity({"entities": "nope"}).score == 0.0
    assert aggregate_layout_fidelity({"entities": []}).score == 0.0
    # Non-numeric position/size → only the presence term survives.
    j = {
        "entities": [{"label": "a", "present": True, "position_ok": "x", "size_ok": None}],
        "depth_order_ok": "y",
    }
    assert aggregate_layout_fidelity(j).score == pytest.approx(0.2 * 0.85)


def test_presence_rate_counts_present_only() -> None:
    j = {
        "entities": [
            {"label": "a", "present": True, "position_ok": 5, "size_ok": 5},
            {"label": "b", "present": False, "position_ok": 0, "size_ok": 0},
        ],
        "depth_order_ok": 5,
    }
    assert aggregate_layout_fidelity(j).presence_rate == 0.5
