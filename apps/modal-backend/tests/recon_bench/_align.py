"""Geometric SCORING for the recon bench. Pure, golden-tested.

The coordinate-frame register — Alignment, fit_alignment, and the fit-health
gate — moved to providers.register (the prod-importable source the extract seam
shares; single source, no duplicate geometry). This module keeps the bench-only
scoring on top: `pos_raw` (absolute placement in the shared frame) and
`pos_aligned` (after the fitted similarity), the fit-health-gated recovery
diagnostic, the leave-one-out pose probe, and the full geo scorecard.
"""
from __future__ import annotations

from math import hypot, log2
from typing import Any

from providers.register import (
    _RECOVERY_MIN_SCALE,
    FRAME_H,
    FRAME_W,
    Point,
    _fit_is_healthy,
    fit_alignment,
)

# A matched entity scores 0 when it lands this fraction of the frame
# diagonal away from ground truth (linear falloff in between).
_POS_TOLERANCE_FRAC = 0.25


def _pos_score(dist: float) -> float:
    tol = _POS_TOLERANCE_FRAC * hypot(FRAME_W, FRAME_H)
    return max(0.0, 1.0 - dist / tol)


def gated_recovery(pairs: list[tuple[Point, Point]]) -> dict[str, Any]:
    """§4 Step 1: score positions AS IF the stored coord were inverse-registered
    into the metric frame — but only when the fit is healthy enough to trust.

    Fit the similarity on the matches; for each observed detection recover its
    metric coordinate via `Alignment.invert` and score that against ground truth
    like pos_raw. On an unhealthy fit (clamped scale / high residual / too few
    matches) fall back to the RAW observed coord, so recovery is never worse than
    storing raw — the phase-1 -35 disaster can't reach a stored coord. Zero
    composite weight: a diagnostic for whether the register is safe to bake into
    stored coords, and how much pos_raw it would buy where it is."""
    if not pairs:
        return {"pos_recovered": 0.0, "gated_on": False}
    raw = sum(_pos_score(hypot(e[0] - o[0], e[1] - o[1])) for e, o in pairs) / len(pairs)
    align = fit_alignment(pairs, min_scale=_RECOVERY_MIN_SCALE)
    if align is None or not _fit_is_healthy(align):
        return {"pos_recovered": round(raw, 4), "gated_on": False}
    recovered = sum(
        _pos_score(hypot(*(a - b for a, b in zip(e, align.invert(o), strict=True))))
        for e, o in pairs
    ) / len(pairs)
    return {"pos_recovered": round(recovered, 4), "gated_on": True}


def pose_probe_loo(pairs: list[tuple[Point, Point]]) -> dict[str, float] | None:
    """§4 phase-1 probe: does the similarity register GENERALIZE?

    pos_aligned fits and scores on the SAME pairs, so it forgives drift but
    cannot say whether the register would correctly place an entity it was
    not fitted on — the metric-pose-recovery question (turn a fresh detection
    into a trustworthy metric coordinate). Leave-one-out: fit on N-1 matched
    pairs, invert-register the held-out observation into the expected frame,
    compare that error to the raw error. recovery_gain > 0 (frame units) ⇒
    read-side recovery is real, not circular. None when <3 pairs (each LOO
    fit needs the fitter's 2-pair minimum)."""
    if len(pairs) < 3:
        return None
    raw_errs: list[float] = []
    rec_errs: list[float] = []
    for i, (e, o) in enumerate(pairs):
        fit = fit_alignment(pairs[:i] + pairs[i + 1 :])
        if fit is None:
            continue
        r = fit.invert(o)
        raw_errs.append(hypot(e[0] - o[0], e[1] - o[1]))
        rec_errs.append(hypot(e[0] - r[0], e[1] - r[1]))
    if not raw_errs:
        return None
    n = len(raw_errs)
    err_raw = sum(raw_errs) / n
    err_rec = sum(rec_errs) / n
    return {
        "n": float(n),
        "err_raw": round(err_raw, 2),
        "err_recovered": round(err_rec, 2),
        "recovery_gain": round(err_raw - err_rec, 2),
    }


def geo_scores(
    expected: dict[str, dict[str, Any]],
    observed: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Geometric scorecard. Both sides keyed by normalized label, each entry
    {pos: (x, y), diag: float} in frame units (diag = footprint diagonal —
    the size proxy). Returns presence, pos_raw, pos_aligned, size, the
    fitted alignment (or None) and the unalignable flag."""
    if not expected:
        return {
            "presence": 0.0, "pos_raw": 0.0, "pos_aligned": 0.0, "size": 0.0,
            "alignment": None, "unalignable": True,
        }
    matched = sorted(set(expected) & set(observed))
    presence = len(matched) / len(expected)
    if not matched:
        return {
            "presence": 0.0, "pos_raw": 0.0, "pos_aligned": 0.0, "size": 0.0,
            "alignment": None, "unalignable": True,
        }
    pairs = [(expected[k]["pos"], observed[k]["pos"]) for k in matched]
    pos_raw = sum(
        _pos_score(hypot(e[0] - o[0], e[1] - o[1])) for e, o in pairs
    ) / len(pairs)
    recovery = gated_recovery(pairs)

    align = fit_alignment(pairs)
    if align is None:
        pos_aligned, size_scale = pos_raw, 1.0
    else:
        pos_aligned = sum(
            _pos_score(hypot(*(a - b for a, b in zip(align.apply(e), o, strict=True))))
            for e, o in pairs
        ) / len(pairs)
        size_scale = align.scale

    # Size: footprint diagonal ratio vs the fitted scale, within x2 falloff
    # in log space (same generosity as height_abs_score).
    size_terms = []
    for k in matched:
        ed, od = expected[k].get("diag", 0.0), observed[k].get("diag", 0.0)
        if ed > 0 and od > 0:
            size_terms.append(max(0.0, 1.0 - abs(log2((od / ed) / size_scale))))
    size = sum(size_terms) / len(size_terms) if size_terms else 0.0

    return {
        "presence": presence,
        "pos_raw": pos_raw,
        "pos_aligned": pos_aligned,
        "size": size,
        # §4 diagnostic: leave-one-out generalization of the register (None
        # when <3 matches). Zero composite weight, like `alignment`.
        "pose_probe": pose_probe_loo(pairs),
        # §4 Step 1 diagnostic (zero weight): pos_raw AS IF stored coords were
        # inverse-registered — but only where the fit is trustworthy (else raw).
        "pos_recovered": recovery["pos_recovered"],
        "recovery_gated_on": recovery["gated_on"],
        "alignment": (
            {
                "scale": round(align.scale, 3),
                "tx": round(align.tx, 2),
                "ty": round(align.ty, 2),
                "flip_x": align.flip_x,
                "residual": round(align.residual, 2),
                "matched": align.matched,
            }
            if align
            else None
        ),
        "unalignable": align is None,
    }
