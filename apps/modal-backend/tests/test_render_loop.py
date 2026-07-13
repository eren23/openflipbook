"""The render loop's control-flow contract — all free (injected callables).

Every rule the consensus design pins: accept-fast, feedback folding,
keep-best (a retry can never make it worse), the same-place gate, degraded
single-attempt on judge failure, the wall-clock retry budget.
"""
from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest

from providers.judge import JudgeResult
from providers.render_loop import (
    Attempt,
    LoopConfig,
    conclude,
    data_url_bytes,
    iter_attempts,
    loop_config_from_env,
    run_view_loop,
)


@dataclass
class _Img:
    jpeg_bytes: bytes


def _j(score: float, rationale: str = "") -> JudgeResult:
    return JudgeResult(score=score, rationale=rationale, raw="")


def _cfg(**over: object) -> LoopConfig:
    base = {"max_attempts": 2, "accept_conformance": 7.0,
            "accept_same_place": 6.0, "retry_budget_s": 240.0}
    base.update(over)
    return LoopConfig(**base)  # type: ignore[arg-type]


async def _drain(**kwargs: object) -> list[Attempt]:
    out: list[Attempt] = []
    async for a in iter_attempts(**kwargs):  # type: ignore[arg-type]
        out.append(a)
    return out


async def test_accept_fast_one_render_no_retry() -> None:
    render = AsyncMock(return_value=_Img(b"a"))
    conf = AsyncMock(return_value=_j(9.0))
    same = AsyncMock(return_value=_j(9.0))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert len(attempts) == 1 and attempts[0].accepted
    render.assert_awaited_once()
    assert conclude(attempts).accepted is True


async def test_feedback_folds_rationale_and_register() -> None:
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    conf = AsyncMock(side_effect=[_j(3.0, "looks oblique"), _j(10.0)])
    same = AsyncMock(return_value=_j(9.0))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert len(attempts) == 2 and attempts[1].accepted
    suffix = render.await_args_list[1].args[0]
    assert "looks oblique" in suffix  # the critic's diagnosis
    assert "plan view" in suffix  # the register reminder
    assert attempts[1].instruction_suffix == suffix


async def test_max_attempts_keep_best() -> None:
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    conf = AsyncMock(side_effect=[_j(4.0), _j(6.0)])
    same = AsyncMock(return_value=_j(9.0))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    result = conclude(attempts)
    assert len(attempts) == 2 and result.accepted is False
    assert result.image.jpeg_bytes == b"b"  # 6.0 beats 4.0


async def test_keep_best_on_regression() -> None:
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    conf = AsyncMock(side_effect=[_j(6.0), _j(4.0)])
    same = AsyncMock(return_value=_j(9.0))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert conclude(attempts).image.jpeg_bytes == b"a"  # the retry never wins by tying


async def test_same_place_gate_drives_retry_and_feedback() -> None:
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    conf = AsyncMock(return_value=_j(9.0))
    same = AsyncMock(side_effect=[_j(3.0, "different towers"), _j(8.0)])
    attempts = await _drain(
        render=render, projection="eye_level", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert len(attempts) == 2 and attempts[1].accepted
    suffix = render.await_args_list[1].args[0]
    assert "different towers" in suffix and "SAME place" in suffix
    assert "failed the projection check" not in suffix  # conformance passed


async def test_no_region_skips_same_place_judge() -> None:
    render = AsyncMock(return_value=_Img(b"a"))
    conf = AsyncMock(return_value=_j(9.0))
    same = AsyncMock()
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=None,
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert attempts[0].accepted and attempts[0].same_place is None
    same.assert_not_awaited()


async def test_judge_failure_degrades_to_single_attempt() -> None:
    render = AsyncMock(return_value=_Img(b"a"))
    conf = AsyncMock(side_effect=RuntimeError("no key"))
    same = AsyncMock()
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert len(attempts) == 1 and attempts[0].conformance is None
    render.assert_awaited_once()  # no blind re-roll without a critic
    result = conclude(attempts)
    assert result.image.jpeg_bytes == b"a" and result.accepted is False


async def test_retry_render_failure_keeps_best() -> None:
    render = AsyncMock(side_effect=[_Img(b"a"), RuntimeError("fal 422")])
    conf = AsyncMock(return_value=_j(4.0))
    same = AsyncMock(return_value=_j(9.0))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert len(attempts) == 1
    assert conclude(attempts).image.jpeg_bytes == b"a"


async def test_attempt_zero_render_failure_propagates() -> None:
    render = AsyncMock(side_effect=RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        await _drain(
            render=render, projection="top_down", region_bytes=None,
            judge_conformance=AsyncMock(), judge_same_place=AsyncMock(),
            config=_cfg(),
        )


async def test_retry_budget_guard() -> None:
    ticks = iter([0.0, 400.0, 400.0, 401.0, 401.0, 402.0])
    render = AsyncMock(return_value=_Img(b"a"))
    conf = AsyncMock(return_value=_j(3.0))
    same = AsyncMock(return_value=_j(9.0))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same,
        config=_cfg(retry_budget_s=240.0), clock=lambda: next(ticks),
    )
    assert len(attempts) == 1  # 400s attempt: rejected but NOT retried
    # budget <= 0 disables the guard
    ticks2 = iter([0.0, 400.0, 400.0, 401.0])
    render2 = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    attempts2 = await _drain(
        render=render2, projection="top_down", region_bytes=b"r",
        judge_conformance=AsyncMock(side_effect=[_j(3.0), _j(9.0)]),
        judge_same_place=AsyncMock(return_value=_j(9.0)),
        config=_cfg(retry_budget_s=0.0), clock=lambda: next(ticks2),
    )
    assert len(attempts2) == 2


async def test_cumulative_deadline_stops_retry() -> None:
    # Attempt 0 takes 100s (render+judges); predicting another 100s attempt
    # would land at 200 > deadline 150 — stop with keep-best, no retry.
    ticks = iter([0.0, 100.0, 100.0])
    render = AsyncMock(return_value=_Img(b"a"))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=AsyncMock(return_value=_j(3.0)),
        judge_same_place=AsyncMock(return_value=_j(9.0)),
        config=_cfg(retry_budget_s=0.0), clock=lambda: next(ticks),
        deadline_s=150.0,
    )
    assert len(attempts) == 1
    render.assert_awaited_once()
    assert conclude(attempts).image.jpeg_bytes == b"a"
    # A far deadline lets the retry proceed.
    ticks2 = iter([0.0, 100.0, 100.0, 101.0, 101.0])
    render2 = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    attempts2 = await _drain(
        render=render2, projection="top_down", region_bytes=b"r",
        judge_conformance=AsyncMock(side_effect=[_j(3.0), _j(9.0)]),
        judge_same_place=AsyncMock(return_value=_j(9.0)),
        config=_cfg(retry_budget_s=0.0), clock=lambda: next(ticks2),
        deadline_s=10_000.0,
    )
    assert len(attempts2) == 2


def test_data_url_bytes() -> None:
    import base64

    raw = b"JPEGDATA"
    url = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    assert data_url_bytes(url) == raw
    assert data_url_bytes("http://cdn/x.jpg") is None
    assert data_url_bytes("garbage") is None
    assert data_url_bytes(None) is None


def test_loop_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = loop_config_from_env()
    assert cfg == LoopConfig()
    monkeypatch.setenv("VIEW_LOOP_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("VIEW_LOOP_ACCEPT_CONFORMANCE", "8")
    monkeypatch.setenv("VIEW_LOOP_RETRY_BUDGET_S", "0")
    cfg2 = loop_config_from_env()
    assert cfg2.max_attempts == 3
    assert cfg2.accept_conformance == 8.0
    assert cfg2.retry_budget_s == 0.0


def test_loop_config_per_request_attempts_clamped() -> None:
    # The speed preset's per-request ask beats the env default, inside
    # [1, MAX_ATTEMPTS_CAP] — never an unbounded spend.
    assert loop_config_from_env(max_attempts=1).max_attempts == 1
    assert loop_config_from_env(max_attempts=3).max_attempts == 3
    assert loop_config_from_env(max_attempts=99).max_attempts == 4
    assert loop_config_from_env(max_attempts=0).max_attempts == 1
    assert loop_config_from_env(max_attempts=None).max_attempts == 2  # env default


async def test_run_view_loop_drains_and_concludes() -> None:
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    result = await run_view_loop(
        render,
        projection="top_down",
        region_bytes=b"r",
        judge_conformance=AsyncMock(side_effect=[_j(3.0, "x"), _j(9.0)]),
        judge_same_place=AsyncMock(return_value=_j(9.0)),
        config=_cfg(),
    )
    assert result.accepted is True and result.image.jpeg_bytes == b"b"
    assert len(result.attempts) == 2


async def test_detail_axis_rejects_and_feeds_back() -> None:
    # The critic-gap fix: a retry that fixes the camera but seals the interior
    # is rejected; the feedback names the richness loss.
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    conf = AsyncMock(return_value=_j(9.0))
    same = AsyncMock(return_value=_j(9.0))
    detail = AsyncMock(side_effect=[_j(3.0, "courtyard sealed under a roof"), _j(8.0)])
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, judge_detail=detail,
        config=_cfg(),
    )
    assert len(attempts) == 2 and attempts[1].accepted
    suffix = render.await_args_list[1].args[0]
    assert "courtyard sealed under a roof" in suffix
    assert "lost interior richness" in suffix
    assert "open courtyards stay open" in suffix.lower()


async def test_no_detail_judge_ignores_the_axis() -> None:
    render = AsyncMock(return_value=_Img(b"a"))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=AsyncMock(return_value=_j(9.0)),
        config=_cfg(),
    )
    assert attempts[0].accepted and attempts[0].detail is None
    assert attempts[0].medium is None  # no medium judge wired either


async def test_medium_axis_rejects_and_feeds_back() -> None:
    # The Ankh-Morpork drift fix: camera + place fine, MEDIUM drifted — the
    # medium critic alone rejects, and its diagnosis rides the retry.
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    conf = AsyncMock(return_value=_j(9.0))
    same = AsyncMock(return_value=_j(9.0))
    medium = AsyncMock(side_effect=[_j(2.0, "ink wash became photoreal"), _j(8.5)])
    attempts = await _drain(
        render=render, projection="oblique", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, judge_medium=medium,
        config=_cfg(),
    )
    assert len(attempts) == 2 and attempts[1].accepted
    assert not attempts[0].accepted
    suffix = render.await_args_list[1].args[0]
    assert "ink wash became photoreal" in suffix
    assert "ART MEDIUM" in suffix
    assert "same hand" in suffix


async def test_judges_run_concurrently() -> None:
    # The demo latency fix: the four verdicts are independent VLM calls and
    # must overlap. Conformance blocks until same_place STARTS — sequential
    # execution times out (degraded, unaccepted) instead of passing.
    import asyncio

    started = asyncio.Event()

    async def conf(_img: bytes, _proj: str) -> JudgeResult:
        await asyncio.wait_for(started.wait(), timeout=2.0)
        return _j(9.0)

    async def same(_region: bytes, _img: bytes) -> JudgeResult:
        started.set()
        return _j(9.0)

    attempts = await _drain(
        render=AsyncMock(return_value=_Img(b"a")), projection="top_down",
        region_bytes=b"r", judge_conformance=conf, judge_same_place=same,
        config=_cfg(),
    )
    assert len(attempts) == 1 and attempts[0].accepted


async def test_sibling_judge_failure_still_degrades() -> None:
    # A failure in ANY concurrent judge keeps the no-critic rule: one attempt,
    # never accepted, the surviving verdicts retained.
    render = AsyncMock(return_value=_Img(b"a"))
    conf = AsyncMock(return_value=_j(9.0))
    same = AsyncMock(side_effect=RuntimeError("429"))
    attempts = await _drain(
        render=render, projection="top_down", region_bytes=b"r",
        judge_conformance=conf, judge_same_place=same, config=_cfg(),
    )
    assert len(attempts) == 1 and not attempts[0].accepted
    assert attempts[0].conformance is not None  # the survivor kept
    assert attempts[0].same_place is None  # the failed slot degraded
    render.assert_awaited_once()


async def test_medium_judge_needs_region_bytes() -> None:
    # No reference crop -> nothing to compare the medium against; the axis
    # stays None and never gates.
    render = AsyncMock(return_value=_Img(b"a"))
    medium = AsyncMock(return_value=_j(0.0, "never called"))
    attempts = await _drain(
        render=render, projection="oblique", region_bytes=None,
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=AsyncMock(return_value=_j(9.0)),
        judge_medium=medium,
        config=_cfg(),
    )
    assert attempts[0].accepted and attempts[0].medium is None
    medium.assert_not_awaited()


# ---------- the interior axis (INTERIOR_ENTERS) -------------------------------


async def test_interior_axis_rejects_and_feeds_back() -> None:
    # An interior enter that arrives OUTDOORS is rejected; the retry carries
    # the judge's diagnosis + the indoor directive.
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    interior = AsyncMock(side_effect=[_j(1.0, "it is the facade again"), _j(8.0)])
    attempts = await _drain(
        render=render, projection="eye_level", region_bytes=b"r",
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=None,  # the swap: interior replaces same-place
        judge_interior=interior,
        config=_cfg(accept_interior=6.0),
    )
    assert len(attempts) == 2 and attempts[1].accepted
    assert not attempts[0].accepted
    assert attempts[0].same_place is None  # the disabled axis stays None
    suffix = render.await_args_list[1].args[0]
    assert "it is the facade again" in suffix
    assert "failed the interior check" in suffix
    assert "INSIDE the building" in suffix


async def test_interior_axis_pass_accepts_single_attempt() -> None:
    render = AsyncMock(return_value=_Img(b"a"))
    interior = AsyncMock(return_value=_j(8.5))
    attempts = await _drain(
        render=render, projection="eye_level", region_bytes=b"r",
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=None,
        judge_interior=interior,
        config=_cfg(accept_interior=6.0),
    )
    assert len(attempts) == 1 and attempts[0].accepted
    assert attempts[0].interior is not None and attempts[0].interior.score == 8.5
    render.assert_awaited_once()


async def test_same_place_none_skips_that_judge_entirely() -> None:
    # judge_same_place=None (the interior swap) must never call anything on
    # the same-place axis even with region bytes present.
    render = AsyncMock(return_value=_Img(b"a"))
    attempts = await _drain(
        render=render, projection="eye_level", region_bytes=b"r",
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=None,
        config=_cfg(),
    )
    assert attempts[0].accepted and attempts[0].same_place is None
    assert attempts[0].interior is None  # no interior judge wired either


async def test_interior_judge_needs_region_bytes() -> None:
    # Mirrors the medium axis: no reference bytes -> the axis stays None.
    interior = AsyncMock(return_value=_j(0.0, "never called"))
    attempts = await _drain(
        render=AsyncMock(return_value=_Img(b"a")), projection="eye_level",
        region_bytes=None,
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=None,
        judge_interior=interior,
        config=_cfg(),
    )
    assert attempts[0].accepted and attempts[0].interior is None
    interior.assert_not_awaited()


async def test_interior_keep_best_prefers_higher_interior_score() -> None:
    # Two rejected attempts tie on every axis except interior — the better
    # interior wins (the axis joins the keep-best ordering).
    render = AsyncMock(side_effect=[_Img(b"a"), _Img(b"b")])
    interior = AsyncMock(side_effect=[_j(2.0), _j(5.0)])  # both below 6.0
    attempts = await _drain(
        render=render, projection="eye_level", region_bytes=b"r",
        judge_conformance=AsyncMock(return_value=_j(9.0)),
        judge_same_place=None,
        judge_interior=interior,
        config=_cfg(accept_interior=6.0),
    )
    result = conclude(attempts)
    assert result.accepted is False
    assert result.image.jpeg_bytes == b"b"
