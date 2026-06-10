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


async def test_ascend_container_continues_source_via_edit_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # SCALE_OUTWARD_EDIT_REF defaults ON: the container render goes through the
    # edit endpoint (the only path where the source ref bites) — not the inert
    # text-to-image ref path, and not the outpaint.
    _enable(monkeypatch)
    monkeypatch.delenv("SCALE_OUTWARD_OUTPAINT", raising=False)
    gen = _mock_fresh(monkeypatch)
    edit = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)
    outpaint = AsyncMock()
    monkeypatch.setattr(image_edit_mod, "expand_image_zoomout", outpaint)

    events = await _collect(_event_stream(_ascend_body(), "t1"))
    ready = next(e for e in events if e["type"] == "ascend_ready")
    assert ready["scale_tier"] == "region"  # one rung coarser than city
    assert ready["from_tier"] == "city"
    assert ready["page_title"] == "The Vallen Sea and Coastline"
    edit.assert_awaited_once()  # the ref-honouring edit container
    assert edit.await_args.args[0] == "data:image/jpeg;base64,abc"  # the source
    gen.assert_not_awaited()  # NOT the no-op text-to-image ref path
    outpaint.assert_not_awaited()  # NOT the outpaint


async def test_ascend_edit_ref_kill_switch_reverts_to_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # SCALE_OUTWARD_EDIT_REF=false: byte-identical to the old fresh container.
    _enable(monkeypatch)
    monkeypatch.setenv("SCALE_OUTWARD_EDIT_REF", "false")
    gen = _mock_fresh(monkeypatch)
    edit = AsyncMock()
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)

    events = await _collect(_event_stream(_ascend_body(), "t1"))
    ready = next(e for e in events if e["type"] == "ascend_ready")
    assert ready["page_title"] == "The Vallen Sea and Coastline"
    gen.assert_awaited_once()  # the fresh scale_parent container
    edit.assert_not_awaited()


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


async def test_ascend_edit_ref_under_flag_routes_through_edit_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # SCALE_OUTWARD_EDIT_REF: route the fresh container through the edit endpoint
    # (which honors the source ref) instead of the no-op text-to-image ref path.
    _enable(monkeypatch)
    monkeypatch.delenv("SCALE_OUTWARD_OUTPAINT", raising=False)
    monkeypatch.setenv("SCALE_OUTWARD_EDIT_REF", "1")
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("The Vallen Sea", "a wider engraving map", [], [])),
    )
    gen = AsyncMock()
    monkeypatch.setattr(image_mod, "generate_image", gen)
    edit = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)

    body = _ascend_body(session_style_anchor="hand-drawn engraving, sepia ink")
    events = await _collect(_event_stream(body, "t1"))
    ready = next(e for e in events if e["type"] == "ascend_ready")
    assert ready["from_tier"] == "city"
    edit.assert_awaited_once()  # routed through the edit endpoint (ref honored)
    gen.assert_not_awaited()  # NOT the no-op text-to-image ref path
    assert edit.await_args.args[0] == "data:image/jpeg;base64,abc"  # the source image
    assert "engraving" in edit.await_args.args[1]  # the medium reaches the instruction


async def test_ascend_outward_clause_rides_the_edit_instruction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # View grammar on OUTWARD: the SOURCE's persisted view rides the edit
    # instruction as the outpaint-semantics rider ("the camera simply pulls
    # back; nothing rescales") — pixel coherence with the view being extended.
    from generate import SceneView, ViewSpec

    _enable(monkeypatch)
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("The Vallen Sea", "a wider map", [], [])),
    )
    edit = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)

    body = _ascend_body(
        scene_view=SceneView(
            node_id="n0",
            level="map",
            scale_tier="city",
            view=ViewSpec(projection="eye_level", source="user"),
        )
    )
    events = await _collect(_event_stream(body, "t1"))
    assert any(e["type"] == "ascend_ready" for e in events)
    instr = edit.await_args.args[1]
    assert "the camera simply pulls back" in instr  # eye_level register rider
    assert "nothing inside the original view changes or rescales" in instr
    # And with the grammar off, the rider is gone (legacy bytes).
    monkeypatch.setenv("VIEW_GRAMMAR", "false")
    edit.reset_mock()
    await _collect(_event_stream(body, "t1"))
    assert "pulls back" not in edit.await_args.args[1]
