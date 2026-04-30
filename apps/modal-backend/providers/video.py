"""Video animation providers.

Two paths:

- **Cheap path (default):** `fal-ai/ltx-video/image-to-video` — ~$0.02 for a
  5-second clip. Returns a full MP4 URL. No GPU on your side. Requires only
  `FAL_KEY`. This is what runs when the user has not deployed
  `ltx_stream.py`.

- **Pro path:** `fal-ai/ltx-2/image-to-video` — LTX-2, $0.06-0.24/s depending
  on resolution. Better quality, longer clips, higher cost.

For the true streaming path (self-hosted diffusers LTX on Modal with WS),
see `ltx_stream.py`.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

import fal_client

DEFAULT_ANIMATE_MODEL = "fal-ai/ltx-video/image-to-video"
PRO_ANIMATE_MODEL = "fal-ai/ltx-2/image-to-video"

# Video tier → fal model. Mirrors the image-tier pattern in providers/image.py.
# `balanced` defaults to Wan 2.2 i2v which has the best motion quality among
# fal-hosted open-weight i2v models as of 2026-04. Override with
# `FAL_VIDEO_TIER_BALANCED` to swap (e.g. for HunyuanVideo-I2V).
TIER_VIDEO_MODELS: dict[str, str] = {
    "fast": DEFAULT_ANIMATE_MODEL,
    "balanced": "fal-ai/wan-i2v",
    "pro": PRO_ANIMATE_MODEL,
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
    # Legacy USE_LTX_PRO toggle still honored when no explicit tier is passed.
    if tier is None and os.environ.get("USE_LTX_PRO", "").lower() in ("1", "true", "yes"):
        return PRO_ANIMATE_MODEL
    resolved = _resolve_video_tier(tier)
    env_key = TIER_VIDEO_ENV_KEYS[resolved]
    return os.environ.get(env_key) or TIER_VIDEO_MODELS[resolved]


async def _to_fal_url(image_data_url: str) -> str:
    """Convert an inline data URL to a fal storage URL.

    fal's queue endpoints can reject or stall on large data URLs (high-res
    seedream / nano-banana-pro outputs hit 1-3MB easily). Uploading to fal
    storage first sidesteps the limit and is what fal recommends.
    """
    if not image_data_url.startswith("data:"):
        return image_data_url  # already a URL — pass through
    header, _, b64 = image_data_url.partition(",")
    mime = "image/jpeg"
    if ";" in header and ":" in header:
        mime = header.split(":", 1)[1].split(";", 1)[0] or mime
    raw = base64.b64decode(b64)
    return await fal_client.upload_async(raw, content_type=mime)


async def animate_image(
    *,
    image_data_url: str,
    prompt: str,
    duration: int = 5,
    tier: str | None = None,
) -> AnimatedClip:
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")

    image_url = await _to_fal_url(image_data_url)
    model = _animate_model(tier)
    arguments: dict = {
        "image_url": image_url,
        "prompt": prompt,
    }
    if model == PRO_ANIMATE_MODEL:
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

    result = await fal_client.subscribe_async(model, arguments=arguments, with_logs=False)

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


def data_url_from_bytes(body: bytes, mime: str = "image/jpeg") -> str:
    b64 = base64.b64encode(body).decode("ascii")
    return f"data:{mime};base64,{b64}"
