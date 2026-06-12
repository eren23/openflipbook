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


def fit_alignment(pairs: list[tuple[Point, Point]]) -> Alignment | None:
    """Least-squares uniform scale + translation over (expected, observed)
    centre pairs; tries the x-flipped register too and keeps the lower
    residual. None when <2 pairs (nothing to anchor)."""
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
        s = max(0.5, min(2.0, s))
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
