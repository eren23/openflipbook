"""The render loop — a critic-guided retry for hard global render properties.

The "agent between two images": render an attempt, judge it against the
intended projection (and the source region for same-place identity), and on
rejection fold the judge's own rationale into the next attempt's instruction.
Prototype-proven on the steep view transforms (the one ~50% one-shot path):
attempt 1 = 3.0 conformance, feedback folded, attempt 2 = 10.0, accepted.

Design rules (the consensus shape):
  - GLOBAL failures (projection/identity) are REGENERATED — never patched.
    The local stage (entity placement) stays the existing bounded grounding
    repair, which runs downstream on the accepted image.
  - Keep-best: a retry can never make the result worse.
  - No critic, no loop: a judge failure degrades to single-attempt (today's
    behavior) instead of blind re-rolls.
  - Spend and wall-clock are capped (max attempts; no retry after a slow
    attempt — gpt edit attempts measured ~170s).

Dependency-injected (render + judges are callables) so the whole control flow
is free-unit-testable; an async GENERATOR so the SSE stream can emit each
rejected attempt as a progress frame between iterations.
"""
from __future__ import annotations

import asyncio
import base64
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from providers.judge import JudgeResult
from providers.prompt_library.feedback import retry_feedback_clause


class Rendered(Protocol):
    jpeg_bytes: bytes


@dataclass(frozen=True)
class LoopConfig:
    max_attempts: int = 2
    accept_conformance: float = 7.0
    accept_same_place: float = 6.0
    # The richness floor (only when a detail judge is wired): a retry that
    # fixes the camera but seals the place's interior must not be accepted.
    accept_detail: float = 6.0
    # The medium floor (only when a medium judge is wired): the text medium
    # lock is advisory to loose-ref models (nano treats refs as inspiration —
    # the Ankh-Morpork demo drift), so the ART MEDIUM gets a runtime gate too.
    accept_medium: float = 6.0
    # No retry when the previous attempt took longer than this (<=0 disables).
    retry_budget_s: float = 240.0


def loop_config_from_env() -> LoopConfig:
    def _f(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, ""))
        except ValueError:
            return default

    try:
        attempts = int(os.environ.get("VIEW_LOOP_MAX_ATTEMPTS", ""))
    except ValueError:
        attempts = 2
    return LoopConfig(
        max_attempts=max(1, attempts),
        accept_conformance=_f("VIEW_LOOP_ACCEPT_CONFORMANCE", 7.0),
        accept_same_place=_f("VIEW_LOOP_ACCEPT_SAME_PLACE", 6.0),
        accept_detail=_f("VIEW_LOOP_ACCEPT_DETAIL", 6.0),
        accept_medium=_f("VIEW_LOOP_ACCEPT_MEDIUM", 6.0),
        retry_budget_s=_f("VIEW_LOOP_RETRY_BUDGET_S", 240.0),
    )


@dataclass(frozen=True)
class Attempt:
    index: int  # 0-based
    image: Rendered
    instruction_suffix: str  # "" on attempt 0; the folded feedback after
    conformance: JudgeResult | None  # None = judge unavailable (degraded)
    same_place: JudgeResult | None  # None = no region bytes, or degraded
    detail: JudgeResult | None  # None = no detail judge wired
    medium: JudgeResult | None  # None = no medium judge wired / no reference
    accepted: bool
    latency_s: float


@dataclass(frozen=True)
class LoopResult:
    image: Rendered  # the best attempt's image (keep-best)
    attempts: list[Attempt]
    accepted: bool


def data_url_bytes(url: str | None) -> bytes | None:
    """Decode a data: URL to bytes; http(s)/garbage -> None (the judge needs
    raw bytes; remote refs aren't worth a fetch on the hot path)."""
    if not url or not url.startswith("data:") or "," not in url:
        return None
    try:
        return base64.b64decode(url.split(",", 1)[1])
    except Exception:
        return None


def _score(j: JudgeResult | None) -> float:
    return j.score if j is not None else -1.0


async def _no_judge() -> None:
    """Placeholder for a judge axis that isn't applicable this attempt —
    keeps the gathered result shape positional."""
    return None


async def judge_concurrently(
    *coros: Awaitable[JudgeResult | None],
) -> tuple[list[JudgeResult | None], Exception | None]:
    """Run independent judge calls concurrently — each is a 2-5s VLM
    round-trip, and run back-to-back they dominated an attempt's wall-clock.
    Returns (results, first_failure) with failed slots as None; cancellation
    propagates exactly as it would from a bare await."""
    gathered = await asyncio.gather(*coros, return_exceptions=True)
    for r in gathered:
        if isinstance(r, BaseException) and not isinstance(r, Exception):
            raise r
    results = [None if isinstance(r, BaseException) else r for r in gathered]
    failure = next((r for r in gathered if isinstance(r, Exception)), None)
    return results, failure


def _is_accepted(
    conformance: JudgeResult | None,
    same_place: JudgeResult | None,
    detail: JudgeResult | None,
    medium: JudgeResult | None,
    config: LoopConfig,
) -> bool:
    if conformance is None:
        return False  # no critic signal — never "accepted", but also no retry
    if conformance.score < config.accept_conformance:
        return False
    if same_place is not None and same_place.score < config.accept_same_place:
        return False
    if medium is not None and medium.score < config.accept_medium:
        return False
    return not (detail is not None and detail.score < config.accept_detail)


async def iter_attempts[ImageT: Rendered](
    render: Callable[[str], Awaitable[ImageT]],
    *,
    projection: str,
    region_bytes: bytes | None,
    judge_conformance: Callable[[bytes, str], Awaitable[JudgeResult]],
    judge_same_place: Callable[[bytes, bytes], Awaitable[JudgeResult]],
    config: LoopConfig,
    judge_detail: Callable[[bytes], Awaitable[JudgeResult]] | None = None,
    judge_medium: Callable[[bytes, bytes], Awaitable[JudgeResult]] | None = None,
    family: str | None = None,
    feedback: Callable[..., str] = retry_feedback_clause,
    abort: Callable[[str], Awaitable[None]] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> AsyncIterator[Attempt]:
    """Yield attempts until acceptance / budget / max attempts. The caller
    (the SSE generator) can emit a progress frame between yields. Attempt-0
    render exceptions PROPAGATE (the legacy error path); retry-render
    exceptions stop the loop quietly (keep best so far)."""
    from obs import log

    suffix = ""
    for index in range(config.max_attempts):
        if abort is not None:
            await abort("view-loop-render")
        started = clock()
        if index == 0:
            image = await render(suffix)
        else:
            try:
                image = await render(suffix)
            except Exception as exc:
                log(
                    "warn",
                    "view.loop.render_failed",
                    attempt=index,
                    error=f"{type(exc).__name__}: {exc}",
                )
                return
        latency = clock() - started

        # The four axes are independent verdicts on the same image — judged
        # concurrently (the Ankh-Morpork re-shoot: sequential judging alone
        # cost 10-20s per attempt).
        judged, failure = await judge_concurrently(
            judge_conformance(image.jpeg_bytes, projection),
            (
                judge_same_place(region_bytes, image.jpeg_bytes)
                if region_bytes is not None
                else _no_judge()
            ),
            judge_detail(image.jpeg_bytes) if judge_detail is not None else _no_judge(),
            (
                judge_medium(region_bytes, image.jpeg_bytes)
                if judge_medium is not None and region_bytes is not None
                else _no_judge()
            ),
        )
        conformance, same_place, detail, medium = judged
        if failure is not None:
            log(
                "warn",
                "view.loop.judge_failed",
                attempt=index,
                error=f"{type(failure).__name__}: {failure}",
            )
            # No critic signal = the old blind coin-flip — don't spend more.
            yield Attempt(
                index, image, suffix, conformance, same_place, detail, medium, False, latency
            )
            return

        accepted = _is_accepted(conformance, same_place, detail, medium, config)
        log(
            "info",
            "view.loop",
            attempt=index,
            projection=projection,
            conformance=_score(conformance),
            same_place=_score(same_place),
            detail=_score(detail),
            medium=_score(medium),
            accepted=accepted,
            latency_s=round(latency, 1),
        )
        yield Attempt(
            index, image, suffix, conformance, same_place, detail, medium, accepted, latency
        )
        if accepted:
            return
        if config.retry_budget_s > 0 and latency > config.retry_budget_s:
            log("info", "view.loop.budget_stop", attempt=index, latency_s=round(latency, 1))
            return
        suffix = feedback(
            projection,
            conformance_rationale=(
                conformance.rationale
                if conformance is not None
                and conformance.score < config.accept_conformance
                else None
            ),
            same_place_rationale=(
                same_place.rationale
                if same_place is not None
                and same_place.score < config.accept_same_place
                else None
            ),
            detail_rationale=(
                detail.rationale
                if detail is not None and detail.score < config.accept_detail
                else None
            ),
            medium_rationale=(
                medium.rationale
                if medium is not None and medium.score < config.accept_medium
                else None
            ),
            family=family,
        )


def conclude(attempts: list[Attempt]) -> LoopResult:
    """Keep-best: the first accepted attempt wins; otherwise the best-scoring
    one, with STRICT improvement required to displace an earlier attempt (a
    retry can never make the result worse)."""
    if not attempts:
        raise ValueError("conclude() needs at least one attempt")
    for a in attempts:
        if a.accepted:
            return LoopResult(image=a.image, attempts=attempts, accepted=True)
    best = attempts[0]
    for a in attempts[1:]:
        if (
            _score(a.conformance),
            _score(a.same_place),
            _score(a.medium),
            _score(a.detail),
        ) > (
            _score(best.conformance),
            _score(best.same_place),
            _score(best.medium),
            _score(best.detail),
        ):
            best = a
    return LoopResult(image=best.image, attempts=attempts, accepted=False)


async def run_view_loop[ImageT: Rendered](
    render: Callable[[str], Awaitable[ImageT]],
    *,
    projection: str,
    region_bytes: bytes | None,
    judge_conformance: Callable[[bytes, str], Awaitable[JudgeResult]],
    judge_same_place: Callable[[bytes, bytes], Awaitable[JudgeResult]],
    config: LoopConfig | None = None,
    judge_detail: Callable[[bytes], Awaitable[JudgeResult]] | None = None,
    judge_medium: Callable[[bytes, bytes], Awaitable[JudgeResult]] | None = None,
    family: str | None = None,
) -> LoopResult:
    """Drain the loop for non-streaming callers (the bench)."""
    attempts: list[Attempt] = []
    async for attempt in iter_attempts(
        render,
        projection=projection,
        region_bytes=region_bytes,
        judge_conformance=judge_conformance,
        judge_same_place=judge_same_place,
        config=config or loop_config_from_env(),
        judge_detail=judge_detail,
        judge_medium=judge_medium,
        family=family,
    ):
        attempts.append(attempt)
    return conclude(attempts)
