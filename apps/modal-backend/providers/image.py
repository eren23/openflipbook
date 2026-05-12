"""Image generation providers.

Hosted deployments use fal.ai by default. Local Docker/Ollama deployments can
set IMAGE_PROVIDER=local to render a deterministic explainer card without any
external image-generation API. This keeps the Flipbook interaction loop usable
on a fully local stack while the LLM planner still comes from Ollama.
"""

from __future__ import annotations

import base64
import io
import os
import textwrap
from dataclasses import dataclass
from typing import Any

import fal_client
import httpx
from PIL import Image, ImageDraw, ImageFont
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

TIER_MODELS: dict[str, str] = {
    "fast": "fal-ai/nano-banana",
    "balanced": "fal-ai/nano-banana-pro",
    "pro": "fal-ai/bytedance/seedream/v4/text-to-image",
}
TIER_ENV_KEYS: dict[str, str] = {
    "fast": "FAL_IMAGE_MODEL_FAST",
    "balanced": "FAL_IMAGE_MODEL_BALANCED",
    "pro": "FAL_IMAGE_MODEL_PRO",
}
DEFAULT_TIER = "balanced"

SEEDREAM_SIZE_MAP: dict[str, str] = {
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
    "1:1": "square_hd",
    "4:3": "landscape_4_3",
    "3:4": "portrait_4_3",
}


@dataclass
class GeneratedImage:
    jpeg_bytes: bytes
    mime_type: str
    model: str
    provider_request_id: str | None


def _provider() -> str:
    return os.environ.get("IMAGE_PROVIDER", "fal").strip().lower()


def _ensure_fal_key() -> None:
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")


def _resolve_tier(tier: str | None) -> str:
    candidate = (tier or os.environ.get("FAL_IMAGE_TIER") or DEFAULT_TIER).lower()
    if candidate not in TIER_MODELS:
        return DEFAULT_TIER
    return candidate


def _resolve_model(tier: str | None, model_override: str | None) -> str:
    if model_override:
        return model_override
    resolved_tier = _resolve_tier(tier)
    env_key = TIER_ENV_KEYS[resolved_tier]
    legacy = os.environ.get("FAL_IMAGE_MODEL")
    return os.environ.get(env_key) or legacy or TIER_MODELS[resolved_tier]


def _args_for(model: str, prompt: str, aspect_ratio: str) -> dict[str, Any]:
    if "seedream" in model:
        return {
            "prompt": prompt,
            "image_size": SEEDREAM_SIZE_MAP.get(aspect_ratio, "landscape_16_9"),
        }
    return {"prompt": prompt, "aspect_ratio": aspect_ratio}


async def generate_image(
    prompt: str,
    aspect_ratio: str,
    tier: str | None = None,
    model_override: str | None = None,
) -> GeneratedImage:
    from obs import span

    if _provider() == "local":
        async with span("image.generate", model="local-card", prompt_len=len(prompt)) as ctx:
            jpeg_bytes = _render_local_card(prompt, aspect_ratio)
            ctx["bytes"] = len(jpeg_bytes)
        return GeneratedImage(
            jpeg_bytes=jpeg_bytes,
            mime_type="image/jpeg",
            model="local-card",
            provider_request_id=None,
        )

    _ensure_fal_key()
    model = _resolve_model(tier, model_override)
    async with span("image.generate", model=model, prompt_len=len(prompt)) as ctx:
        result = await _fal_subscribe(model, _args_for(model, prompt, aspect_ratio))
        image_info = _first_image(result)
        jpeg_bytes, mime = await _fetch_image_bytes(image_info)
        ctx["bytes"] = len(jpeg_bytes)
    return GeneratedImage(
        jpeg_bytes=jpeg_bytes,
        mime_type=mime,
        model=model,
        provider_request_id=str(result.get("requestId") or "") or None,
    )


def encode_data_url(jpeg_bytes: bytes, mime_type: str = "image/jpeg") -> str:
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def _render_local_card(prompt: str, aspect_ratio: str) -> bytes:
    width, height = _dimensions_for(aspect_ratio)
    img = Image.new("RGB", (width, height), "#f7f2e8")
    draw = ImageDraw.Draw(img)
    title_font = _font(44)
    body_font = _font(24)
    small_font = _font(18)

    draw.rounded_rectangle((28, 28, width - 28, height - 28), radius=34, fill="#fffaf0", outline="#1f2937", width=3)
    draw.rectangle((28, 28, width - 28, 110), fill="#111827")
    draw.text((56, 50), "Local Flipbook / Ollama", fill="#ffffff", font=title_font)

    wrapped = textwrap.wrap(prompt.strip() or "Generated local explainer", width=70)[:10]
    y = 145
    for line in wrapped:
        draw.text((64, y), line, fill="#111827", font=body_font)
        y += 34

    boxes = [
        (64, height - 210, 360, height - 78, "Planner", "Ollama text model"),
        (410, height - 210, 706, height - 78, "Renderer", "Local image card"),
        (756, height - 210, width - 64, height - 78, "Click", "Ollama vision fallback"),
    ]
    for x1, y1, x2, y2, heading, desc in boxes:
        draw.rounded_rectangle((x1, y1, x2, y2), radius=22, fill="#e0f2fe", outline="#0284c7", width=2)
        draw.text((x1 + 22, y1 + 24), heading, fill="#0f172a", font=body_font)
        draw.text((x1 + 22, y1 + 68), desc, fill="#334155", font=small_font)

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue()


def _dimensions_for(aspect_ratio: str) -> tuple[int, int]:
    if aspect_ratio == "1:1":
        return 1024, 1024
    if aspect_ratio == "9:16":
        return 720, 1280
    if aspect_ratio == "4:3":
        return 1200, 900
    if aspect_ratio == "3:4":
        return 900, 1200
    return 1280, 720


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _first_image(result: dict) -> dict:
    images = result.get("images") or []
    if not images:
        raise RuntimeError("fal returned no images")
    first = images[0]
    if not isinstance(first, dict):
        raise RuntimeError("fal image entry malformed")
    return first


_HTTPX: httpx.AsyncClient | None = None


def _http_client() -> httpx.AsyncClient:
    global _HTTPX
    if _HTTPX is None or _HTTPX.is_closed:
        _HTTPX = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50),
        )
    return _HTTPX


async def _fetch_image_bytes(image_info: dict) -> tuple[bytes, str]:
    url = image_info.get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("fal image missing url")
    mime = str(image_info.get("content_type") or "image/jpeg")
    resp = await _http_client().get(url)
    resp.raise_for_status()
    return resp.content, mime


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, fal_client.FalClientHTTPError):
        code = exc.status_code
        return code == 429 or 500 <= code < 600
    if isinstance(exc, fal_client.FalClientTimeoutError):
        return True
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return code == 429 or 500 <= code < 600
    return False


async def _fal_subscribe(model: str, arguments: dict) -> dict:
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    ):
        with attempt:
            return await fal_client.subscribe_async(
                model, arguments=arguments, with_logs=False
            )
    raise RuntimeError("unreachable")
