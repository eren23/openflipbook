"""Integration tests for the EDIT_JUDGE wiring in generate.py (E3).

Judged WHOLE-IMAGE edits: same edit_loop as the mask path, no outside gate
(no mask = no confinement promise). The gating contract mirrors EDIT_REGION:
flag off -> exactly today's un-judged path (same provider, same kwargs, same
final frame shape); flag on -> the legacy provider runs THROUGH the loop and
the final frame gains edit_verdict (outside_change null). A masked request
with both flags on takes the EDIT_REGION inpaint path — region wins.

Uses the test_generate_enter.py harness (stubbed modal + AsyncMock providers).
"""

from __future__ import annotations

import base64
import io
import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image, ImageDraw

sys.modules.setdefault("modal", MagicMock())

import providers.image_edit as image_edit_mod  # noqa: E402
import providers.inpaint as inpaint_mod  # noqa: E402
import providers.judge as judge_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, _event_stream  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.judge import JudgeResult  # noqa: E402

_W, _H = 128, 72


def _data_url(im: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    im.save(buf, fmt)
    mime = "image/jpeg" if fmt == "JPEG" else "image/png"
    return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"


def _page() -> Image.Image:
    grad = Image.linear_gradient("L").resize((_W, _H))
    return Image.merge("RGB", (grad, grad, grad))


def _mask_data_url() -> str:
    m = Image.new("L", (_W, _H), 0)
    ImageDraw.Draw(m).rectangle((64, 18, 112, 54), fill=255)
    return _data_url(m, fmt="PNG")


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _edit_body(**over: Any) -> GenerateBody:
    base: dict[str, Any] = {
        "query": "make the sky purple",
        "session_id": "s1",
        "mode": "edit",
        "image": _data_url(_page()),
        "edit_instruction": "make the sky purple",
        "web_search": False,
    }
    base.update(over)
    return GenerateBody(**base)


def _mock_polish(monkeypatch: pytest.MonkeyPatch) -> tuple[AsyncMock, AsyncMock]:
    polish_edit = AsyncMock(return_value="POLISHED")
    polish_fill = AsyncMock(return_value="DESCRIBED")
    monkeypatch.setattr(llm_mod, "polish_edit_instruction", polish_edit)
    monkeypatch.setattr(llm_mod, "polish_fill_description", polish_fill)
    return polish_edit, polish_fill


def _mock_edit(monkeypatch: pytest.MonkeyPatch, body_image: str) -> AsyncMock:
    raw = base64.b64decode(body_image.split(",", 1)[1])
    edit = AsyncMock(
        return_value=GeneratedImage(raw, "image/jpeg", "fal-ai/nano-banana-pro", "r1")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)
    return edit


def _mock_judges(
    monkeypatch: pytest.MonkeyPatch, alignment_scores: list[float] | None = None
) -> None:
    if alignment_scores is None:
        align: AsyncMock = AsyncMock(return_value=JudgeResult(9.0, "", ""))
    else:
        align = AsyncMock(
            side_effect=[JudgeResult(s, "no purple sky yet", "") for s in alignment_scores]
        )
    monkeypatch.setattr(judge_mod, "score_prompt_alignment", align)
    monkeypatch.setattr(
        judge_mod, "score_style_pair", AsyncMock(return_value=JudgeResult(9.0, "", ""))
    )


async def test_flag_off_is_byte_identical_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_polish(monkeypatch)
    body = _edit_body()
    edit = _mock_edit(monkeypatch, body.image or "")

    events = await _collect(_event_stream(body, "t1"))

    assert edit.await_count == 1
    assert edit.await_args.kwargs == {
        "image_data_url": body.image,
        "instruction": "POLISHED",
        "tier": None,
        "model_override": None,
        "style_ref_url": None,
    }
    final = next(e for e in events if e["type"] == "final")
    assert "edit_verdict" not in final


async def test_flag_on_judges_the_whole_image_edit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDIT_JUDGE", "1")
    _mock_polish(monkeypatch)
    _mock_judges(monkeypatch)
    body = _edit_body()
    edit = _mock_edit(monkeypatch, body.image or "")

    events = await _collect(_event_stream(body, "t1"))

    assert edit.await_count == 1
    assert edit.await_args.kwargs["instruction"] == "POLISHED"
    final = next(e for e in events if e["type"] == "final")
    assert "image_op" not in final  # still the edit endpoint, not an op change
    verdict = final["edit_verdict"]
    assert verdict["accepted"] is True
    assert verdict["attempts"] == 1
    assert verdict["alignment"] == 9.0
    assert verdict["outside_change"] is None  # whole-image: gate not applicable


async def test_rejected_attempt_folds_rationale_and_streams(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDIT_JUDGE", "1")
    _mock_polish(monkeypatch)
    _mock_judges(monkeypatch, alignment_scores=[3.0, 9.0])
    body = _edit_body()
    edit = _mock_edit(monkeypatch, body.image or "")

    events = await _collect(_event_stream(body, "t1"))

    assert edit.await_count == 2
    retry_instruction = edit.await_args_list[1].kwargs["instruction"]
    assert retry_instruction.startswith("POLISHED\n\n")
    assert "no purple sky yet" in retry_instruction
    assert any(e["type"] == "progress" for e in events)
    final = next(e for e in events if e["type"] == "final")
    assert final["edit_verdict"]["attempts"] == 2
    assert final["edit_verdict"]["accepted"] is True


async def test_region_path_wins_when_both_flags_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDIT_JUDGE", "1")
    monkeypatch.setenv("EDIT_REGION", "1")
    _, polish_fill = _mock_polish(monkeypatch)
    _mock_judges(monkeypatch)
    body = _edit_body(
        edit_mask=_mask_data_url(),
        edit_region={"x": 0.5, "y": 0.25, "w": 0.375, "h": 0.5},
    )
    edit = _mock_edit(monkeypatch, body.image or "")
    raw = base64.b64decode((body.image or "").split(",", 1)[1])
    inpaint = AsyncMock(
        return_value=GeneratedImage(raw, "image/jpeg", "fal-ai/flux-pro/v1/fill", "r2")
    )
    monkeypatch.setattr(inpaint_mod, "inpaint_image", inpaint)

    events = await _collect(_event_stream(body, "t1"))

    assert inpaint.await_count == 1
    assert edit.await_count == 0
    assert polish_fill.await_count == 1
    final = next(e for e in events if e["type"] == "final")
    assert final["image_op"] == "inpaint"


async def test_undecodable_source_degrades_to_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDIT_JUDGE", "1")
    _mock_polish(monkeypatch)
    body = _edit_body(image="https://example.com/page.jpg")
    edit = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r1")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)

    events = await _collect(_event_stream(body, "t1"))

    assert edit.await_count == 1
    final = next(e for e in events if e["type"] == "final")
    assert "edit_verdict" not in final


async def test_verify_false_skips_the_judged_edit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # EDIT_JUDGE on but the request says verify:false -> exactly the legacy
    # un-judged whole-image edit, no critics, no verdict.
    monkeypatch.setenv("EDIT_JUDGE", "1")
    _mock_polish(monkeypatch)
    _mock_judges(monkeypatch)
    body = _edit_body(verify=False)
    edit = _mock_edit(monkeypatch, body.image or "")

    events = await _collect(_event_stream(body, "t1"))

    assert edit.await_count == 1
    final = next(e for e in events if e["type"] == "final")
    assert "edit_verdict" not in final
