"""Tests for the continuation provider (image_edit.continue_image).

Kept in its own file so it doesn't collide with the expand-provider tests on
another branch. No network: fal is mocked at the module level.
"""
from __future__ import annotations

import pytest

from providers import image_edit


async def test_continue_image_defaults_to_kontext(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    async def fake_to_fal(data_url: str) -> str:
        return "fal://region"

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

    out = await image_edit.continue_image("data:image/png;base64,x", "zoom in")

    assert out.jpeg_bytes == b"jpeg"
    assert "kontext" in captured["model"]
    # Kontext takes a singular image_url + prompt (per _edit_args_for).
    assert captured["args"]["image_url"] == "fal://region"
    assert captured["args"]["prompt"] == "zoom in"


async def test_continue_image_respects_env_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    async def fake_to_fal(data_url: str) -> str:
        return "fal://region"

    async def fake_sub(model: str, args: dict) -> dict:
        captured["model"] = model
        return {"images": [{"url": "http://x"}]}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        return b"j", "image/jpeg"

    monkeypatch.setenv("FAL_KEY", "fk")
    monkeypatch.setenv("FAL_CONTINUE_MODEL", "fal-ai/custom/continue")
    monkeypatch.setattr(image_edit, "to_fal_url", fake_to_fal)
    monkeypatch.setattr(image_edit, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image_edit, "_fetch_image_bytes", fake_fetch)

    await image_edit.continue_image("data:image/png;base64,x", "z")

    assert captured["model"] == "fal-ai/custom/continue"
