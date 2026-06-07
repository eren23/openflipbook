"""Grounding: diff a rendered scene against its expected layout + a bounded
verify→repair loop.

`diff` greedily matches detected entities to expected ones (label + IoU),
producing matched/missing/extra + a 0..1 score. `run_grounding_loop` drives a
bounded detect→diff→repair→re-verify cycle with injected `verify`/`repair`
callables — so the control flow is unit-tested with mocks (free) and the live
path passes the real detector + inpaint. Pure except for the injected awaits.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from providers.detector import Detection
from providers.geometry import ProjectedEntity

# The image flowing through the loop is opaque to it: production passes a
# GeneratedImage, the unit tests pass a sentinel str. The loop only ever hands it
# back to the injected verify/repair callbacks, so it's generic (ImageT type
# parameter, below), not `Any`.

# A matched observed box within this centre distance (normalised) of its expected
# centre counts as correctly positioned.
POS_TOL = 0.2


def _to_corners(cx: float, cy: float, w: float, h: float) -> tuple[float, float, float, float]:
    return (cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0)


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _label_match(a: str, b: str) -> bool:
    a, b = a.lower().strip(), b.lower().strip()
    return bool(a) and bool(b) and (a == b or a in b or b in a)


@dataclass(frozen=True)
class Match:
    label: str
    iou: float
    pos_ok: bool


@dataclass(frozen=True)
class GroundingReport:
    matched: list[Match]
    missing: list[str]  # expected labels with no detection
    extra: list[str]  # detections that were not expected
    score: float  # 0..1
    mean_iou: float


def diff(
    expected: list[ProjectedEntity],
    observed: list[Detection],
    *,
    iou_thresh: float = 0.2,
) -> GroundingReport:
    """Match observed (detected) boxes to expected ones by label + max IoU. Boxes
    are centre-based {x_pct, y_pct, w_pct, h_pct} (matching ProjectedEntity)."""
    used: set[int] = set()
    matched: list[Match] = []
    matched_exp: set[int] = set()  # expected INDICES matched (not labels — dupes)
    for ei, e in enumerate(expected):
        e_box = _to_corners(e["x_pct"], e["y_pct"], e["w_pct"], e["h_pct"])
        best: tuple[int, float, Detection] | None = None
        for j, o in enumerate(observed):
            if j in used or not _label_match(str(e["label"]), str(o.get("label", ""))):
                continue
            o_box = _to_corners(o["x_pct"], o["y_pct"], o["w_pct"], o["h_pct"])
            score = iou(e_box, o_box)
            if best is None or score > best[1]:
                best = (j, score, o)
        if best is not None:
            # A label match means the entity is PRESENT; pos_ok captures whether
            # it landed where the layout wanted it (so a present-but-misplaced
            # entity is matched+pos_ok=False, not missing+extra — the loop repairs
            # it; `missing` stays "truly absent / hallucinated-away").
            j, score, o = best
            used.add(j)
            matched_exp.add(ei)
            pos_ok = (
                score >= iou_thresh
                and abs(o["x_pct"] - e["x_pct"]) < POS_TOL
                and abs(o["y_pct"] - e["y_pct"]) < POS_TOL
            )
            matched.append(Match(label=str(e["label"]), iou=score, pos_ok=pos_ok))
    # By expected INDEX so two same-label entities (e.g. two "tree") don't mask a
    # genuinely missing one.
    missing = [str(e["label"]) for ei, e in enumerate(expected) if ei not in matched_exp]
    extra = [str(o.get("label", "?")) for j, o in enumerate(observed) if j not in used]
    n_exp = len(expected) or 1
    presence = len(matched) / n_exp
    mean_iou = sum(m.iou for m in matched) / len(matched) if matched else 0.0
    pos_agree = sum(1 for m in matched if m.pos_ok) / len(matched) if matched else 0.0
    score = 0.5 * presence + 0.3 * mean_iou + 0.2 * pos_agree
    # Penalize unexpected detections — the layout is the spec, so a clean match plus
    # a hallucinated extra object must not score a perfect 1.0 (codex-audit #6).
    if matched or extra:
        score *= 1.0 - 0.5 * (len(extra) / (len(matched) + len(extra)))
    return GroundingReport(
        matched=matched, missing=missing, extra=extra, score=score, mean_iou=mean_iou
    )


@dataclass(frozen=True)
class Budget:
    max_iters: int = 2  # safety cap on loop passes
    inpaint_budget: int = 1  # how many repair (inpaint) calls are allowed


@dataclass
class LoopResult[ImageT]:
    image: ImageT
    report: GroundingReport
    iterations: int = 0
    repairs: int = 0
    history: list[float] = field(default_factory=list)


def _actionable(report: GroundingReport) -> bool:
    """Is there anything a repair could fix?"""
    return bool(report.missing) or any(not m.pos_ok for m in report.matched)


async def run_grounding_loop[ImageT](
    initial_image: ImageT,
    *,
    verify: Callable[[ImageT], Awaitable[GroundingReport]],
    repair: Callable[[ImageT, GroundingReport], Awaitable[ImageT | None]],
    accept_threshold: float = 0.7,
    budget: Budget = Budget(),
) -> LoopResult[ImageT]:
    """Bounded verify→repair. Stops at the accept threshold, the iter/inpaint
    budget, when nothing is actionable, or when a repair fails to improve — and
    always returns the BEST-scoring image seen, never merely the last."""
    best_image = initial_image
    best_report = await verify(initial_image)
    res = LoopResult(image=best_image, report=best_report, history=[best_report.score])
    while True:
        if best_report.score >= accept_threshold:
            break
        if res.iterations >= budget.max_iters or res.repairs >= budget.inpaint_budget:
            break
        if not _actionable(best_report):
            break
        res.iterations += 1
        res.repairs += 1
        new_image = await repair(best_image, best_report)
        if new_image is None:
            break
        new_report = await verify(new_image)
        res.history.append(new_report.score)
        if new_report.score <= best_report.score:
            break  # no improvement → keep the best so far
        best_image, best_report = new_image, new_report
    res.image, res.report = best_image, best_report
    return res
