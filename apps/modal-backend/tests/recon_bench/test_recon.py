"""Recon-bench gate (free): the alignment fit recovers synthetic
shift/scale/flip transforms, the geometric scorecard behaves at the edges,
the expected-layout builder produces correct bins + height ratios, and
corpus scenario resolution honours the verified-only contract."""
from __future__ import annotations

from math import hypot
from typing import Any

import pytest

from tests.recon_bench._align import (
    Alignment,
    _pos_score,
    fit_alignment,
    gated_recovery,
    geo_scores,
    pose_probe_loo,
)
from tests.recon_bench.runner import _expected_layout, corpus_scenarios

# --- alignment fit -----------------------------------------------------------


def _pairs(transform, pts: list[tuple[float, float]]):
    return [(p, transform(p)) for p in pts]


def _pos(e: tuple[float, float], o: tuple[float, float]) -> float:
    return _pos_score(hypot(e[0] - o[0], e[1] - o[1]))


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


def test_alignment_invert_undoes_apply_including_flip() -> None:
    for flip in (False, True):
        a = Alignment(scale=0.65, tx=12.0, ty=-4.0, flip_x=flip, residual=0.0, matched=4)
        for p in PTS:
            x, y = a.invert(a.apply(p))
            assert (x, y) == (pytest.approx(p[0]), pytest.approx(p[1]))


# --- pose probe (§4 phase 1: does the register GENERALIZE?) ------------------
#
# pos_aligned fits and scores on the SAME pairs — it forgives drift but can't
# say whether the register would place an entity it was NOT fitted on (the
# metric-pose-recovery question). The leave-one-out probe answers that: fit on
# N-1 matches, invert-register the held-out observation, compare its error to
# the raw error. recovery_gain > 0 ⇒ read-side recovery is real, not circular.


def test_pose_probe_register_drift_recovers() -> None:
    # The wild drift signature: whole layout rescaled 0.65 + shifted. Raw
    # errors are huge; the register generalizes so LOO recovery is ~exact.
    pairs = _pairs(lambda p: (0.65 * p[0] + 12, 0.65 * p[1] + 8), PTS)
    probe = pose_probe_loo(pairs)
    assert probe is not None and probe["n"] == 4
    assert probe["err_raw"] > 10
    assert probe["err_recovered"] == pytest.approx(0.0, abs=0.1)
    assert probe["recovery_gain"] > 10


def test_pose_probe_scatter_does_not_fake_recovery() -> None:
    # Unstructured error (each entity off in a different direction) — no
    # shared register exists, so LOO must NOT report a healthy gain.
    scatter = [
        ((10.0, 10.0), (30.0, 50.0)),
        ((50.0, 30.0), (20.0, 10.0)),
        ((90.0, 50.0), (60.0, 5.0)),
        ((30.0, 45.0), (85.0, 20.0)),
    ]
    probe = pose_probe_loo(scatter)
    assert probe is not None
    assert probe["recovery_gain"] < 5  # no drift structure to exploit


def test_pose_probe_out_of_clamp_rescale_leaves_residual() -> None:
    # A coherent rescale whose TRUE scale (3.0) sits outside fit_alignment's
    # [0.5, 2.0] clamp. The clamp saturates at 2.0 — never the true 3.0 — so the
    # register can only PARTIALLY recover: err_recovered stays well above 0,
    # unlike an in-clamp drift which recovers ~exactly (…register_drift_recovers).
    # (recovery_gain is still large+positive here — clamped-2.0 beats identity —
    # so gain alone can't flag this; err_recovered is the honest signal.) Pins the
    # clamp: widen/remove it and err_recovered collapses to ~0 on this case,
    # faking read-side recovery the product's clamped register can never deliver.
    pairs = _pairs(lambda p: (3.0 * p[0] + 5, 3.0 * p[1] + 5), PTS)
    fit = fit_alignment(pairs)
    assert fit is not None and fit.scale == 2.0  # clamp bites, not the true 3.0
    probe = pose_probe_loo(pairs)
    assert probe is not None
    assert probe["err_recovered"] > 5.0  # partial only; ≈0 if the clamp were gone


def test_pose_probe_needs_three_pairs() -> None:
    assert pose_probe_loo(_pairs(lambda p: p, PTS[:2])) is None


# --- §4 Step 1: fit-health-gated recovery ------------------------------------
#
# gated_recovery scores positions AS IF the stored coord were inverse-registered
# into the metric frame — but ONLY when the fit is trustworthy (scale strictly
# in-clamp, low residual, ≥3 matches). On an unhealthy fit it must fall back to
# the raw coord, so recovery is never worse than storing raw (the phase-1 -35
# clamped-fit disaster can never reach a stored coord).


def test_gated_recovery_healthy_drift_beats_raw() -> None:
    # A clean in-clamp similarity drift (scale 0.65 + shift, residual ~0): the
    # gate opens and inverse-registering recovers the metric coords ~exactly, so
    # pos_recovered clears pos_raw.
    pairs = _pairs(lambda p: (0.65 * p[0] + 18, 0.65 * p[1] + 14), PTS)
    raw = sum(_pos(e, o) for e, o in pairs) / len(pairs)
    rec = gated_recovery(pairs)
    assert rec["gated_on"] is True
    assert rec["pos_recovered"] > raw
    assert rec["pos_recovered"] == pytest.approx(1.0, abs=0.02)


def test_gated_recovery_clamped_scale_gates_off() -> None:
    # True scale 3.0 saturates the fitter at 2.0 — inverting through the wrong
    # scale is the -35 hazard, so the gate stays SHUT and pos_recovered == raw.
    pairs = _pairs(lambda p: (3.0 * p[0] + 5, 3.0 * p[1] + 5), PTS)
    raw = sum(_pos(e, o) for e, o in pairs) / len(pairs)
    rec = gated_recovery(pairs)
    assert rec["gated_on"] is False
    assert rec["pos_recovered"] == round(raw, 4)  # gates off ⇒ raw, unrounded-safe


def test_gated_recovery_high_residual_gates_off() -> None:
    # In-range scale (~1) but the layout doesn't fit ANY global similarity
    # (per-point noise ~21 units > the residual gate): don't trust the invert.
    noisy = [
        ((10.0, 10.0), (25.0, -5.0)),
        ((50.0, 30.0), (35.0, 45.0)),
        ((90.0, 50.0), (105.0, 35.0)),
        ((30.0, 45.0), (15.0, 60.0)),
    ]
    fit = fit_alignment(noisy)
    assert fit is not None and 0.5 < fit.scale < 2.0 and fit.residual > 11.7
    raw = sum(_pos(e, o) for e, o in noisy) / len(noisy)
    rec = gated_recovery(noisy)
    assert rec["gated_on"] is False
    assert rec["pos_recovered"] == round(raw, 4)  # gates off ⇒ raw, unrounded-safe


def test_gated_recovery_too_few_matches_gates_off() -> None:
    # A perfect 2-point drift still can't be trusted (2 matches only exactly
    # determine the 4-DOF fit — no residual left to expose overfit).
    pairs = _pairs(lambda p: (0.65 * p[0] + 12, 0.65 * p[1] + 8), PTS[:2])
    raw = sum(_pos(e, o) for e, o in pairs) / len(pairs)
    rec = gated_recovery(pairs)
    assert rec["gated_on"] is False
    assert rec["pos_recovered"] == round(raw, 4)  # gates off ⇒ raw, unrounded-safe


def test_gated_recovery_empty() -> None:
    assert gated_recovery([]) == {"pos_recovered": 0.0, "gated_on": False}


def test_gate_uses_expected_frame_residual() -> None:
    # invert divides by scale, so a compression fit (scale<1) amplifies its
    # observed residual by 1/scale in the storage frame. Gate on residual/scale:
    # the SAME observed residual is healthy at scale 1 but not when compressed.
    # (This is the recon-corpus scale-0.588 cell that wobbled pos_raw -0.009.)
    from tests.recon_bench._align import _RECOVERY_RESIDUAL_MAX as MAX
    from tests.recon_bench._align import _fit_is_healthy

    resid = 0.9 * MAX  # comfortably under the cap in the OBSERVED frame
    ok = Alignment(scale=1.0, tx=0, ty=0, flip_x=False, residual=resid, matched=4)
    bad = Alignment(scale=0.6, tx=0, ty=0, flip_x=False, residual=resid, matched=4)
    assert _fit_is_healthy(ok) is True  # 0.9*MAX / 1.0 <= MAX
    assert _fit_is_healthy(bad) is False  # 0.9*MAX / 0.6 = 1.5*MAX > MAX


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


def test_corpus_scenarios_filters_by_tier() -> None:
    from tests.map_corpus import load_descriptions, load_manifest

    closeups = corpus_scenarios(["corpus:tier=closeup"])
    ids = {s.id for s in closeups}
    expected = {m["id"] for m in load_manifest(tier="closeup")} & {
        d["map_id"] for d in load_descriptions(status="verified")
    }
    assert ids == expected and expected  # resolves the verified closeups, non-empty
    # maps must NOT leak into a closeup-tier sweep
    assert "fantasy-treasure-island" not in ids
    # and a map-tier sweep excludes the closeups
    map_ids = {s.id for s in corpus_scenarios(["corpus:tier=map"])}
    assert "fantasy-treasure-island" in map_ids and not (map_ids & ids)


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
