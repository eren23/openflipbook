"""Heights gate (free): anchor resolution order (authored > prior > VLM
median), the anchored relative ladder, tier sanity bands (flags, never
clamps), and the two scoring metrics the recon bench consumes."""
from __future__ import annotations

from providers.heights import (
    flag_implausible,
    height_abs_score,
    height_order_score,
    infer_heights_m,
    prior_height_m,
    resolve_anchor,
    tier_sanity_band,
)


def _e(label: str, rel: float, est: float | None = None, visual: str = "") -> dict:
    return {"label": label, "rel_height": rel, "est_height_m": est, "visual": visual}


# --- anchor resolution -------------------------------------------------------


def test_authored_beats_prior_beats_est() -> None:
    entities = [
        _e("watchtower", 1.0, est=99.0),  # has a category prior (tower)
        _e("mystery blob", 0.5, est=10.0),
    ]
    # authored wins
    assert resolve_anchor(entities, {"watchtower": 30.0}) == ("watchtower", 30.0, 1.0)
    # no authored → category prior
    assert resolve_anchor(entities) == ("watchtower", 25.0, 1.0)
    # no prior anywhere → the VLM's own estimate (median entity)
    blobs = [_e("blob a", 1.0, est=20.0), _e("blob b", 0.5, est=8.0)]
    label, meters, _rel = resolve_anchor(blobs) or ("", 0.0, 0.0)
    assert (label, meters) in {("blob a", 20.0), ("blob b", 8.0)}
    # nothing usable → None
    assert resolve_anchor([_e("blob", 0.0)]) is None


def test_prior_matches_label_or_visual() -> None:
    assert prior_height_m("The Old Mill") is None
    assert prior_height_m("The Old Mill", "a squat stone tower with sails") == 25.0
    assert prior_height_m("a person") == 1.7


# --- the ladder --------------------------------------------------------------


def test_infer_heights_scales_the_ladder_off_the_anchor() -> None:
    entities = [
        _e("tower", 1.0),  # prior anchor: 25 m
        _e("house", 0.32),
        _e("flat plaza", 0.0),  # no height read → skipped
    ]
    heights = infer_heights_m(entities)
    assert heights["tower"] == 25.0
    assert heights["house"] == 25.0 * 0.32
    assert "flat plaza" not in heights


def test_infer_heights_authored_anchor_rescales_everything() -> None:
    entities = [_e("keep", 1.0), _e("gatehouse", 0.5)]
    heights = infer_heights_m(entities, {"keep": 40.0})
    assert heights == {"keep": 40.0, "gatehouse": 20.0}


def test_infer_heights_no_anchor_falls_back_to_raw_estimates() -> None:
    entities = [_e("blob", 0.0, est=7.0), _e("smudge", 0.0)]
    assert infer_heights_m(entities) == {"blob": 7.0}


# --- sanity bands ------------------------------------------------------------


def test_tier_band_flags_but_never_clamps() -> None:
    lo, hi = tier_sanity_band("place")
    assert (lo, hi) == (0.1, 120.0)
    assert tier_sanity_band(None)[1] == float("inf")
    flags = flag_implausible({"spire": 5000.0, "hut": 4.0}, "place")
    assert len(flags) == 1 and "spire" in flags[0] and "place" in flags[0]
    # the value itself is untouched — the caller decides
    assert flag_implausible({"hut": 4.0}, "place") == []


# --- scoring -----------------------------------------------------------------


def test_height_order_score_pairwise_agreement() -> None:
    expected = {"tower": 25.0, "house": 8.0, "hut": 4.0}
    assert height_order_score(expected, {"tower": 30.0, "house": 10.0, "hut": 2.0}) == 1.0
    # the tower↔house pair inverts; the other two pairs still agree
    swapped = {"tower": 5.0, "house": 10.0, "hut": 2.0}
    assert height_order_score(expected, swapped) == 2 / 3
    # fewer than 2 comparable labels → no credit
    assert height_order_score(expected, {"tower": 30.0}) == 0.0
    assert height_order_score({}, {}) == 0.0


def test_height_abs_score_within_2x_in_log_space() -> None:
    expected = {"tower": 25.0, "house": 8.0}
    assert height_abs_score(expected, {"tower": 49.0, "house": 4.1}) == 1.0  # both within x2
    assert height_abs_score(expected, {"tower": 51.0, "house": 8.0}) == 0.5  # tower busts x2
    assert height_abs_score(expected, {}) == 0.0
