"""fal-ai image generation — default `fal-ai/nano-banana`.

nano-banana (Gemini 2.5 Flash Image) is strong at rendering legible text inside
the illustration, which is the whole point of the Endless Canvas paradigm.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

import fal_client
import httpx

DEFAULT_IMAGE_MODEL = "fal-ai/nano-banana"


@dataclass
class GeneratedImage:
    jpeg_bytes: bytes
    mime_type: str
    model: str
    provider_request_id: str | None


def _ensure_fal_key() -> None:
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")


def _image_model() -> str:
    return os.environ.get("FAL_IMAGE_MODEL", DEFAULT_IMAGE_MODEL)


async def generate_image(prompt: str, aspect_ratio: str) -> GeneratedImage:
    """Synchronously-equivalent image gen — single final image, no progressive frames.

    fal's nano-banana is not progressive; we emit one SSE `final` event from
    the caller. If a future provider supports progressive refinement, add a
    streaming variant here.
    """
    _ensure_fal_key()
    model = _image_model()
    result = await fal_client.subscribe_async(
        model,
        arguments={"prompt": prompt, "aspect_ratio": aspect_ratio},
        with_logs=False,
    )
    image_info = _first_image(result)
    jpeg_bytes, mime = await _fetch_image_bytes(image_info)
    return GeneratedImage(
        jpeg_bytes=jpeg_bytes,
        mime_type=mime,
        model=model,
        provider_request_id=str(result.get("requestId") or "") or None,
    )


def encode_data_url(jpeg_bytes: bytes, mime_type: str = "image/jpeg") -> str:
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def _first_image(result: dict) -> dict:
    images = result.get("images") or []
    if not images:
        raise RuntimeError("fal returned no images")
    first = images[0]
    if not isinstance(first, dict):
        raise RuntimeError("fal image entry malformed")
    return first


async def _fetch_image_bytes(image_info: dict) -> tuple[bytes, str]:
    url = image_info.get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("fal image missing url")
    mime = str(image_info.get("content_type") or "image/jpeg")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content, mime
