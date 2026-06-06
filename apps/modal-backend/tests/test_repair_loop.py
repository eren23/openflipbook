"""P4 verify→repair loop gate (free): bounded control flow via mocked
verify/repair — stops at threshold, budget, no-improvement; returns the best."""
from __future__ import annotations

import pytest

from providers.grounding import (
    Budget,
    GroundingReport,
    Match,
    run_grounding_loop,
)


def _rep(score: float, missing=("a",)) -> GroundingReport:
    return GroundingReport(
        matched=[Match("a", score, score >= 0.5)] if not missing else [],
        missing=list(missing),
        extra=[],
        score=score,
        mean_iou=score,
    )


async def test_accepts_immediately_above_threshold() -> None:
    calls = {"repair": 0}

    async def verify(_img):
        return _rep(0.9, missing=())

    async def repair(_img, _rep):
        calls["repair"] += 1
        return "repaired"

    res = await run_grounding_loop("img0", verify=verify, repair=repair, accept_threshold=0.7)
    assert calls["repair"] == 0
    assert res.image == "img0" and res.iterations == 0


async def test_repairs_then_accepts_on_improvement() -> None:
    scores = iter([0.4, 0.85])

    async def verify(_img):
        return _rep(next(scores))

    async def repair(_img, _rep):
        return "img1"

    res = await run_grounding_loop(
        "img0", verify=verify, repair=repair, accept_threshold=0.7,
        budget=Budget(max_iters=3, inpaint_budget=3),
    )
    assert res.image == "img1" and res.repairs == 1
    assert res.report.score == pytest.approx(0.85)


async def test_stops_at_inpaint_budget() -> None:
    n = {"r": 0}

    async def verify(_img):
        return _rep(0.3 + 0.05 * n["r"])  # keeps improving so only budget stops it

    async def repair(_img, _rep):
        n["r"] += 1
        return f"img{n['r']}"

    res = await run_grounding_loop(
        "img0", verify=verify, repair=repair, accept_threshold=0.95,
        budget=Budget(max_iters=10, inpaint_budget=1),
    )
    assert res.repairs == 1


async def test_stops_at_max_iters_even_when_improving() -> None:
    scores = iter([0.30, 0.50, 0.70, 0.80])

    async def verify(_img):
        return _rep(next(scores))

    async def repair(_img, _rep):
        return "x"

    res = await run_grounding_loop(
        "img0", verify=verify, repair=repair, accept_threshold=0.95,
        budget=Budget(max_iters=2, inpaint_budget=10),
    )
    assert res.iterations == 2
    assert res.report.score == pytest.approx(0.70)


async def test_stops_on_no_improvement_keeps_best() -> None:
    scores = iter([0.4, 0.4])

    async def verify(_img):
        return _rep(next(scores))

    async def repair(_img, _rep):
        return "img1"

    res = await run_grounding_loop(
        "img0", verify=verify, repair=repair, accept_threshold=0.9,
        budget=Budget(max_iters=5, inpaint_budget=5),
    )
    assert res.repairs == 1 and res.image == "img0"
    assert res.report.score == pytest.approx(0.4)


async def test_returns_best_image_not_last_on_regression() -> None:
    imgs = iter(["img1", "img2"])
    scores = iter([0.5, 0.8, 0.6])

    async def verify(_img):
        return _rep(next(scores))

    async def repair(_img, _rep):
        return next(imgs)

    res = await run_grounding_loop(
        "img0", verify=verify, repair=repair, accept_threshold=0.95,
        budget=Budget(max_iters=5, inpaint_budget=5),
    )
    assert res.image == "img1" and res.report.score == pytest.approx(0.8)
