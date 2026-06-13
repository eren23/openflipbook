"""The edit loop's control flow (providers/edit_loop.py), judges mocked.

Mirrors tests/test_render_loop.py for the mask-scoped sibling: accept-at-one
spends nothing extra, a rejected attempt folds the critic's rationale into
the retry, the FREE outside-mask pixel gate alone forces a retry, keep-best
never lets a retry make things worse, and a judge failure degrades to
single-attempt instead of blind re-rolls. The pixel metric runs for real on
tiny synthetic frames — only the VLM judges are mocked.
"""
from __future__ import annotations

import io
from dataclasses import dataclass

import pytest
from PIL import Image, ImageDraw

from providers import edit_loop
from providers.judge import JudgeResult

pytestmark = pytest.mark.edit

_W, _H = 128, 72
_BOX = (0.5, 0.25, 0.375, 0.5)  # x,y,w,h normalized -> px (64,18)-(112,54)
_CFG = edit_loop.EditLoopConfig(retry_budget_s=0)  # disable wall-clock stop


def _jpg(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def _base() -> Image.Image:
    grad = Image.linear_gradient("L").resize((_W, _H))
    return Image.merge("RGB", (grad, grad, grad.point(lambda v: 255 - v)))


def _box_px(grow: int = 0) -> tuple[int, int, int, int]:
    x, y, w, h = _BOX
    return (
        round(x * _W) - grow,
        round(y * _H) - grow,
        round((x + w) * _W) + grow,
        round((y + h) * _H) + grow,
    )


def _mask_png() -> bytes:
    m = Image.new("L", (_W, _H), 0)
    ImageDraw.Draw(m).rectangle(_box_px(), fill=255)
    buf = io.BytesIO()
    m.save(buf, "PNG")
    return buf.getvalue()


def _inside_edit() -> bytes:
    im = _base()
    ImageDraw.Draw(im).rectangle(_box_px(), fill=(220, 40, 40))
    return _jpg(im)


def _outside_edit() -> bytes:
    im = _base()
    ImageDraw.Draw(im).rectangle((4, 4, 40, 30), fill=(220, 40, 40))
    return _jpg(im)


@dataclass
class _Img:
    jpeg_bytes: bytes


class _Render:
    """Recording render: returns scripted frames, keeps the suffixes seen."""

    def __init__(self, frames: list[bytes]) -> None:
        self.frames = frames
        self.suffixes: list[str] = []

    async def __call__(self, suffix: str) -> _Img:
        self.suffixes.append(suffix)
        return _Img(self.frames[len(self.suffixes) - 1])


def _judge(*scores: float, rationale: str = "") -> object:
    seq = [JudgeResult(s, rationale, "") for s in scores]

    async def judge(*_args: object) -> JudgeResult:
        return seq.pop(0) if len(seq) > 1 else seq[0]

    return judge


async def _drain(render: _Render, *, alignment: object, medium: object) -> list[edit_loop.EditAttempt]:
    attempts = []
    async for a in edit_loop.iter_edit_attempts(
        render,
        source_bytes=_jpg(_base()),
        mask_png=_mask_png(),
        region_box=_BOX,
        judge_alignment=alignment,  # type: ignore[arg-type]
        judge_medium=medium,  # type: ignore[arg-type]
        instruction="a red panel",
        config=_CFG,
    ):
        attempts.append(a)
    return attempts


async def test_accept_at_one_spends_one_render() -> None:
    render = _Render([_inside_edit()])
    attempts = await _drain(render, alignment=_judge(9.0), medium=_judge(9.0))
    assert len(attempts) == 1 and attempts[0].accepted
    assert render.suffixes == [""]
    assert attempts[0].outside_change == 0.0


async def test_reject_folds_rationale_into_retry() -> None:
    render = _Render([_inside_edit(), _inside_edit()])
    attempts = await _drain(
        render,
        alignment=_judge(3.0, 9.0, rationale="no red panel visible"),
        medium=_judge(9.0),
    )
    assert [a.accepted for a in attempts] == [False, True]
    assert "no red panel visible" in render.suffixes[1]
    assert "Render exactly what is described" in render.suffixes[1]


async def test_outside_gate_alone_forces_retry() -> None:
    # Judges love it (9/9) but pixels changed beyond the mask — rejected, and
    # the retry's feedback names the confinement breach.
    render = _Render([_outside_edit(), _inside_edit()])
    attempts = await _drain(render, alignment=_judge(9.0), medium=_judge(9.0))
    assert attempts[0].outside_change is not None
    assert attempts[0].outside_change > _CFG.outside_change_max
    assert [a.accepted for a in attempts] == [False, True]
    assert "Confine the edit STRICTLY" in render.suffixes[1]


async def test_keep_best_never_regresses() -> None:
    render = _Render([_inside_edit(), _inside_edit()])
    attempts = await _drain(
        render, alignment=_judge(5.0, 4.0), medium=_judge(9.0)
    )
    result = edit_loop.conclude_edit(attempts)
    assert not result.accepted
    assert result.best is attempts[0]  # strict improvement required


async def test_judge_failure_degrades_to_single_attempt() -> None:
    async def broken(*_args: object) -> JudgeResult:
        raise RuntimeError("judge down")

    render = _Render([_inside_edit(), _inside_edit()])
    attempts = await _drain(render, alignment=broken, medium=_judge(9.0))
    assert len(attempts) == 1
    assert not attempts[0].accepted
    assert attempts[0].alignment is None
    assert render.suffixes == [""]  # no blind retry


async def test_medium_floor_gates_acceptance() -> None:
    render = _Render([_inside_edit(), _inside_edit()])
    attempts = await _drain(
        render,
        alignment=_judge(9.0),
        medium=_judge(3.0, 9.0, rationale="photoreal patch on an engraving"),
    )
    assert [a.accepted for a in attempts] == [False, True]
    assert "photoreal patch on an engraving" in render.suffixes[1]


async def test_no_mask_skips_the_outside_gate() -> None:
    # Whole-image judged edit (E3): even a frame that changed EVERYWHERE is
    # acceptable when the judges pass — there was no confinement promise.
    render = _Render([_outside_edit()])
    attempts = []
    async for a in edit_loop.iter_edit_attempts(
        render,
        source_bytes=_jpg(_base()),
        mask_png=None,
        region_box=None,
        judge_alignment=_judge(9.0),  # type: ignore[arg-type]
        judge_medium=_judge(9.0),  # type: ignore[arg-type]
        instruction="a red panel",
        config=_CFG,
    ):
        attempts.append(a)
    assert len(attempts) == 1 and attempts[0].accepted
    assert attempts[0].outside_change is None


async def test_no_mask_still_gates_on_the_judges() -> None:
    render = _Render([_inside_edit(), _inside_edit()])
    attempts = []
    async for a in edit_loop.iter_edit_attempts(
        render,
        source_bytes=_jpg(_base()),
        mask_png=None,
        region_box=None,
        judge_alignment=_judge(3.0, 9.0, rationale="missed the ask"),  # type: ignore[arg-type]
        judge_medium=_judge(9.0),  # type: ignore[arg-type]
        instruction="a red panel",
        config=_CFG,
    ):
        attempts.append(a)
    assert [a.accepted for a in attempts] == [False, True]
    assert "missed the ask" in render.suffixes[1]
    assert "beyond the selected region" not in render.suffixes[1]


def test_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDIT_LOOP_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("EDIT_LOOP_ACCEPT_ALIGNMENT", "8.5")
    monkeypatch.setenv("EDIT_LOOP_OUTSIDE_MAX", "0.1")
    monkeypatch.setenv("EDIT_LOOP_ACCEPT_MEDIUM", "junk")  # bad value -> default
    cfg = edit_loop.edit_loop_config_from_env()
    assert cfg.max_attempts == 3
    assert cfg.accept_alignment == 8.5
    assert cfg.outside_change_max == 0.1
    assert cfg.accept_medium == 6.0


def test_inside_crop_cuts_the_selection() -> None:
    crop = edit_loop.inside_crop_bytes(_jpg(_base()), _BOX)
    w, h = Image.open(io.BytesIO(crop)).size
    assert (w, h) == (48, 36)  # 0.375*128, 0.5*72
    full = edit_loop.inside_crop_bytes(_jpg(_base()), None)
    assert Image.open(io.BytesIO(full)).size == (_W, _H)


async def test_edit_judges_run_concurrently() -> None:
    # Alignment + medium are independent verdicts and must overlap (the same
    # latency fix as the render loop). Alignment blocks until medium STARTS —
    # sequential execution times out instead of accepting.
    import asyncio

    started = asyncio.Event()

    async def alignment(_instr: str, _img: bytes) -> JudgeResult:
        await asyncio.wait_for(started.wait(), timeout=2.0)
        return JudgeResult(9.0, "", "")

    async def medium(_src: bytes, _out: bytes) -> JudgeResult:
        started.set()
        return JudgeResult(9.0, "", "")

    render = _Render([_inside_edit()])
    attempts = await _drain(render, alignment=alignment, medium=medium)
    assert len(attempts) == 1 and attempts[0].accepted


def test_edit_config_per_request_attempts_clamped() -> None:
    # Mirrors render_loop: the per-request ask wins inside [1, cap].
    assert edit_loop.edit_loop_config_from_env(max_attempts=1).max_attempts == 1
    assert edit_loop.edit_loop_config_from_env(max_attempts=99).max_attempts == 4
    assert edit_loop.edit_loop_config_from_env(max_attempts=0).max_attempts == 1
    assert edit_loop.edit_loop_config_from_env().max_attempts == 2
