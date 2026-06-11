"""Recon-bench gate (free): the alignment fit recovers synthetic
shift/scale/flip transforms, the geometric scorecard behaves at the edges,
the expected-layout builder produces correct bins + height ratios, and
corpus scenario resolution honours the verified-only contract."""
from __future__ import annotations

from typing import Any

import pytest

from tests.recon_bench._align import Alignment, fit_alignment, geo_scores
from tests.recon_bench.runner import _expected_layout, corpus_scenarios

# --- alignment fit -----------------------------------------------------------


def _pairs(transform, pts: list[tuple[float, float]]):
    return [(p, transform(p)) for p in pts]


PTS = [(10.0, 10.0), (50.0, 30.0), (90.0, 50.0), (30.0, 45.0)]


def test_fit_recovers_translation() -> None:
    a = fit_alignment(_pairs(lambda p: (p[0] + 7, p[1] - 3), PTS))
    assert a is not None and not a.flip_x
    assert a.scale == pytest.approx(1.0, abs=1e-6)
    assert (a.tx, a.ty) == (pytest.approx(7.0), pytest.approx(-3.0))
    assert a.residual == pytest.approx(0.0, abs=1e-6)


def test_fit_recovers_scale_and_flip() -> None:
    a = fit_alignment(_pairs(lambda p: (1.5 * p[0] - 10, 1.5 * p[1] + 5), PTS))
    assert a is not None and a.scale == pytest.approx(1.5) and not a.flip_x
    flipped = fit_alignment(_pairs(lambda p: (100.0 - p[0], p[1]), PTS))
    assert flipped is not None and flipped.flip_x
    assert flipped.residual == pytest.approx(0.0, abs=1e-6)


def test_fit_clamps_scale_and_needs_two_points() -> None:
    a = fit_alignment(_pairs(lambda p: (5 * p[0], 5 * p[1]), PTS))
    assert a is not None and a.scale == 2.0  # clamped, residual stays honest
    assert a.residual > 0
    assert fit_alignment([(PTS[0], PTS[0])]) is None


def test_alignment_apply_round_trips() -> None:
    a = Alignment(scale=1.5, tx=-10.0, ty=5.0, flip_x=False, residual=0.0, matched=4)
    assert a.apply((10.0, 10.0)) == (pytest.approx(5.0), pytest.approx(20.0))


# --- geometric scorecard -----------------------------------------------------


def _entry(x: float, y: float, diag: float = 8.0) -> dict[str, Any]:
    return {"pos": (x, y), "diag": diag}


def test_geo_scores_perfect_reconstruction() -> None:
    truth = {"tower": _entry(20, 10), "harbor": _entry(70, 40), "wood": _entry(40, 50)}
    s = geo_scores(truth, dict(truth))
    assert s["presence"] == 1.0
    assert s["pos_raw"] == pytest.approx(1.0)
    assert s["pos_aligned"] == pytest.approx(1.0)
    assert s["size"] == pytest.approx(1.0)
    assert not s["unalignable"]


def test_geo_scores_shifted_layout_scores_high_aligned_low_raw() -> None:
    truth = {"tower": _entry(20, 10), "harbor": _entry(70, 40), "wood": _entry(40, 50)}
    shifted = {k: _entry(v["pos"][0] + 20, v["pos"][1] + 8) for k, v in truth.items()}
    s = geo_scores(truth, shifted)
    assert s["pos_aligned"] == pytest.approx(1.0)  # relative layout intact
    assert s["pos_raw"] < 0.6  # absolute register drifted
    assert s["alignment"]["tx"] == pytest.approx(20.0)


def test_geo_scores_misses_and_empty() -> None:
    truth = {"tower": _entry(20, 10), "harbor": _entry(70, 40)}
    s = geo_scores(truth, {"tower": _entry(20, 10)})
    assert s["presence"] == 0.5
    assert s["unalignable"]  # one match can't anchor a transform
    assert s["pos_aligned"] == s["pos_raw"]
    empty = geo_scores(truth, {})
    assert empty["presence"] == 0.0 and empty["pos_raw"] == 0.0
    assert geo_scores({}, {})["presence"] == 0.0


# --- expected layout builder -------------------------------------------------


def _desc() -> dict[str, Any]:
    return {
        "map_id": "t",
        "genre": "fantasy",
        "style": "ink",
        "description": "a tower north of a harbor",
        "frame": {"w": 100.0, "h": 60.0},
        "entities": [
            {
                "ref": "tower", "kind": "place", "label": "The Tower",
                "visual": "", "pos": {"x": 50.0, "y": 12.0},
                "footprint": {"w": 6.0, "d": 6.0}, "height_m": 30.0,
                "height_rel": 1.0, "border": None,
            },
            {
                "ref": "harbor", "kind": "place", "label": "The Harbor",
                "visual": "", "pos": {"x": 50.0, "y": 48.0},
                "footprint": {"w": 20.0, "d": 10.0}, "height_m": 6.0,
                "height_rel": 0.2, "border": None,
            },
        ],
        "relations": [],
        "review": {"status": "verified", "by": "t", "date": "t"},
    }


def test_expected_layout_bins_and_heights() -> None:
    expected, heights = _expected_layout(_desc())
    by = {e["label"]: e for e in expected}
    assert by["The Tower"]["h_pos"] == "center"
    assert by["The Tower"]["v_pos"] == "top"
    assert by["The Harbor"]["v_pos"] == "bottom"
    # heights anchor on the SHORTEST real height (the harbor, 6 m)
    assert heights == [("The Tower", pytest.approx(5.0), "The Harbor")]


def test_expected_layout_needs_two_real_heights() -> None:
    d = _desc()
    d["entities"][1]["height_m"] = None
    _, heights = _expected_layout(d)
    assert heights is None


# --- scenario resolution -----------------------------------------------------


def test_corpus_scenarios_verified_only_and_deduped() -> None:
    scenarios = corpus_scenarios(["corpus:*", "corpus:fantasy-treasure-island"])
    ids = [s.id for s in scenarios]
    assert len(ids) == len(set(ids)), "specs must dedupe"
    assert "fantasy-treasure-island" in ids
    # drafts are excluded by contract
    from tests.map_corpus import load_descriptions

    drafts = {d["map_id"] for d in load_descriptions(status="vlm_draft")}
    assert not drafts & set(ids)


def test_corpus_scenarios_rejects_unverified() -> None:
    from tests.map_corpus import load_descriptions

    drafts = [d["map_id"] for d in load_descriptions(status="vlm_draft")]
    if not drafts:
        pytest.skip("no drafts in the corpus right now")
    with pytest.raises(SystemExit, match="not a VERIFIED"):
        corpus_scenarios([f"corpus:{drafts[0]}"])
