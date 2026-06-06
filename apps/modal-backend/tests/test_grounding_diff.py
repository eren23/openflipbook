"""P4 grounding-diff gate (free): expected-vs-detected matching is exact."""
from __future__ import annotations

import pytest

from providers import grounding
from providers.grounding import diff


def _box(label: str, x: float, y: float, w: float = 0.2, h: float = 0.2) -> dict:
    return {"label": label, "x_pct": x, "y_pct": y, "w_pct": w, "h_pct": h}


def test_iou_basic() -> None:
    assert grounding.iou((0, 0, 1, 1), (0, 0, 1, 1)) == 1.0
    assert grounding.iou((0, 0, 1, 1), (1, 1, 2, 2)) == 0.0
    assert grounding.iou((0, 0, 2, 2), (1, 0, 3, 2)) == pytest.approx(2 / 6)


def test_perfect_match_scores_one() -> None:
    r = diff([_box("tower", 0.5, 0.3)], [_box("tower", 0.5, 0.3)])
    assert [m.label for m in r.matched] == ["tower"]
    assert r.matched[0].iou == pytest.approx(1.0)
    assert r.matched[0].pos_ok
    assert r.missing == [] and r.extra == []
    assert r.score == pytest.approx(1.0)


def test_missing_and_extra() -> None:
    r = diff(
        [_box("tower", 0.5, 0.3), _box("boat", 0.1, 0.8)],
        [_box("tower", 0.5, 0.3), _box("dragon", 0.9, 0.9)],
    )
    assert [m.label for m in r.matched] == ["tower"]
    assert r.missing == ["boat"]
    assert r.extra == ["dragon"]


def test_overlapping_but_misplaced_is_pos_not_ok() -> None:
    # same label, IoU above threshold, but centre dx > POS_TOL → pos_ok False.
    r = diff([_box("tower", 0.3, 0.3, 0.5, 0.5)], [_box("tower", 0.6, 0.3, 0.5, 0.5)])
    assert len(r.matched) == 1 and r.matched[0].pos_ok is False


def test_fuzzy_label_match() -> None:
    r = diff([_box("stone fountain", 0.5, 0.5)], [_box("fountain", 0.5, 0.5)])
    assert len(r.matched) == 1  # "fountain" ⊂ "stone fountain"


def test_below_iou_threshold_not_matched() -> None:
    r = diff(
        [_box("tower", 0.2, 0.2, 0.1, 0.1)],
        [_box("tower", 0.8, 0.8, 0.1, 0.1)],
        iou_thresh=0.2,
    )
    assert r.matched == []
    assert r.missing == ["tower"] and r.extra == ["tower"]
