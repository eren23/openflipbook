"""fal-ai text-driven image editing with quality tiers.

Mirrors the tier shape in `image.py`. Edit models on fal expect an
`image_url` (http(s) or fal storage URL). We upload the user-supplied
data URL to fal storage first — fal's queue endpoints get unhappy with
multi-MB inline data URLs.

Standalone fal-ai/qwen-image-edit inference is no longer published (only the
LoRA trainer remains as of 2026-04), so the balanced slot reuses
nano-banana-pro which handles both gen and edit on the same endpoint.
"""

from __future__ import annotations

import base64
import os
from typing import Any

import fal_client

from .image import GeneratedImage, _ensure_fal_key, _fetch_image_bytes, _first_image

EDIT_TIER_MODELS: dict[str, str] = {
    "fast":     "fal-ai/nano-banana/edit",
    "balanced": "fal-ai/nano-banana-pro",
    "pro":      "fal-ai/flux-pro/kontext",
}
EDIT_TIER_ENV_KEYS: dict[str, str] = {
    "fast":     "FAL_EDIT_MODEL_FAST",
    "balanced": "FAL_EDIT_MODEL_BALANCED",
    "pro":      "FAL_EDIT_MODEL_PRO",
}
DEFAULT_EDIT_TIER = "balanced"


def _resolve_edit_tier(tier: str | None) -> str:
    candidate = (tier or os.environ.get("FAL_EDIT_TIER") or DEFAULT_EDIT_TIER).lower()
    if candidate not in EDIT_TIER_MODELS:
        return DEFAULT_EDIT_TIER
    return candidate


def _resolve_edit_model(tier: str | None, model_override: str | None) -> str:
    if model_override:
        return model_override
    resolved = _resolve_edit_tier(tier)
    env_key = EDIT_TIER_ENV_KEYS[resolved]
    return os.environ.get(env_key) or EDIT_TIER_MODELS[resolved]


def _edit_args_for(model: str, instruction: str, image_url: str) -> dict[str, Any]:
    # nano-banana/edit + nano-banana-pro both take `image_urls` (list).
    if "nano-banana" in model:
        return {"prompt": instruction, "image_urls": [image_url]}
    # flux-pro/kontext takes `image_url` (singular) per fal schema.
    if "kontext" in model:
        return {"prompt": instruction, "image_url": image_url}
    # Reasonable default — mirror the nano-banana shape.
    return {"prompt": instruction, "image_urls": [image_url]}


async def _to_fal_url(image_data_url: str) -> str:
    if not image_data_url.startswith("data:"):
        return image_data_url
    header, _, b64 = image_data_url.partition(",")
    mime = "image/jpeg"
    if ";" in header and ":" in header:
        mime = header.split(":", 1)[1].split(";", 1)[0] or mime
    raw = base64.b64decode(b64)
    return await fal_client.upload_async(raw, content_type=mime)


async def edit_image(
    image_data_url: str,
    instruction: str,
    tier: str | None = None,
    model_override: str | None = None,
) -> GeneratedImage:
    _ensure_fal_key()
    model = _resolve_edit_model(tier, model_override)
    image_url = await _to_fal_url(image_data_url)
    result = await fal_client.subscribe_async(
        model,
        arguments=_edit_args_for(model, instruction, image_url),
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
