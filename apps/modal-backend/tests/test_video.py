"""providers/video.py — tier→model resolution and the animate_image
orchestration, with the fal boundary (`to_fal_url` / `_fal_subscribe`)
mocked. No network, no spend."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from providers import video

# ── tier / model resolution ─────────────────────────────────────────────────


def test_resolve_tier_default_env_and_garbage(monkeypatch: pytest.MonkeyPatch) -> None:
    assert video._resolve_video_tier(None) == video.DEFAULT_VIDEO_TIER
    assert video._resolve_video_tier("PRO") == "pro"  # case-insensitive
    assert video._resolve_video_tier("bogus") == video.DEFAULT_VIDEO_TIER
    monkeypatch.setenv("FAL_VIDEO_TIER", "balanced")
    assert video._resolve_video_tier(None) == "balanced"
    assert video._resolve_video_tier("pro") == "pro"  # explicit arg beats env


def test_animate_model_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    # tier slot defaults
    assert video._animate_model() == video.DEFAULT_ANIMATE_MODEL
    assert video._animate_model("balanced") == video.TIER_VIDEO_MODELS["balanced"]
    assert video._animate_model("pro") == video.PRO_ANIMATE_MODEL
    # per-tier env slot beats the built-in table
    monkeypatch.setenv("FAL_VIDEO_TIER_BALANCED", "fal-ai/hunyuan-video-i2v")
    assert video._animate_model("balanced") == "fal-ai/hunyuan-video-i2v"
    # global override beats everything
    monkeypatch.setenv("FAL_ANIMATE_MODEL", "fal-ai/custom-i2v")
    assert video._animate_model("balanced") == "fal-ai/custom-i2v"


# ── animate_image orchestration ─────────────────────────────────────────────


def _fal_result(**video_over: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "url": "https://fal.media/out.mp4",
        "content_type": "video/mp4",
        "duration": 4.2,
    }
    payload.update(video_over)
    return {"video": payload}


async def _animate(
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: dict[str, Any] | None = None,
    **kwargs: Any,
) -> tuple[video.AnimatedClip, AsyncMock]:
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setattr(
        video, "to_fal_url", AsyncMock(return_value="https://fal.media/in.png")
    )
    subscribe = AsyncMock(return_value=_fal_result() if result is None else result)
    monkeypatch.setattr(video, "_fal_subscribe", subscribe)
    clip = await video.animate_image(
        image_data_url="data:image/png;base64,AAAA", prompt="gentle pan", **kwargs
    )
    return clip, subscribe


async def test_requires_fal_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # conftest scrubs FAL_KEY; the guard must fire before any provider call.
    subscribe = AsyncMock()
    monkeypatch.setattr(video, "_fal_subscribe", subscribe)
    with pytest.raises(RuntimeError, match="FAL_KEY"):
        await video.animate_image(image_data_url="data:x", prompt="pan")
    subscribe.assert_not_awaited()


async def test_fast_default_sends_plain_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    clip, subscribe = await _animate(monkeypatch)
    model, arguments = subscribe.await_args.args
    assert model == video.DEFAULT_ANIMATE_MODEL
    # fast path adds no duration/resolution knobs at all
    assert arguments == {"image_url": "https://fal.media/in.png", "prompt": "gentle pan"}
    assert clip == video.AnimatedClip(
        video_url="https://fal.media/out.mp4",
        content_type="video/mp4",
        model=video.DEFAULT_ANIMATE_MODEL,
        duration_seconds=4.2,
    )


@pytest.mark.parametrize(
    ("duration", "snapped"),
    [(3, "6"), (6, "6"), (7, "8"), (8, "8"), (9, "10"), (30, "10")],
)
async def test_pro_snaps_duration_to_string_enum(
    monkeypatch: pytest.MonkeyPatch, duration: int, snapped: str
) -> None:
    # LTX-2 wants duration/resolution as STRING enums; ints make fal 502.
    _, subscribe = await _animate(monkeypatch, tier="pro", duration=duration)
    model, arguments = subscribe.await_args.args
    assert model == video.PRO_ANIMATE_MODEL
    assert arguments["duration"] == snapped
    assert arguments["resolution"] == "1080p"


@pytest.mark.parametrize(("duration", "num_frames"), [(1, 16), (5, 80), (30, 96)])
async def test_wan_clamps_duration_into_num_frames(
    monkeypatch: pytest.MonkeyPatch, duration: int, num_frames: int
) -> None:
    _, subscribe = await _animate(monkeypatch, tier="balanced", duration=duration)
    model, arguments = subscribe.await_args.args
    assert model == "fal-ai/wan-i2v"
    assert arguments["num_frames"] == num_frames
    assert arguments["resolution"] == "720p"
    assert "duration" not in arguments


async def test_no_video_payload_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(RuntimeError, match="no video payload"):
        await _animate(monkeypatch, result={"images": []})


async def test_video_without_url_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(RuntimeError, match="without url"):
        await _animate(monkeypatch, result={"video": {"content_type": "video/mp4"}})


async def test_content_type_and_duration_fall_back(monkeypatch: pytest.MonkeyPatch) -> None:
    clip, _ = await _animate(
        monkeypatch, result={"video": {"url": "https://fal.media/x.mp4"}}, duration=7
    )
    assert clip.content_type == "video/mp4"
    assert clip.duration_seconds == 7.0  # requested duration when fal omits it


# ── data_url_from_bytes ─────────────────────────────────────────────────────


def test_data_url_from_bytes() -> None:
    assert video.data_url_from_bytes(b"abc") == "data:image/jpeg;base64,YWJj"
    assert video.data_url_from_bytes(b"abc", "image/png") == "data:image/png;base64,YWJj"
