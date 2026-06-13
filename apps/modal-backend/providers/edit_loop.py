"""The edit loop — mask-scoped edits judged by construction.

The render loop's sibling (same DI shape, keep-best, degrade-on-judge-failure
rules — see render_loop.py's design notes) with the axes an EDIT needs
instead of a steep view transform:

  - outside_change: providers.pixel_diff.changed_fraction OUTSIDE the mask —
    a FREE computed hard gate. Masks promise that the rest of the page
    survives; assert it with pixels, no VLM needed.
  - alignment: score_prompt_alignment on the INSIDE crop — did the asked
    change land, judged where it happened rather than diluted across the
    whole frame.
  - medium: score_style_pair(source, result) — the edit can't drift the
    world's art medium.

One retry max by default; rejected attempts fold the critics' rationales
into the next fill description (edit_retry_feedback_clause); every attempt
logged under "edit.loop". A judge failure degrades to single-attempt rather
than blind re-rolls; an outside-gate breach alone still retries (the
feedback names it) but pixel-diff itself failing stops the loop.

mask_png=None is the WHOLE-IMAGE judged edit (E3): no confinement promise to
assert, so the outside gate is simply not applicable — acceptance rides on
alignment + medium alone and outside_change stays None throughout.
"""
from __future__ import annotations

import io
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from PIL import Image

from providers.judge import JudgeResult
from providers.pixel_diff import changed_fraction
from providers.prompt_library.feedback import edit_retry_feedback_clause
from providers.render_loop import (
    MAX_ATTEMPTS_CAP,
    Rendered,
    _env_float,
    _score,
    judge_concurrently,
)


@dataclass(frozen=True)
class EditLoopConfig:
    max_attempts: int = 2
    accept_alignment: float = 7.0
    accept_medium: float = 6.0
    # The mask smoke's numbers: fill measured 0.0000 outside; gpt's whole-
    # canvas churn floor was 0.089 — 0.02 cleanly separates the worlds.
    outside_change_max: float = 0.02
    # No retry when the previous attempt took longer than this (<=0 disables).
    retry_budget_s: float = 240.0


def edit_loop_config_from_env(max_attempts: int | None = None) -> EditLoopConfig:
    try:
        attempts = int(os.environ.get("EDIT_LOOP_MAX_ATTEMPTS", ""))
    except ValueError:
        attempts = 2
    if max_attempts is not None:
        attempts = min(MAX_ATTEMPTS_CAP, max_attempts)
    return EditLoopConfig(
        max_attempts=max(1, attempts),
        accept_alignment=_env_float("EDIT_LOOP_ACCEPT_ALIGNMENT", 7.0),
        accept_medium=_env_float("EDIT_LOOP_ACCEPT_MEDIUM", 6.0),
        outside_change_max=_env_float("EDIT_LOOP_OUTSIDE_MAX", 0.02),
        retry_budget_s=_env_float("EDIT_LOOP_RETRY_BUDGET_S", 240.0),
    )


@dataclass(frozen=True)
class EditAttempt:
    index: int  # 0-based
    image: Rendered
    instruction_suffix: str  # "" on attempt 0; the folded feedback after
    outside_change: float | None  # None = pixel diff unavailable (degraded)
    alignment: JudgeResult | None  # None = judge unavailable (degraded)
    medium: JudgeResult | None
    accepted: bool
    latency_s: float


@dataclass(frozen=True)
class EditLoopResult:
    image: Rendered  # the best attempt's image (keep-best)
    best: EditAttempt  # ...and the attempt it came from (the verdict's numbers)
    attempts: list[EditAttempt]
    accepted: bool


def inside_crop_bytes(
    image_bytes: bytes, region_box: tuple[float, float, float, float] | None
) -> bytes:
    """Crop the selection (normalized x, y, w, h) out of `image_bytes` for the
    alignment judge. No box / a degenerate box / a decode failure -> the full
    frame (judging diluted beats not judging)."""
    if region_box is None:
        return image_bytes
    try:
        im = Image.open(io.BytesIO(image_bytes))
        width, height = im.size
        x, y, w, h = region_box
        left = max(0, min(width - 1, round(x * width)))
        top = max(0, min(height - 1, round(y * height)))
        right = max(left + 1, min(width, round((x + w) * width)))
        bottom = max(top + 1, min(height, round((y + h) * height)))
        if right - left < 8 or bottom - top < 8:
            return image_bytes
        buf = io.BytesIO()
        im.crop((left, top, right, bottom)).convert("RGB").save(
            buf, "JPEG", quality=92
        )
        return buf.getvalue()
    except Exception:
        return image_bytes


def _outside_key(outside: float | None) -> float:
    # Lower outside change is better; unknown ranks worst.
    return -(outside if outside is not None else 1.0)


def _is_accepted(
    outside: float | None,
    alignment: JudgeResult | None,
    medium: JudgeResult | None,
    config: EditLoopConfig,
) -> bool:
    if alignment is None:
        return False  # no critic signal — never "accepted", but also no retry
    # outside=None means the gate isn't applicable (whole-image edit, no
    # mask); a FAILED diff never reaches here (the loop stops first).
    if outside is not None and outside > config.outside_change_max:
        return False
    if alignment.score < config.accept_alignment:
        return False
    return not (medium is not None and medium.score < config.accept_medium)


async def iter_edit_attempts[ImageT: Rendered](
    render: Callable[[str], Awaitable[ImageT]],
    *,
    source_bytes: bytes,
    mask_png: bytes | None,
    region_box: tuple[float, float, float, float] | None,
    judge_alignment: Callable[[str, bytes], Awaitable[JudgeResult]],
    judge_medium: Callable[[bytes, bytes], Awaitable[JudgeResult]],
    instruction: str,
    config: EditLoopConfig,
    feedback: Callable[..., str] = edit_retry_feedback_clause,
    abort: Callable[[str], Awaitable[None]] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> AsyncIterator[EditAttempt]:
    """Yield attempts until acceptance / budget / max attempts. Attempt-0
    render exceptions PROPAGATE (the caller's error path); retry-render
    exceptions stop the loop quietly (keep best so far)."""
    from obs import log

    suffix = ""
    for index in range(config.max_attempts):
        if abort is not None:
            await abort("edit-loop-render")
        started = clock()
        if index == 0:
            image = await render(suffix)
        else:
            try:
                image = await render(suffix)
            except Exception as exc:
                log(
                    "warn",
                    "edit.loop.render_failed",
                    attempt=index,
                    error=f"{type(exc).__name__}: {exc}",
                )
                return
        latency = clock() - started

        outside: float | None = None
        alignment: JudgeResult | None = None
        medium: JudgeResult | None = None
        if mask_png is not None:
            try:
                outside = changed_fraction(
                    source_bytes, image.jpeg_bytes, mask_png, invert_mask=True
                )
            except Exception as exc:
                log(
                    "warn",
                    "edit.loop.diff_failed",
                    attempt=index,
                    error=f"{type(exc).__name__}: {exc}",
                )
                yield EditAttempt(index, image, suffix, None, None, None, False, latency)
                return
        # Both critics look at the same result independently — judged
        # concurrently (see render_loop.judge_concurrently).
        judged, failure = await judge_concurrently(
            judge_alignment(
                instruction, inside_crop_bytes(image.jpeg_bytes, region_box)
            ),
            judge_medium(source_bytes, image.jpeg_bytes),
        )
        alignment, medium = judged
        if failure is not None:
            log(
                "warn",
                "edit.loop.judge_failed",
                attempt=index,
                error=f"{type(failure).__name__}: {failure}",
            )
            # No critic signal = the old blind coin-flip — don't spend more.
            yield EditAttempt(index, image, suffix, outside, alignment, medium, False, latency)
            return

        accepted = _is_accepted(outside, alignment, medium, config)
        log(
            "info",
            "edit.loop",
            attempt=index,
            outside_change=round(outside, 4) if outside is not None else None,
            alignment=_score(alignment),
            medium=_score(medium),
            accepted=accepted,
            latency_s=round(latency, 1),
        )
        yield EditAttempt(index, image, suffix, outside, alignment, medium, accepted, latency)
        if accepted:
            return
        if config.retry_budget_s > 0 and latency > config.retry_budget_s:
            log("info", "edit.loop.budget_stop", attempt=index, latency_s=round(latency, 1))
            return
        suffix = feedback(
            alignment_rationale=(
                alignment.rationale
                if alignment is not None and alignment.score < config.accept_alignment
                else None
            ),
            medium_rationale=(
                medium.rationale
                if medium is not None and medium.score < config.accept_medium
                else None
            ),
            outside_exceeded=outside is not None and outside > config.outside_change_max,
        )


def conclude_edit(attempts: list[EditAttempt]) -> EditLoopResult:
    """Keep-best: the first accepted attempt wins; otherwise the best-scoring
    one, with STRICT improvement required to displace an earlier attempt (a
    retry can never make the result worse)."""
    if not attempts:
        raise ValueError("conclude_edit() needs at least one attempt")
    for a in attempts:
        if a.accepted:
            return EditLoopResult(image=a.image, best=a, attempts=attempts, accepted=True)
    best = attempts[0]
    for a in attempts[1:]:
        if (_score(a.alignment), _score(a.medium), _outside_key(a.outside_change)) > (
            _score(best.alignment),
            _score(best.medium),
            _outside_key(best.outside_change),
        ):
            best = a
    return EditLoopResult(image=best.image, best=best, attempts=attempts, accepted=False)


async def run_edit_loop[ImageT: Rendered](
    render: Callable[[str], Awaitable[ImageT]],
    *,
    source_bytes: bytes,
    mask_png: bytes | None,
    region_box: tuple[float, float, float, float] | None,
    judge_alignment: Callable[[str, bytes], Awaitable[JudgeResult]],
    judge_medium: Callable[[bytes, bytes], Awaitable[JudgeResult]],
    instruction: str,
    config: EditLoopConfig | None = None,
) -> EditLoopResult:
    """Drain the loop for non-streaming callers (the bench)."""
    attempts: list[EditAttempt] = []
    async for attempt in iter_edit_attempts(
        render,
        source_bytes=source_bytes,
        mask_png=mask_png,
        region_box=region_box,
        judge_alignment=judge_alignment,
        judge_medium=judge_medium,
        instruction=instruction,
        config=config or edit_loop_config_from_env(),
    ):
        attempts.append(attempt)
    return conclude_edit(attempts)
