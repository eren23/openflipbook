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


@pytest.mark.parametrize(
    ("tier", "model", "resolution"),
    [
        ("fast", "minimax/h3-max-turbo/image-to-video", "768P"),
        ("balanced", "minimax/h3-max/image-to-video", "768P"),
        ("pro", "minimax/h3-max/image-to-video", "1080P"),
    ],
)
async def test_every_tier_runs_h3_at_its_resolution(
    monkeypatch: pytest.MonkeyPatch, tier: str, model: str, resolution: str
) -> None:
    _, subscribe = await _animate(monkeypatch, tier=tier)
    sent, arguments = subscribe.await_args.args
    assert sent == model
    assert arguments["resolution"] == resolution
    assert arguments["prompt_expansion_mode"] == "balanced"
    assert arguments["duration"] == 5
    assert "end_image_url" not in arguments


def test_animate_model_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    # tier slot defaults
    assert video._animate_model() == video.H3_TURBO_MODEL
    assert video._animate_model("balanced") == video.DEFAULT_ANIMATE_MODEL
    assert video._animate_model("pro") == video.H3_MAX_MODEL
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
    monkeypatch.setattr(video, "to_fal_url", AsyncMock(return_value="https://fal.media/in.png"))
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


async def test_an_unknown_override_sends_plain_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAL_ANIMATE_MODEL", "fal-ai/ltx-video/image-to-video")
    clip, subscribe = await _animate(monkeypatch)
    model, arguments = subscribe.await_args.args
    assert model == "fal-ai/ltx-video/image-to-video"
    # a slug without a known shape gets no duration/resolution knobs at all
    assert arguments == {"image_url": "https://fal.media/in.png", "prompt": "gentle pan"}
    assert clip == video.AnimatedClip(
        video_url="https://fal.media/out.mp4",
        content_type="video/mp4",
        model="fal-ai/ltx-video/image-to-video",
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
    monkeypatch.setenv("FAL_VIDEO_TIER_PRO", video.LTX2_ANIMATE_MODEL)
    _, subscribe = await _animate(monkeypatch, tier="pro", duration=duration)
    model, arguments = subscribe.await_args.args
    assert model == video.LTX2_ANIMATE_MODEL
    assert arguments["duration"] == snapped
    assert arguments["resolution"] == "1080p"


@pytest.mark.parametrize(("duration", "num_frames"), [(1, 16), (5, 80), (30, 96)])
async def test_wan_clamps_duration_into_num_frames(
    monkeypatch: pytest.MonkeyPatch, duration: int, num_frames: int
) -> None:
    monkeypatch.setenv("FAL_VIDEO_TIER_BALANCED", "fal-ai/wan-i2v")
    _, subscribe = await _animate(monkeypatch, tier="balanced", duration=duration)
    model, arguments = subscribe.await_args.args
    assert model == "fal-ai/wan-i2v"
    assert arguments["num_frames"] == num_frames
    assert arguments["resolution"] == "720p"
    assert "duration" not in arguments


async def test_descent_uses_the_dedicated_slot_and_sends_both_frames(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An end frame routes to DESCENT_ANIMATE_MODEL (NOT the tier table, NOT
    # FAL_ANIMATE_MODEL — an ambient override may not honour end_image_url).
    # The pro tier's 1080P does not follow it either.
    monkeypatch.setenv("FAL_ANIMATE_MODEL", "fal-ai/ambient-override")
    clip, subscribe = await _animate(
        monkeypatch, tier="pro", end_image_data_url="data:image/png;base64,BBBB"
    )
    model, arguments = subscribe.await_args.args
    assert model == video.DESCENT_ANIMATE_MODEL == video.H3_MAX_MODEL
    assert arguments["end_image_url"] == "https://fal.media/in.png"
    assert arguments["resolution"] == "768P"
    assert clip.model == video.DESCENT_ANIMATE_MODEL

    # An LTX descent override sends exactly first+last frame + prompt, no knobs.
    monkeypatch.setenv("FAL_DESCENT_MODEL", video.LTX_DESCENT_MODEL)
    _, subscribe = await _animate(monkeypatch, end_image_data_url="data:image/png;base64,BBBB")
    assert subscribe.await_args.args[1] == {
        "image_url": "https://fal.media/in.png",
        "end_image_url": "https://fal.media/in.png",
        "prompt": "gentle pan",
    }

    monkeypatch.setenv("FAL_DESCENT_MODEL", "fal-ai/custom-descent")
    _, subscribe = await _animate(monkeypatch, end_image_data_url="data:image/png;base64,BBBB")
    model, _ = subscribe.await_args.args
    assert model == "fal-ai/custom-descent"


async def test_no_video_payload_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(RuntimeError, match="no video payload"):
        await _animate(monkeypatch, result={"images": []})


@pytest.mark.parametrize(("duration", "expected"), [(1, 5), (6, 6), (30, 15)])
async def test_h3_max_descent_is_explicit_and_bounded(monkeypatch, duration, expected):
    monkeypatch.setenv("FAL_DESCENT_MODEL", video.H3_MAX_MODEL)
    clip, subscribe = await _animate(
        monkeypatch,
        duration=duration,
        end_image_data_url="data:image/png;base64,BBBB",
        result={"video": {"url": "https://fal.media/out.mp4"}},
    )
    model, arguments = subscribe.await_args.args
    assert model == video.H3_MAX_MODEL
    assert arguments["duration"] == expected
    assert arguments["resolution"] == "768P"
    assert arguments["prompt_expansion_mode"] == "balanced"
    assert arguments["enable_safety_checker"] is True
    assert arguments["end_image_url"]
    assert clip.duration_seconds == expected


async def test_h3_override_does_not_escape_mock_mode(monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setenv("FAL_DESCENT_MODEL", video.H3_MAX_MODEL)
    clip, subscribe = await _animate(monkeypatch, end_image_data_url="data:image/png;base64,BBBB")
    assert clip.model == "mock/animate"
    subscribe.assert_not_awaited()


async def test_video_without_url_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(RuntimeError, match="without url"):
        await _animate(monkeypatch, result={"video": {"content_type": "video/mp4"}})


async def test_content_type_and_duration_fall_back(monkeypatch: pytest.MonkeyPatch) -> None:
    clip, _ = await _animate(
        monkeypatch, result={"video": {"url": "https://fal.media/x.mp4"}}, duration=7
    )
    assert clip.content_type == "video/mp4"
    assert clip.duration_seconds == 7.0  # requested duration when fal omits it


# ── the H3 builder and camera-controls ──────────────────────────────────────


@pytest.mark.parametrize(
    ("model", "duration", "expected"),
    [
        (video.H3_TURBO_MODEL, 1, 5),
        (video.H3_MAX_MODEL, 9, 9),
        (video.H3_MAX_MODEL, 40, 15),
        (video.H3_CAMERA_MODEL, 1, 3),
        (video.H3_CAMERA_MODEL, 40, 15),
    ],
)
def test_h3_arguments_clamp_duration(model: str, duration: int, expected: int) -> None:
    arguments = video.h3_arguments(model, "https://in", "push in", duration)
    assert arguments["duration"] == expected
    assert arguments["prompt_expansion_mode"] == "balanced"
    assert arguments["resolution"] == "768P"


def test_camera_controls_arguments_carry_no_end_frame_or_safety_flag() -> None:
    arguments = video.h3_arguments(
        video.H3_CAMERA_MODEL, "https://in", "push in", 5, resolution="480P"
    )
    assert arguments == {
        "image_url": "https://in",
        "prompt": "push in",
        "duration": 5,
        "resolution": "480P",
        "prompt_expansion_mode": "balanced",
    }


async def test_camera_controls_sends_the_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setattr(video, "to_fal_url", AsyncMock(return_value="https://fal.media/in.png"))
    subscribe = AsyncMock(return_value=_fal_result())
    monkeypatch.setattr(video, "_fal_subscribe", subscribe)
    path = [
        {"time": 0.0, "azimuth": 0, "elevation": 0, "distance": 1.0},
        {"time": 1.0, "azimuth": 15, "elevation": 0, "distance": 0.7},
    ]
    clip = await video.camera_controls("data:image/png;base64,AAAA", "walk on", path, 20)
    model, arguments = subscribe.await_args.args
    assert model == video.H3_CAMERA_MODEL == clip.model
    assert arguments["camera_trajectory"] == path
    assert arguments["duration"] == 15
    assert "end_image_url" not in arguments


async def test_camera_controls_does_not_escape_mock_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    subscribe = AsyncMock()
    monkeypatch.setattr(video, "_fal_subscribe", subscribe)
    clip = await video.camera_controls("data:image/png;base64,AAAA", "walk on", [], 5)
    assert clip.model == "mock/camera-controls"
    subscribe.assert_not_awaited()


def test_estimate_follows_the_tier_and_the_clamped_duration() -> None:
    assert video.estimate_usd(5, "fast") == pytest.approx(0.0625)
    assert video.estimate_usd(5, "balanced") == pytest.approx(0.125)
    # H3 bills at least 5 s, so a shorter ask is not a cheaper reservation.
    assert video.estimate_usd(1, "fast") == video.estimate_usd(5, "fast")
    assert video.estimate_usd(5, "fast", descent=True) == pytest.approx(0.125)


# ── POST /animate reserves spend ────────────────────────────────────────────


class _Req:
    """Enough Request for the handler: headers, and an IP for the limiter."""

    def __init__(self) -> None:
        self.headers: dict[str, str] = {}
        self.client = type("C", (), {"host": "127.0.0.1"})()


@pytest.fixture
def _animate_endpoint(monkeypatch: pytest.MonkeyPatch):
    import generate
    from providers import spend

    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setenv("ANIMATE_PROMPT_REWRITE", "false")
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    monkeypatch.delenv("MAX_SESSION_SPEND", raising=False)
    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    spend.reset_for_tests()
    yield generate
    spend.reset_for_tests()


async def test_animate_reserves_the_clip_estimate(_animate_endpoint) -> None:
    from providers import spend

    generate = _animate_endpoint
    body = generate.AnimateBody(
        image_data_url="data:image/png;base64,AAAA", prompt="Harbour", session_id="s1"
    )
    res = await generate.animate(_Req(), body)
    assert res.status_code == 200
    assert spend.session_total("s1") == pytest.approx(video.estimate_usd(5, "fast"))


async def test_animate_refuses_over_the_cap_before_it_submits(
    _animate_endpoint, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    generate = _animate_endpoint
    submit = AsyncMock()
    monkeypatch.setattr(video, "animate_image", submit)
    monkeypatch.setenv("MAX_SESSION_SPEND", "0.05")  # a turbo 5 s clip is 0.0625
    body = generate.AnimateBody(
        image_data_url="data:image/png;base64,AAAA", prompt="Harbour", session_id="s1"
    )
    res = await generate.animate(_Req(), body)
    assert res.status_code == 502
    assert "Session spend cap" in json.loads(bytes(res.body))["error"]
    submit.assert_not_awaited()
