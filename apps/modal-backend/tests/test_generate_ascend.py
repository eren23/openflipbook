"""Integration tests for the OUTWARD (ascend) branch in generate.py.

The DEFAULT path is the fresh `scale_parent` container (a seamless wider view of
the same world in the same medium — live-verified far more coherent than the
outpaint). The centered outpaint is OPT-IN via SCALE_OUTWARD_OUTPAINT, and now
steers its painted margin with the medium so it isn't photoreal. These assert the
flag gate, the default-fresh path, the opt-in medium-guided outpaint, the image
requirement, and that the tap/query path is untouched.

generate.py imports `modal` at module level (deploy-only); stub it before import.
"""

from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

import providers.image as image_mod  # noqa: E402
import providers.image_edit as image_edit_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, SceneView, _event_stream  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import PagePlan  # noqa: E402


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _ascend_body(**over: Any) -> GenerateBody:
    base: dict[str, Any] = {
        "query": "Port Vallen",
        "session_id": "s1",
        "mode": "ascend",
        "image": "data:image/jpeg;base64,abc",
        "scene_view": SceneView(node_id="n0", level="map", scale_tier="city"),
        "web_search": False,
    }
    base.update(over)
    return GenerateBody(**base)


def _enable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCALE_LADDER_NAV", "1")
    monkeypatch.setenv("SCALE_OUTWARD", "1")


def _mock_fresh(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("The Vallen Sea and Coastline", "a wider engraving map", [], [])),
    )
    gen = AsyncMock(
        return_value=GeneratedImage(b"jpegbytes", "image/jpeg", "fal-ai/nano-banana-pro", "r")
    )
    monkeypatch.setattr(image_mod, "generate_image", gen)
    return gen


async def test_ascend_fresh_container_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable(monkeypatch)
    monkeypatch.delenv("SCALE_OUTWARD_OUTPAINT", raising=False)
    gen = _mock_fresh(monkeypatch)
    outpaint = AsyncMock()
    monkeypatch.setattr(image_edit_mod, "expand_image_zoomout", outpaint)

    events = await _collect(_event_stream(_ascend_body(), "t1"))
    ready = next(e for e in events if e["type"] == "ascend_ready")
    assert ready["scale_tier"] == "region"  # one rung coarser than city
    assert ready["from_tier"] == "city"
    assert ready["page_title"] == "The Vallen Sea and Coastline"
    gen.assert_awaited_once()  # the fresh scale_parent container
    outpaint.assert_not_awaited()  # NOT the outpaint


async def test_ascend_outpaint_under_flag_steers_the_medium(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable(monkeypatch)
    monkeypatch.setenv("SCALE_OUTWARD_OUTPAINT", "1")
    img = GeneratedImage(b"jpegbytes", "image/jpeg", "fal-ai/bria/expand", "req-1")
    mock = AsyncMock(return_value=img)
    monkeypatch.setattr(image_edit_mod, "expand_image_zoomout", mock)

    body = _ascend_body(session_style_anchor="hand-drawn engraving, sepia ink, cross-hatching")
    events = await _collect(_event_stream(body, "t1"))
    ready = next(e for e in events if e["type"] == "ascend_ready")
    assert ready["image_model"] == "fal-ai/bria/expand"
    mock.assert_awaited_once()
    # The medium MUST reach BRIA, or the painted margin comes back photoreal.
    assert "engraving" in (mock.await_args.kwargs.get("prompt") or "")


async def test_ascend_gated_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # Flags unset → the branch refuses; prod byte-identical.
    monkeypatch.delenv("SCALE_LADDER_NAV", raising=False)
    monkeypatch.delenv("SCALE_OUTWARD", raising=False)
    events = await _collect(_event_stream(_ascend_body(), "t1"))
    assert events[0]["type"] == "error"
    assert "disabled" in events[0]["message"]


async def test_ascend_requires_an_image(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable(monkeypatch)
    events = await _collect(_event_stream(_ascend_body(image=None), "t1"))
    assert any(e["type"] == "error" and "requires an image" in e["message"] for e in events)


async def test_query_mode_unaffected_by_ascend_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    # Regression: the additive ascend branch must not disturb the tap/query path.
    _enable(monkeypatch)
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    monkeypatch.setattr(
        llm_mod, "plan_page", AsyncMock(return_value=PagePlan("Boilers", "a diagram", ["x"], []))
    )
    monkeypatch.setattr(
        image_mod,
        "generate_image",
        AsyncMock(return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-model", "r")),
    )
    body = GenerateBody(query="how do boilers work", session_id="s1")
    events = await _collect(_event_stream(body, "t1"))
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1
    assert not [e for e in events if e["type"] == "ascend_ready"]
