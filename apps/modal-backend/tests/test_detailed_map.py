"""DETAILED_MAP: the root-map spec expander and its tap.py wiring.

Flag off = byte-identical plan_page path. Flag on = expand_map_spec
replaces the plan on ROOT world maps only, the spec renders verbatim,
and the fresh gen routes to the long-spec model. Fail-open: a thin or
failed spec falls back to plan_page.
"""

from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

import providers.image as image_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, _event_stream  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import MapSpec, PagePlan  # noqa: E402
from providers.llm.map_spec import expand_map_spec  # noqa: E402

LONG_SPEC = "SPEC " + ("districts and landmarks at (x, y). " * 40)


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _root_map_body() -> GenerateBody:
    return GenerateBody(
        query="a walled harbor city",
        session_id="s1",
        mode="query",
        web_search=False,
        world_mode=True,
        render_mode="place_submap",
        session_style_anchor="woodcut",
    )


def _mock_gen(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    gen = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r1")
    )
    monkeypatch.setattr(image_mod, "generate_image", gen)
    return gen


@pytest.fixture(autouse=True)
def _quiet(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    yield


async def test_flag_off_keeps_the_plan_path(monkeypatch: pytest.MonkeyPatch) -> None:
    plan = AsyncMock(return_value=PagePlan("Harborville", "a fine map", [], []))
    spec = AsyncMock()
    monkeypatch.setattr(llm_mod, "plan_page", plan)
    monkeypatch.setattr(llm_mod, "expand_map_spec", spec)
    gen = _mock_gen(monkeypatch)

    await _collect(_event_stream(_root_map_body(), "t1"))

    plan.assert_awaited_once()
    spec.assert_not_awaited()
    assert gen.await_args.kwargs["model_override"] is None


async def test_flag_on_renders_the_spec_on_the_long_spec_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DETAILED_MAP", "1")
    plan = AsyncMock()
    spec = AsyncMock(return_value=MapSpec("Harborville", LONG_SPEC))
    monkeypatch.setattr(llm_mod, "plan_page", plan)
    monkeypatch.setattr(llm_mod, "expand_map_spec", spec)
    gen = _mock_gen(monkeypatch)

    events = await _collect(_event_stream(_root_map_body(), "t1"))

    plan.assert_not_awaited()
    assert LONG_SPEC in gen.await_args.kwargs["prompt"]
    assert gen.await_args.kwargs["model_override"] == "fal-ai/nano-banana-pro"
    final = next(e for e in events if e["type"] == "final")
    assert final["page_title"] == "Harborville"

    # An explicit env slot re-routes; an explicit request model beats both.
    monkeypatch.setenv("DETAILED_MAP_MODEL", "fal-ai/custom-map")
    await _collect(_event_stream(_root_map_body(), "t2"))
    assert gen.await_args.kwargs["model_override"] == "fal-ai/custom-map"


async def test_flag_on_explicit_request_model_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DETAILED_MAP", "1")
    monkeypatch.setattr(
        llm_mod, "expand_map_spec", AsyncMock(return_value=MapSpec("T", LONG_SPEC))
    )
    monkeypatch.setattr(llm_mod, "plan_page", AsyncMock())
    gen = _mock_gen(monkeypatch)

    body = _root_map_body()
    body.image_model = "fal-ai/operator-pick"
    await _collect(_event_stream(body, "t1"))
    assert gen.await_args.kwargs["model_override"] == "fal-ai/operator-pick"


async def test_failed_spec_falls_back_to_the_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DETAILED_MAP", "1")
    plan = AsyncMock(return_value=PagePlan("Fallback", "plain prompt", [], []))
    monkeypatch.setattr(llm_mod, "plan_page", plan)
    monkeypatch.setattr(llm_mod, "expand_map_spec", AsyncMock(return_value=None))
    gen = _mock_gen(monkeypatch)

    await _collect(_event_stream(_root_map_body(), "t1"))

    plan.assert_awaited_once()
    # Fallback must NOT ride the detailed model routing.
    assert gen.await_args.kwargs["model_override"] is None


async def test_non_root_renders_never_expand(monkeypatch: pytest.MonkeyPatch) -> None:
    # A zoom/continue (condition images present) keeps the plan path even
    # with the flag on — detailed mode is ROOT maps only.
    monkeypatch.setenv("DETAILED_MAP", "1")
    plan = AsyncMock(return_value=PagePlan("Zoom", "closer map", [], []))
    spec = AsyncMock()
    monkeypatch.setattr(llm_mod, "plan_page", plan)
    monkeypatch.setattr(llm_mod, "expand_map_spec", spec)
    _mock_gen(monkeypatch)
    import providers.image_edit as image_edit_mod

    monkeypatch.setattr(
        image_edit_mod,
        "continue_image",
        AsyncMock(
            return_value=GeneratedImage(b"jpeg", "image/jpeg", "m", "r2")
        ),
    )

    body = _root_map_body()
    body.condition_image_urls = ["data:image/jpeg;base64,QUFB"]
    body.condition_roles = ["region"]
    await _collect(_event_stream(body, "t1"))
    spec.assert_not_awaited()


# ── the expander itself (LLM mocked) ─────────────────────────────────────────


async def test_expander_parses_and_caps(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm_mod,
        "_complete_json",
        AsyncMock(return_value={"page_title": "  Port   Vane  ", "spec": LONG_SPEC}),
    )
    out = await expand_map_spec("a port")
    assert out is not None
    assert out.page_title == "Port Vane"
    assert out.spec == LONG_SPEC.strip()


async def test_expander_rejects_thin_specs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm_mod,
        "_complete_json",
        AsyncMock(return_value={"page_title": "T", "spec": "too short"}),
    )
    assert await expand_map_spec("a port") is None


async def test_expander_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm_mod, "_complete_json", AsyncMock(side_effect=RuntimeError("boom"))
    )
    assert await expand_map_spec("a port") is None
