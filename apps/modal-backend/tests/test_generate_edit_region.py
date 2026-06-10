"""Integration tests for the EDIT_REGION wiring in generate.py.

The byte-identity contract: with the flag off (the default) — or with no
mask in the request — a mode:"edit" body takes EXACTLY today's whole-image
path (same provider, same kwargs, same final frame shape). With the flag on
and a mask present, the judged inpaint path runs instead: fill description
register, inpaint provider, edit loop verdict on the final frame.

Uses the test_generate_enter.py harness (stubbed modal + AsyncMock providers);
the pixel metric runs for real on tiny synthetic frames.
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
_BOX = {"x": 0.5, "y": 0.25, "w": 0.375, "h": 0.5}


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


def _mock_legacy_edit(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    edit = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r1")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)
    return edit


def _mock_inpaint(monkeypatch: pytest.MonkeyPatch, body_image: str) -> AsyncMock:
    # Returns the source pixels untouched — outside-change 0.0, so the mocked
    # 9/9 judges accept at attempt 1.
    raw = base64.b64decode(body_image.split(",", 1)[1])
    inpaint = AsyncMock(
        return_value=GeneratedImage(raw, "image/jpeg", "fal-ai/flux-pro/v1/fill", "r2")
    )
    monkeypatch.setattr(inpaint_mod, "inpaint_image", inpaint)
    return inpaint


def _mock_judges(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        judge_mod,
        "score_prompt_alignment",
        AsyncMock(return_value=JudgeResult(9.0, "", "")),
    )
    monkeypatch.setattr(
        judge_mod,
        "score_style_pair",
        AsyncMock(return_value=JudgeResult(9.0, "", "")),
    )


async def test_flag_off_with_mask_is_byte_identical_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # EDIT_REGION unset (the default): a request CARRYING a mask still takes
    # exactly today's whole-image path — same provider, same kwargs.
    _, polish_fill = _mock_polish(monkeypatch)
    edit = _mock_legacy_edit(monkeypatch)
    body = _edit_body(edit_mask=_mask_data_url(), edit_region=_BOX)
    inpaint = _mock_inpaint(monkeypatch, body.image or "")

    events = await _collect(_event_stream(body, "t1"))

    assert inpaint.await_count == 0
    assert polish_fill.await_count == 0
    assert edit.await_args.kwargs == {
        "image_data_url": body.image,
        "instruction": "POLISHED",
        "tier": None,
        "model_override": None,
        "style_ref_url": None,
    }
    final = next(e for e in events if e["type"] == "final")
    assert "image_op" not in final
    assert "edit_verdict" not in final
    assert final["final_prompt"] == "POLISHED"


async def test_flag_on_without_mask_stays_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDIT_REGION", "1")
    _mock_polish(monkeypatch)
    edit = _mock_legacy_edit(monkeypatch)
    body = _edit_body()
    inpaint = _mock_inpaint(monkeypatch, body.image or "")

    await _collect(_event_stream(body, "t1"))

    assert inpaint.await_count == 0
    assert edit.await_count == 1


async def test_flag_on_with_mask_runs_the_judged_inpaint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDIT_REGION", "1")
    polish_edit, polish_fill = _mock_polish(monkeypatch)
    edit = _mock_legacy_edit(monkeypatch)
    _mock_judges(monkeypatch)
    body = _edit_body(edit_mask=_mask_data_url(), edit_region=_BOX)
    inpaint = _mock_inpaint(monkeypatch, body.image or "")

    events = await _collect(_event_stream(body, "t1"))

    assert edit.await_count == 0
    assert polish_edit.await_count == 0
    assert polish_fill.await_count == 1
    assert inpaint.await_count == 1
    assert inpaint.await_args.kwargs["instruction"] == "DESCRIBED"
    assert inpaint.await_args.kwargs["mask_data_url"] == body.edit_mask
    final = next(e for e in events if e["type"] == "final")
    assert final["image_op"] == "inpaint"
    assert final["image_model"] == "fal-ai/flux-pro/v1/fill"
    assert final["final_prompt"] == "DESCRIBED"
    verdict = final["edit_verdict"]
    assert verdict["accepted"] is True
    assert verdict["attempts"] == 1
    assert verdict["alignment"] == 9.0
    assert verdict["medium"] == 9.0
    assert verdict["outside_change"] == 0.0
