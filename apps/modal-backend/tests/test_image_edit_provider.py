"""Tests for the edit/expand provider (providers/image_edit.py)."""
from __future__ import annotations

import pytest

from providers import image_edit


def test_expand_args_east_keeps_parent_left_and_grows_width() -> None:
    args = image_edit._expand_args_for("u", "east", 1600, 900)
    assert args["canvas_size"] == [2400, 900]  # +50% width
    assert args["original_image_location"] == [0, 0]  # parent at the left, new on right
    assert args["original_image_size"] == [1600, 900]


def test_expand_args_west_shifts_parent_right() -> None:
    args = image_edit._expand_args_for("u", "west", 1600, 900)
    assert args["canvas_size"] == [2400, 900]
    assert args["original_image_location"] == [800, 0]  # parent right, new on left


def test_expand_args_north_south_grow_height() -> None:
    south = image_edit._expand_args_for("u", "south", 1600, 900)
    assert south["canvas_size"] == [1600, 1350]
    assert south["original_image_location"] == [0, 0]
    north = image_edit._expand_args_for("u", "north", 1600, 900)
    assert north["original_image_location"] == [0, 450]  # parent bottom, new above


async def test_expand_image_defaults_to_bria(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    async def fake_to_fal(data_url: str) -> str:
        return "fal://parent"

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

    out = await image_edit.expand_image("data:image/jpeg;base64,x", "east", 1600, 900)

    assert out.jpeg_bytes == b"jpeg"
    assert "bria" in captured["model"]
    assert captured["args"]["image_url"] == "fal://parent"
    assert captured["args"]["canvas_size"] == [2400, 900]
