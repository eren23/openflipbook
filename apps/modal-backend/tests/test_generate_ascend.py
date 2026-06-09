"""Integration tests for the OUTWARD (ascend) branch in generate.py.

Drives the real `_event_stream` with mode="ascend" and the BRIA outpaint provider
mocked — asserts the `ascend_ready` event (shape + target rung), the flag gate
(off by default → refuses), the image requirement, the medium-flip guard, and
that the additive branch leaves the tap/query `final` path intact.

generate.py imports `modal` at module level (deploy-only); stub it before import.
"""

from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

import providers.image_edit as image_edit_mod  # noqa: E402
from generate import GenerateBody, SceneView, _event_stream  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402


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
        "query": "Ankh-Morpork",
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


async def test_ascend_outpaints_the_container(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable(monkeypatch)
    img = GeneratedImage(b"jpegbytes", "image/jpeg", "fal-ai/bria/expand", "req-1")
    mock = AsyncMock(return_value=img)
    monkeypatch.setattr(image_edit_mod, "expand_image_zoomout", mock)

    events = await _collect(_event_stream(_ascend_body(), "t1"))
    ready = next(e for e in events if e["type"] == "ascend_ready")
    assert ready["scale_tier"] == "region"  # one rung coarser than city
    assert ready["from_tier"] == "city"
    assert ready["image_data_url"].startswith("data:image/jpeg;base64,")
    assert ready["image_model"] == "fal-ai/bria/expand"
    mock.assert_awaited_once()


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


async def test_ascend_medium_flip_needs_rerender_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    # planet → star_system is a medium flip; without SCALE_OUTWARD_RERENDER it refuses
    # (the riskier fresh path stays off until the drift eval justifies it).
    _enable(monkeypatch)
    monkeypatch.delenv("SCALE_OUTWARD_RERENDER", raising=False)
    body = _ascend_body(scene_view=SceneView(node_id="n0", level="map", scale_tier="planet"))
    events = await _collect(_event_stream(body, "t1"))
    assert any(
        e["type"] == "error" and "SCALE_OUTWARD_RERENDER" in e["message"] for e in events
    )


async def test_query_mode_unaffected_by_ascend_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    # Regression: the additive ascend branch must not disturb the tap/query path.
    import providers.image as image_mod
    import providers.llm as llm_mod
    from providers.llm import PagePlan

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
