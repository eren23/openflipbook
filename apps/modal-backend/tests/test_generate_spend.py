"""The spend gate + estimate on the generate stream (uses the stubbed-modal
harness from test_generate_enter.py)."""
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
from providers import spend  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import PagePlan  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_meter(monkeypatch: pytest.MonkeyPatch):
    spend.reset_for_tests()
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    yield
    spend.reset_for_tests()


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _query_body() -> GenerateBody:
    return GenerateBody(
        query="how do boilers work", session_id="s1", web_search=False
    )


def _mock_providers(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("Boilers", "a cutaway", ["Drum"], [])),
    )
    gen = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r1")
    )
    monkeypatch.setattr(image_mod, "generate_image", gen)
    return gen


async def test_final_carries_session_spend_estimate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_providers(monkeypatch)
    events = await _collect(_event_stream(_query_body(), "t1"))
    final = next(e for e in events if e["type"] == "final")
    assert final["session_spend_estimate"] == pytest.approx(
        0.15 + spend.VLM_STACK_FLAT
    )
    # a second page in the same session accumulates
    events2 = await _collect(_event_stream(_query_body(), "t2"))
    final2 = next(e for e in events2 if e["type"] == "final")
    assert final2["session_spend_estimate"] == pytest.approx(2 * (0.15 + 0.02))


async def test_daily_cap_refuses_before_any_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gen = _mock_providers(monkeypatch)
    monkeypatch.setenv("MAX_DAILY_SPEND", "0.05")
    spend.record("warmup", 0.06)  # someone already burned today's budget

    events = await _collect(_event_stream(_query_body(), "t1"))

    assert len(events) == 1 and events[0]["type"] == "error"
    assert "MAX_DAILY_SPEND" in events[0]["message"]
    gen.assert_not_awaited()


async def test_duplicate_generate_logged_not_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The client guard should make identical back-to-back generates
    # impossible; when one arrives anyway it's a LOG, never a refusal.
    gen = _mock_providers(monkeypatch)
    await _collect(_event_stream(_query_body(), "t1"))
    events = await _collect(_event_stream(_query_body(), "t2"))
    assert any(e["type"] == "final" for e in events)  # second run still works
    assert gen.await_count == 2
