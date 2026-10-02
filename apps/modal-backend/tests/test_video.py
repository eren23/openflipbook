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


def test_estimate_follows_the_tier_its_resolution_and_the_clamped_duration() -> None:
    # regular per-second rates: turbo 768P $0.04, max 768P $0.08, max 1080P $0.16
    assert video.estimate_usd(5, "fast") == pytest.approx(0.2)
    assert video.estimate_usd(5, "balanced") == pytest.approx(0.4)
    assert video.estimate_usd(5, "pro") == pytest.approx(0.8)
    # H3 bills at least 5 s, so a shorter ask is not a cheaper reservation.
    assert video.estimate_usd(1, "fast") == video.estimate_usd(5, "fast")
    assert video.estimate_usd(5, "fast", descent=True) == pytest.approx(0.4)


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


# ── tapped-object action clips ──────────────────────────────────────────────


async def test_object_action_uses_h3_slot_not_the_tier_table(monkeypatch):
    # An ambient override must not capture object clips: they need a model
    # that follows a focused action prompt.
    monkeypatch.setenv("FAL_ANIMATE_MODEL", "fal-ai/ambient-override")
    clip, subscribe = await _animate(monkeypatch, tier="pro", duration=30, object_action=True)
    model, arguments = subscribe.await_args.args
    assert model == video.H3_MAX_MODEL
    assert arguments == {
        "image_url": "https://fal.media/in.png",
        "prompt": "gentle pan",
        "duration": 15,
        "resolution": "768P",
        "prompt_expansion_mode": "balanced",
        "enable_safety_checker": True,
    }
    assert "end_image_url" not in arguments
    assert clip.model == video.H3_MAX_MODEL

    monkeypatch.setenv("FAL_ACTION_MODEL", "fal-ai/custom-action")
    _, subscribe = await _animate(monkeypatch, object_action=True)
    model, arguments = subscribe.await_args.args
    assert model == "fal-ai/custom-action"
    assert arguments == {"image_url": "https://fal.media/in.png", "prompt": "gentle pan"}


async def test_object_action_does_not_escape_mock_mode(monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    clip, subscribe = await _animate(monkeypatch, object_action=True)
    assert clip.model == "mock/animate"
    subscribe.assert_not_awaited()


def test_object_action_prompt_anchors_the_tapped_object():
    prompt = video.object_action_prompt(
        "  the copper\n kettle   sign ", "It swings in a gust of wind.", 0.456, 0.3
    )
    assert "Focus on the copper kettle sign, about 46% from the left and 30% from the top" in prompt
    assert "It swings in a gust of wind. The camera eases" in prompt
    assert "no cuts" in prompt
    blank = video.object_action_prompt("", "   ", 0, 1)
    assert "Focus on the tapped object, about 0% from the left and 100% from the top" in blank
    assert "the tapped object comes to life with clear, natural motion." in blank


def test_animate_endpoint_routes_focus_to_the_object_slot(monkeypatch):
    from fastapi.testclient import TestClient

    from generate import fastapi_app
    from providers import llm

    rewrite = AsyncMock(return_value="rewritten")
    monkeypatch.setattr(llm, "rewrite_motion_prompt", rewrite)
    animate = AsyncMock(
        return_value=video.AnimatedClip(
            "https://fal.media/o.mp4", "video/mp4", video.H3_MAX_MODEL, 5.0
        )
    )
    monkeypatch.setattr(video, "animate_image", animate)
    client = TestClient(fastapi_app)
    focus = {"x_pct": 0.4, "y_pct": 0.6, "subject": "the tavern door", "action": "it swings open"}
    res = client.post(
        "/animate",
        json={
            "image_data_url": "data:image/png;base64,x",
            "prompt": "The Copper Kettle",
            "focus": focus,
        },
    )
    assert res.status_code == 200
    assert res.json()["video_url"] == "https://fal.media/o.mp4"
    rewrite.assert_not_awaited()
    kwargs = animate.await_args.kwargs
    assert kwargs["object_action"] is True
    assert kwargs["prompt"].startswith("Focus on the tavern door, about 40% from the left and 60%")

    # A descent request keeps its own brief even if a focus rides along.
    animate.reset_mock()
    res = client.post(
        "/animate",
        json={
            "image_data_url": "data:image/png;base64,x",
            "end_image_data_url": "data:image/png;base64,y",
            "prompt": "The Copper Kettle",
            "focus": focus,
        },
    )
    assert res.status_code == 200
    kwargs = animate.await_args.kwargs
    assert kwargs["object_action"] is False
    assert kwargs["prompt"].startswith("Smooth cinematic camera descent")


# ── the shared camera-move prompt and leg length ────────────────────────────


def test_move_prompt_words_each_component_with_its_sign() -> None:
    text = video.move_prompt(orbit_deg=20, turn_deg=-15, rise_m=3, forward_m=4, subject="the inn")
    assert "forward about 4 metres" in text
    assert "circles about 20 degrees to its right around the inn" in text
    assert "turns about 15 degrees to the left" in text
    assert "rises about 3 metres" in text
    left = video.move_prompt(orbit_deg=-20, rise_m=-2, forward_m=-1.5)
    assert "to its left" in left and "sinks about 2 metres" in left and "back about 1.5" in left


def test_move_prompt_omits_zero_parts_and_keeps_the_fixed_tail() -> None:
    text = video.move_prompt(turn_deg=30, forward_m=0)
    assert "circles" not in text and "rises" not in text and "forward" not in text
    assert "turns about 30 degrees to the right" in text
    assert text.endswith(
        "Only the camera moves; every building, window, roof and the ground keep their exact "
        "appearance. One unbroken shot, no cuts, no people, no lettering."
    )
    # No metres known: the walk is qualitative, never a made-up distance.
    walk = video.move_prompt(subject="the well")
    assert "walks forward toward the well" in walk and "metres" not in walk


@pytest.mark.parametrize(
    ("planned", "expected"),
    [(1, 3), (2.75, 3), (2.857, 3), (3.0000001, 3), (4.8, 5), (12, 12), (40, 15)],
)
def test_leg_seconds_asks_for_the_planned_length_within_h3_limits(planned, expected) -> None:
    assert video.LEG_MIN_SECONDS == 3
    assert video.leg_seconds(planned) == expected
