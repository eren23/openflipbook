"""MOCK_PROVIDERS=1 — the zero-key stack, proven end-to-end.

NOTHING is monkeypatched here: the stream runs through the real generate.py
pipeline, the real provider modules, the real parsers — only the two mock
seams (the fake LLM client + the PIL image cards) stand in for the network.
If these pass with no keys in the environment, a contributor's first clone
works.
"""
from __future__ import annotations

import base64
import io
import json
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest
from PIL import Image

sys.modules.setdefault("modal", MagicMock())

from generate import GenerateBody, _event_stream  # noqa: E402
from providers import mock, spend  # noqa: E402


@pytest.fixture(autouse=True)
def _mock_mode(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    spend.reset_for_tests()
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


def _decodable_jpeg(data_url: str) -> bool:
    assert data_url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    Image.open(io.BytesIO(raw)).verify()
    return True


async def test_query_stream_end_to_end_with_zero_keys() -> None:
    events = await _collect(
        _event_stream(
            GenerateBody(query="a small harbor town", session_id="s1", web_search=False),
            "t1",
        )
    )
    final = next(e for e in events if e["type"] == "final")
    assert _decodable_jpeg(final["image_data_url"])
    assert final["image_model"] == "mock/fresh"
    assert final["page_title"].startswith("Mock page:")
    assert final["session_spend_estimate"] > 0  # the meter runs on mocks too


async def test_tap_stream_resolves_and_renders() -> None:
    seed = await _collect(
        _event_stream(
            GenerateBody(query="a small harbor town", session_id="s2", web_search=False),
            "t1",
        )
    )
    parent = next(e for e in seed if e["type"] == "final")
    events = await _collect(
        _event_stream(
            GenerateBody(
                query="a small harbor town",
                session_id="s2",
                mode="tap",
                web_search=False,
                image=parent["image_data_url"],
                click={"x_pct": 0.5, "y_pct": 0.5},
            ),
            "t2",
        )
    )
    resolved = next(e for e in events if e.get("stage") == "click_resolved")
    assert resolved["subject"]  # the mock client routed the click prompt
    final = next(e for e in events if e["type"] == "final")
    assert _decodable_jpeg(final["image_data_url"])


async def test_mock_determinism() -> None:
    a = mock.mock_image("the same prompt", op="fresh")
    b = mock.mock_image("the same prompt", op="fresh")
    c = mock.mock_image("a different prompt", op="fresh")
    assert a.jpeg_bytes == b.jpeg_bytes
    assert a.jpeg_bytes != c.jpeg_bytes
