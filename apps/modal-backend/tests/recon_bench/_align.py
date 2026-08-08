"""Coordinate-frame alignment + geometric scoring. Pure, golden-tested.

A regenerated map can have the right RELATIVE layout while the whole
composition shifts or rescales — that is a render-register difference, not
a reconstruction failure. So we score positions twice: `pos_raw` (absolute
placement in the shared frame) and `pos_aligned` (after fitting a
similarity transform: uniform scale 0.5..2 + translation, optionally
x-flipped, NO rotation — maps are upright). Fewer than 2 label matches
can't anchor a transform → aligned := raw, flagged unalignable.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import hypot, log2
from typing import Any

FRAME_W = 100.0
FRAME_H = 60.0
# A matched entity scores 0 when it lands this fraction of the frame
# diagonal away from ground truth (linear falloff in between).
_POS_TOLERANCE_FRAC = 0.25

Point = tuple[float, float]


@dataclass(frozen=True)
class Alignment:
    scale: float
    tx: float
    ty: float
    flip_x: bool
    residual: float  # RMS distance after transform, frame units
    matched: int

    def apply(self, p: Point) -> Point:
        x = (FRAME_W - p[0]) if self.flip_x else p[0]
        return (self.scale * x + self.tx, self.scale * p[1] + self.ty)

    def invert(self, p: Point) -> Point:
        """Observed frame -> expected (metric) frame — the read-side register:
        what a recovered coordinate for a fresh detection would be."""
        x = (p[0] - self.tx) / self.scale
        y = (p[1] - self.ty) / self.scale
        return ((FRAME_W - x) if self.flip_x else x, y)


def fit_alignment(
    pairs: list[tuple[Point, Point]], *, min_scale: float = 0.5
) -> Alignment | None:
    """Least-squares uniform scale + translation over (expected, observed)
    centre pairs; tries the x-flipped register too and keeps the lower
    residual. None when <2 pairs (nothing to anchor). `min_scale` is the lower
    scale clamp (default 0.5, the pos_aligned register); recovery re-fits with a
    lower floor to reach coherent deep compressions (see gated_recovery)."""
    if len(pairs) < 2:
        return None
    best: Alignment | None = None
    for flip in (False, True):
        exp = [((FRAME_W - e[0]) if flip else e[0], e[1]) for e, _ in pairs]
        obs = [o for _, o in pairs]
        n = len(pairs)
        ex = sum(p[0] for p in exp) / n
        ey = sum(p[1] for p in exp) / n
        ox = sum(p[0] for p in obs) / n
        oy = sum(p[1] for p in obs) / n
        num = sum(
            (e[0] - ex) * (o[0] - ox) + (e[1] - ey) * (o[1] - oy)
            for e, o in zip(exp, obs, strict=True)
        )
        den = sum((e[0] - ex) ** 2 + (e[1] - ey) ** 2 for e in exp)
        s = num / den if den > 1e-9 else 1.0
        s = max(min_scale, min(2.0, s))
        tx = ox - s * ex
        ty = oy - s * ey
        residual = (
            sum(
                (s * e[0] + tx - o[0]) ** 2 + (s * e[1] + ty - o[1]) ** 2
                for e, o in zip(exp, obs, strict=True)
            )
            / n
        ) ** 0.5
        cand = Alignment(s, tx, ty, flip, residual, n)
        if best is None or cand.residual < best.residual:
            best = cand
    return best


def _pos_score(dist: float) -> float:
    tol = _POS_TOLERANCE_FRAC * hypot(FRAME_W, FRAME_H)
    return max(0.0, 1.0 - dist / tol)


# §4 fit-health-gated recovery. Storing inverse-registered coords is only safe
# when the fit actually explains the drift; a saturated scale (fitter pinned the
# clamp) or a high residual means it does NOT, and inverting through such a fit
# can DOUBLE the error (phase-1 probe measured -35 mean gain on clamped fits).
# Gate: scale STRICTLY inside the recovery range, residual small in the EXPECTED
# (storage) frame, and enough matches to over-determine the 4-DOF similarity.
#
# The residual is measured in the storage frame — residual / scale — because
# `invert` divides by scale, so a compression fit (scale < 1) AMPLIFIES its
# observed-frame residual by 1/scale on the way back (the recon corpus caught a
# scale-0.588 cell whose invert wobbled pos_raw -0.009; expected-frame residual
# flags exactly those noise-amplifying compressions). This gate SELF-TIGHTENS as
# scale drops: at 0.40 it admits only observed residual ≤ 0.40·MAX ≈ 4.7 — a very
# coherent fit — which is what lets the floor go below the pos_aligned clamp.
#
# _RECOVERY_MIN_SCALE (0.40) < the pos_aligned register floor (0.5): the recon
# corpus draws some maps (Schiaparelli's Mars) at a coherent ~½ scale that pins
# the 0.5 clamp; re-fitting recovery down to 0.40 reaches them (pos_raw 0.05→0.62)
# while the residual gate keeps the scrambled cells (yellowstone/village) out.
_RECOVERY_MIN_MATCHED = 3
_RECOVERY_MIN_SCALE = 0.40
_RECOVERY_RESIDUAL_MAX = 0.10 * hypot(FRAME_W, FRAME_H)  # ~11.7 frame units


def _fit_is_healthy(align: Alignment) -> bool:
    return (
        align.matched >= _RECOVERY_MIN_MATCHED
        and _RECOVERY_MIN_SCALE < align.scale < 2.0  # strictly inside, not saturated
        and align.residual / align.scale <= _RECOVERY_RESIDUAL_MAX  # expected frame
    )


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
