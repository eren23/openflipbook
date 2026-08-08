"""Coordinate-frame register: fit a similarity between two frames + the fit-health
gate that says when the fit is safe to trust. Pure, golden-tested.

A regenerated (or re-detected) map can have the right RELATIVE layout while the
whole composition shifts or rescales — a render-register difference, not a
reconstruction failure. `fit_alignment` recovers that similarity (uniform scale
+ translation, optionally x-flipped, NO rotation — maps are upright);
`Alignment.invert` maps an observed coordinate back into the expected (storage)
frame. Recovery is only SAFE when the fit is healthy (`_fit_is_healthy`) — a
saturated scale or a high residual means the similarity does not explain the
drift, and inverting through it amplifies error.

Used by the recon bench (§4 pose recovery): tests/recon_bench/_align.py imports
Alignment / fit_alignment / the health gate from here and layers its scoring on
top. (The LIVE prod register runs web-side — apps/web/lib/world-geometry.ts
`fitSimilarity` + `registerPlanToImage`, gated by WORLD_REGISTER_GATE; this Python
twin stays the bench's source of truth for that math.)
"""
from __future__ import annotations

from dataclasses import dataclass
from math import hypot

FRAME_W = 100.0
FRAME_H = 60.0

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
        """Observed frame -> expected (storage) frame — the read-side register:
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
    lower floor to reach coherent deep compressions (gated by _fit_is_healthy)."""
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


# §4 fit-health gate. Storing inverse-registered coords is only safe when the fit
# actually explains the drift; a saturated scale (fitter pinned the clamp) or a
# high residual means it does NOT, and inverting through such a fit can DOUBLE the
# error (phase-1 probe measured -35 mean gain on clamped fits). Gate: scale
# STRICTLY inside the recovery range, residual small in the EXPECTED (storage)
# frame, and enough matches to over-determine the 4-DOF similarity.
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


