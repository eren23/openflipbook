"""Video animation providers.

Every tier runs fal's MiniMax H3: fast = `h3-max-turbo` at 768P, balanced =
`h3-max` at 768P, pro = `h3-max` at 1080P. H3 bills per second (see
providers/spend.py). Descent clips (first + last frame) use `h3-max` too.
`camera_controls()` calls `minimax/h3-max/camera-controls`, which moves the
camera along a set trajectory and keeps the scene still.

The older LTX and Wan slugs stay reachable through the env overrides, with
their own argument shapes.

For the true streaming path (self-hosted diffusers LTX on Modal with WS),
see `ltx_stream.py`.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

from ._common import to_fal_url
from .image import _fal_subscribe

H3_MAX_MODEL = "minimax/h3-max/image-to-video"
H3_TURBO_MODEL = "minimax/h3-max-turbo/image-to-video"
H3_CAMERA_MODEL = "minimax/h3-max/camera-controls"
DEFAULT_ANIMATE_MODEL = H3_MAX_MODEL
# LTX-2 takes string enums for duration and resolution (see animate_image).
LTX2_ANIMATE_MODEL = "fal-ai/ltx-2/image-to-video"
# First+last-frame DESCENT clips (the tap hard-cut becomes a camera move):
# start = the parent map, end = the entered page. 2026-08-23 probe: H3 Max and
# ltx-2.3 fast both honour `end_image_url` and land square on the arrival
# frame in-style (docs/research/12). Descent has its OWN slot
# (FAL_DESCENT_MODEL). The tier table and the FAL_ANIMATE_MODEL override stay
# ambient-only, because a model without end_image_url support would silently
# drop the arrival frame.
DESCENT_ANIMATE_MODEL = H3_MAX_MODEL
# The LTX arm of the research 12 bench, and the cheaper descent override.
LTX_DESCENT_MODEL = "fal-ai/ltx-2.3/image-to-video/fast"


def is_h3(model: str) -> bool:
    return model.startswith("minimax/h3-")


def _h3_seconds(model: str, duration: int) -> int:
    """H3 clips run 5 to 15 s. Camera-controls clips can be 3 s."""
    floor = 3 if model.endswith("/camera-controls") else 5
    return max(floor, min(15, int(duration)))


def h3_arguments(
    model: str,
    image_url: str,
    prompt: str,
    duration: int,
    *,
    resolution: str = "768P",
    end_image_url: str | None = None,
) -> dict:
    """The fields every `minimax/h3-` endpoint takes.

    `resolution` is "480P", "768P" or "1080P". fal refuses a call without
    `prompt_expansion_mode`.
    """
    arguments: dict = {
        "image_url": image_url,
        "prompt": prompt,
        "duration": _h3_seconds(model, duration),
        "resolution": resolution,
        "prompt_expansion_mode": "balanced",
    }
    if not model.endswith("/camera-controls"):
        # Probed on image-to-video (research 12). Camera-controls does not
        # list it, so it does not get it.
        arguments["enable_safety_checker"] = True
    if end_image_url:
        arguments["end_image_url"] = end_image_url
    return arguments


def descent_arguments(
    model: str, image_url: str, end_image_url: str, prompt: str, duration: int
) -> dict:
    """Keep endpoint-specific fields out of the ambient animation route."""
    if is_h3(model):
        return h3_arguments(model, image_url, prompt, duration, end_image_url=end_image_url)
    return {"image_url": image_url, "end_image_url": end_image_url, "prompt": prompt}


def object_action_prompt(subject: str, action: str, x_pct: float, y_pct: float) -> str:
    """Anchor a clip on ONE tapped object. H3 has no mask input, so the
    object's name and its position in the frame are the only steering."""
    subject = " ".join(subject.split())[:120] or "the tapped object"
    action = " ".join(action.split()).rstrip(".")[:300]
    return (
        f"Focus on {subject}, about {round(x_pct * 100)}% from the left and "
        f"{round(y_pct * 100)}% from the top of the frame. "
        f"{action or f'{subject} comes to life with clear, natural motion'}. "
        "The camera eases slowly toward it. The rest of the illustrated scene "
        "stays calm and keeps its drawing style, layout and colors. "
        "One continuous shot, no cuts; add nothing the action does not need."
    )


# Measured 2026-10-02 on the four Lantern Quay walk legs (route-video seg0-3):
# motion fades below 0.3 MAD at 4.2-4.5 s of 5.17 s; 0.58 was the map-to-inn
# descent clip (research 33 F4); see docs/research/36. Tunable.
LEG_MOTION_SHARE = 0.8


def leg_seconds(planned: float) -> int:
    """The H3 duration to ask for so the move itself lasts `planned` seconds.

    The frozen tail is trimmed afterwards (web side). fal takes whole seconds,
    1-15 (schema checked 2026-10-02); 5 is this file's H3 floor."""
    return max(5, min(15, math.ceil(round(planned / LEG_MOTION_SHARE, 6))))


def _side(value: float) -> str:
    return "right" if value > 0 else "left"


def move_prompt(
    *,
    orbit_deg: float = 0,
    turn_deg: float = 0,
    rise_m: float = 0,
    forward_m: float | None = None,
    subject: str | None = None,
) -> str:
    """One continuous camera move, in words.

    A positive orbit circles the camera to its own right around the subject; a
    positive turn pans right; a positive rise lifts it. `forward_m=None` is a
    walk of unknown length (the /play walk has no metres). Parts that round to
    zero are left out.
    """
    subject = " ".join((subject or "").split())[:120]
    parts: list[str] = []
    if forward_m is None:
        parts.append("walks forward")
    elif round(forward_m, 1):
        way = "forward" if forward_m > 0 else "back"
        parts.append(f"moves {way} about {abs(round(forward_m, 1)):g} metres")
    if round(orbit_deg):
        around = subject or "the subject"
        parts.append(
            f"circles about {abs(round(orbit_deg))} degrees to its {_side(orbit_deg)} around {around}"
        )
    if round(turn_deg):
        parts.append(f"turns about {abs(round(turn_deg))} degrees to the {_side(turn_deg)}")
    if round(rise_m, 1):
        way = "rises" if rise_m > 0 else "sinks"
        parts.append(f"{way} about {abs(round(rise_m, 1)):g} metres")
    if subject and parts and not round(orbit_deg):
        parts[0] += f" toward {subject}"
    move = (
        "holds still"
        if not parts
        else parts[0]
        if len(parts) == 1
        else ", ".join(parts[:-1]) + " and " + parts[-1]
    )
    return (
        f"One continuous shot: the camera {move}. Only the camera moves; every building, "
        "window, roof and the ground keep their exact appearance. One unbroken shot, no cuts, "
        "no people, no lettering."
    )


# Video tier → fal model and its H3 resolution. Mirrors the image-tier pattern
# in providers/image.py. `FAL_VIDEO_TIER_<TIER>` swaps one tier's slug.
TIER_VIDEO_MODELS: dict[str, str] = {
    "fast": H3_TURBO_MODEL,
    "balanced": DEFAULT_ANIMATE_MODEL,
    "pro": H3_MAX_MODEL,
}

TIER_VIDEO_RESOLUTIONS: dict[str, str] = {
    "fast": "768P",
    "balanced": "768P",
    "pro": "1080P",
}

TIER_VIDEO_ENV_KEYS: dict[str, str] = {
    "fast": "FAL_VIDEO_TIER_FAST",
    "balanced": "FAL_VIDEO_TIER_BALANCED",
    "pro": "FAL_VIDEO_TIER_PRO",
}

DEFAULT_VIDEO_TIER = "fast"


@dataclass
class AnimatedClip:
    video_url: str
    content_type: str
    model: str
    duration_seconds: float


def _resolve_video_tier(tier: str | None) -> str:
    candidate = (tier or os.environ.get("FAL_VIDEO_TIER") or DEFAULT_VIDEO_TIER).lower()
    if candidate not in TIER_VIDEO_MODELS:
        return DEFAULT_VIDEO_TIER
    return candidate


def _animate_model(tier: str | None = None) -> str:
    override = os.environ.get("FAL_ANIMATE_MODEL", "").strip()
    if override:
        return override
    resolved = _resolve_video_tier(tier)
    env_key = TIER_VIDEO_ENV_KEYS[resolved]
    return os.environ.get(env_key) or TIER_VIDEO_MODELS[resolved]


def clip_model(tier: str | None = None, *, descent: bool = False, action: bool = False) -> str:
    """The slug animate_image calls for this request."""
    if descent:
        return os.environ.get("FAL_DESCENT_MODEL") or DESCENT_ANIMATE_MODEL
    if action:
        # A tapped-object clip needs a model that follows a focused action
        # prompt, so an ambient override must not capture it.
        return os.environ.get("FAL_ACTION_MODEL") or H3_MAX_MODEL
    return _animate_model(tier)


def estimate_usd(
    duration: int, tier: str | None = None, *, descent: bool = False, action: bool = False
) -> float:
    """What animate_image bills for this request, before it runs."""
    from . import spend

    model = clip_model(tier, descent=descent, action=action)
    seconds = _h3_seconds(model, duration) if is_h3(model) else duration
    # Descent and action clips ride h3_arguments' default resolution.
    fixed = descent or action
    resolution = "768P" if fixed else TIER_VIDEO_RESOLUTIONS[_resolve_video_tier(tier)]
    return spend.estimate_video(model, seconds, resolution)


async def animate_image(
    *,
    image_data_url: str,
    prompt: str,
    duration: int = 5,
    tier: str | None = None,
    end_image_data_url: str | None = None,
    object_action: bool = False,
) -> AnimatedClip:
    from obs import span

    from . import mock

    # Same gate as every image op (the #184 lesson: one ungated fal entry
    # point is enough for a "mock" stack to bill real money).
    if mock.on():
        return AnimatedClip(
            video_url=mock.mock_video_data_url(),
            content_type="video/mp4",
            model="mock/animate",
            duration_seconds=1.0,
        )
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")

    image_url = await to_fal_url(image_data_url)
    if end_image_data_url:
        # Descent transition: dedicated slot, no tier/override routing (see
        # DESCENT_ANIMATE_MODEL). LTX keeps its probed schema defaults; H3
        # gets its own duration and required fields.
        model = clip_model(descent=True)
        arguments = descent_arguments(
            model, image_url, await to_fal_url(end_image_data_url), prompt, duration
        )
        async with span("video.animate", model=model, duration=duration):
            result = await _fal_subscribe(model, arguments)
        return _clip_from_result(result, model, arguments.get("duration", duration))
    if object_action:
        # Tapped-object clip: its own slot, never the ambient tier table.
        model = clip_model(action=True)
        arguments = (
            h3_arguments(model, image_url, prompt, duration)
            if is_h3(model)
            else {"image_url": image_url, "prompt": prompt}
        )
        async with span("video.animate", model=model, duration=duration):
            result = await _fal_subscribe(model, arguments)
        return _clip_from_result(result, model, arguments.get("duration", duration))
    model = clip_model(tier)
    arguments = {
        "image_url": image_url,
        "prompt": prompt,
    }
    if is_h3(model):
        resolution = TIER_VIDEO_RESOLUTIONS[_resolve_video_tier(tier)]
        arguments = h3_arguments(model, image_url, prompt, duration, resolution=resolution)
        duration = arguments["duration"]
    elif model == LTX2_ANIMATE_MODEL:
        # LTX-2's schema is a STRING enum on duration/resolution/fps —
        # passing int 5 (or even int 6) makes fal's validator 502 the request
        # with a confusingly generic error. Snap to {6, 8, 10} and stringify.
        snapped = 6 if duration <= 6 else 8 if duration <= 8 else 10
        arguments["duration"] = str(snapped)
        arguments["resolution"] = os.environ.get("LTX_PRO_RESOLUTION", "1080p")
    elif "wan" in model.lower():
        # Wan i2v on fal accepts duration via num_frames; default 5s @ 16fps.
        arguments["num_frames"] = max(16, min(duration * 16, 96))
        arguments["resolution"] = os.environ.get("WAN_RESOLUTION", "720p")

    async with span("video.animate", model=model, duration=duration):
        result = await _fal_subscribe(model, arguments)
    return _clip_from_result(result, model, duration)


async def camera_controls(
    image_data_url: str,
    prompt: str,
    trajectory: list[dict],
    duration: int,
    resolution: str = "768P",
) -> AnimatedClip:
    """One H3 camera-controls clip: the scene stays still, the camera moves.

    Each `trajectory` point is {time 0-1, azimuth deg, elevation deg -90..90,
    distance}. There is no end frame.
    """
    from obs import span

    from . import mock

    if mock.on():
        return AnimatedClip(
            video_url=mock.mock_video_data_url(),
            content_type="video/mp4",
            model="mock/camera-controls",
            duration_seconds=1.0,
        )
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")

    model = H3_CAMERA_MODEL
    arguments = h3_arguments(
        model, await to_fal_url(image_data_url), prompt, duration, resolution=resolution
    )
    arguments["camera_trajectory"] = trajectory
    async with span("video.camera_controls", model=model, duration=arguments["duration"]):
        result = await _fal_subscribe(model, arguments)
    return _clip_from_result(result, model, arguments["duration"])


def _clip_from_result(result: dict, model: str, duration: int) -> AnimatedClip:
    video = result.get("video")
    if not isinstance(video, dict):
        raise RuntimeError(f"fal animate returned no video payload: {result!r:.300}")
    url = video.get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("fal animate returned video without url")
    content_type = str(video.get("content_type") or "video/mp4")
    duration_s = float(video.get("duration") or duration or 5)

    return AnimatedClip(
        video_url=url,
        content_type=content_type,
        model=model,
        duration_seconds=duration_s,
    )
