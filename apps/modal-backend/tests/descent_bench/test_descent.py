"""Descent-bench aggregation (free): the report rolls up BOTH the
medium-confounded style_lift AND the medium-agnostic place_lift, so an
illustration->photo chain is no longer judged solely on a medium gap it can
never close."""
from __future__ import annotations

import pytest

from tests.descent_bench.runner import _aggregate


def _row(style_lift: float, place_lift: float) -> dict:
    return {"child_id": "c", "style_lift": style_lift, "place_lift": place_lift}


def test_aggregate_means_both_lifts() -> None:
    report = _aggregate([_row(-7.0, 4.0), _row(1.0, 2.0)])
    assert report["mean_style_lift"] == pytest.approx(-3.0)
    assert report["mean_place_lift"] == pytest.approx(3.0)
    assert report["chains"] == [_row(-7.0, 4.0), _row(1.0, 2.0)]


def test_aggregate_empty_is_zero() -> None:
    report = _aggregate([])
    assert report["mean_style_lift"] == 0.0
    assert report["mean_place_lift"] == 0.0
    assert report["chains"] == []
