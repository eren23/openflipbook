"""Tests for the edit/continuation provider (providers/image_edit.py)."""
from __future__ import annotations

import pytest

from providers import image_edit


def _mock_fal(monkeypatch: pytest.MonkeyPatch, captured: dict) -> None:
    async def fake_to_fal(data_url: str) -> str:
        return "fal://uploaded"

    async def fake_sub(model: str, args: dict) -> dict:
        captured["model"] = model
        captured["args"] = args
        return {"images": [{"url": "http://x"}], "requestId": "r1"}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        return b"jpeg", "image/jpeg"

    monkeypatch.setenv("FAL_KEY", "fk")
    monkeypatch.setattr(image_edit, "to_fal_url", fake_to_fal)
    monkeypatch.setattr(image_edit, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image_edit, "_fetch_image_bytes", fake_fetch)


async def test_continue_image_defaults_to_kontext_image_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    _mock_fal(monkeypatch, captured)

    out = await image_edit.continue_image("data:image/jpeg;base64,x", "zoom in")

    assert out.jpeg_bytes == b"jpeg"
    # Default continuation model is FLUX Kontext, which takes `image_url` singular
    # (the region crop), not nano-banana's `image_urls` list.
    assert "kontext" in captured["model"]
    assert captured["args"] == {"prompt": "zoom in", "image_url": "fal://uploaded"}


async def test_continue_image_respects_override_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    _mock_fal(monkeypatch, captured)
    monkeypatch.setenv("FAL_CONTINUE_MODEL", "fal-ai/some-other/model")

    await image_edit.continue_image("data:image/jpeg;base64,x", "zoom in")

    assert captured["model"] == "fal-ai/some-other/model"
