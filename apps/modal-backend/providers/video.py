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


@dataclass
class AnimatedClip:
    video_url: str
    content_type: str
    model: str
    duration_seconds: float


def _animate_model() -> str:
    override = os.environ.get("FAL_ANIMATE_MODEL", "").strip()
    if override:
        return override
    if os.environ.get("USE_LTX_PRO", "").lower() in ("1", "true", "yes"):
        return PRO_ANIMATE_MODEL
    return DEFAULT_ANIMATE_MODEL


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
) -> AnimatedClip:
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")

    image_url = await _to_fal_url(image_data_url)
    model = _animate_model()
    arguments: dict = {
        "image_url": image_url,
        "prompt": prompt,
    }
    if model == PRO_ANIMATE_MODEL:
        arguments["duration"] = duration
        arguments["resolution"] = os.environ.get("LTX_PRO_RESOLUTION", "1080p")

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
