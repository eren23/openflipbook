"""Tests for the mask-scoped inpaint provider (providers/inpaint.py)."""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from providers import inpaint

# --- arg shapes per model family (the schema contract) -----------------------


def test_fill_family_takes_singular_image_url() -> None:
    args = inpaint._inpaint_args_for("fal-ai/flux-pro/v1/fill", "a pond", "img", "mask")
    assert args == {"prompt": "a pond", "image_url": "img", "mask_url": "mask"}


def test_gpt_family_takes_image_urls_list() -> None:
    args = inpaint._inpaint_args_for("openai/gpt-image-2/edit", "a pond", "img", "mask")
    assert args == {"prompt": "a pond", "image_urls": ["img"], "mask_url": "mask"}


# --- model resolution + call wiring ------------------------------------------


async def _call(
    monkeypatch: pytest.MonkeyPatch, **over: Any
) -> tuple[Any, AsyncMock]:
    monkeypatch.setattr(inpaint, "_ensure_fal_key", lambda: None)
    monkeypatch.setattr(
        inpaint, "to_fal_url", AsyncMock(side_effect=lambda u: f"fal:{u[:16]}")
    )
    subscribe = AsyncMock(
        return_value={"images": [{"url": "https://out"}], "requestId": "r1"}
    )
    monkeypatch.setattr(inpaint, "_fal_subscribe", subscribe)
    monkeypatch.setattr(
        inpaint, "_fetch_image_bytes", AsyncMock(return_value=(b"jpeg", "image/jpeg"))
    )
    result = await inpaint.inpaint_image(
        image_data_url="data:image/jpeg;base64,xxx",
        mask_data_url="data:image/png;base64,yyy",
        instruction="a pond",
        **over,
    )
    return result, subscribe


async def test_default_model_is_the_inpaint_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    result, subscribe = await _call(monkeypatch)
    model, args = subscribe.await_args.args
    assert model == "fal-ai/flux-pro/v1/fill"
    assert args["image_url"].startswith("fal:") and args["mask_url"].startswith("fal:")
    assert result.model == "fal-ai/flux-pro/v1/fill"
    assert result.jpeg_bytes == b"jpeg"
    assert result.provider_request_id == "r1"


async def test_env_override_rules_the_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_INPAINT_MODEL", "fal-ai/someone-else/fill")
    _, subscribe = await _call(monkeypatch)
    assert subscribe.await_args.args[0] == "fal-ai/someone-else/fill"


async def test_explicit_override_beats_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_INPAINT_MODEL", "fal-ai/someone-else/fill")
    _, subscribe = await _call(monkeypatch, model_override="openai/gpt-image-2/edit")
    model, args = subscribe.await_args.args
    assert model == "openai/gpt-image-2/edit"
    assert "image_urls" in args and "image_url" not in args
