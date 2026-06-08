"""fal-ai text-driven image editing with quality tiers.

Mirrors the tier shape in `image.py`. Edit models on fal expect an
`image_url` (http(s) or fal storage URL). We upload the user-supplied
data URL to fal storage first — fal's queue endpoints get unhappy with
multi-MB inline data URLs.

fal-ai doesn't publish standalone qwen-image-edit inference (only the LoRA
trainer, as of 2026-04), so the balanced slot reuses nano-banana-pro, which
handles both gen and edit on the same endpoint.
"""

from __future__ import annotations

import os
from typing import Any

from ._common import to_fal_url
from .image import (
    GeneratedImage,
    _ensure_fal_key,
    _fal_subscribe,
    _fetch_image_bytes,
    _first_image,
)

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


async def edit_image(
    image_data_url: str,
    instruction: str,
    tier: str | None = None,
    model_override: str | None = None,
) -> GeneratedImage:
    from obs import span

    _ensure_fal_key()
    model = _resolve_edit_model(tier, model_override)
    image_url = await to_fal_url(image_data_url)
    async with span("image.edit", model=model, instr_len=len(instruction)) as ctx:
        result = await _fal_subscribe(
            model,
            _edit_args_for(model, instruction, image_url),
        )
        image_info = _first_image(result)
        jpeg_bytes, mime = await _fetch_image_bytes(image_info)
        ctx["bytes"] = len(jpeg_bytes)
    return GeneratedImage(
        jpeg_bytes=jpeg_bytes,
        mime_type=mime,
        model=model,
        provider_request_id=str(result.get("requestId") or "") or None,
    )


# --- Continuation (zoom-in that keeps the surroundings) ----------------------

# FLUX Kontext: strict in-context reference editing — a bakeoff picked it for a
# ZOOM continuation that keeps the parent's content/style/layout (vs nano-banana
# which treats refs as loose inspiration). Used for World Mode sub-map entries so
# a closer map literally continues the click region. Override FAL_CONTINUE_MODEL.
CONTINUE_MODEL_DEFAULT = "fal-ai/flux-pro/kontext"


def build_zoom_instruction(
    page_title: str,
    facts: list[str],
    layout_clause: str = "",
) -> str:
    """Compose the Kontext zoom instruction from what the system already knows.

    The reference crop carries the *look* (walls, palette, layout); this text
    carries the *content* the crop can't — the named sub-areas the planner found
    inside (`facts`) and the geometry engine's placement clause — so the zoom
    ELABORATES the place in finer detail instead of dumb-zooming the pixels.
    Faithful-but-enhanced: keep the existing structures and style, reveal more
    within them. Empty facts/clause (first enter, nothing seeded) degrade to a
    plain faithful zoom — no dangling enumeration.
    """
    title = page_title.strip() or "this place"
    text = (
        f'Zoom into "{title}" — the area at the centre of this image — and draw a '
        "closer, richer map of it. Keep the exact walls, buildings, towers and "
        "landmarks the reference already shows, in the same hand-drawn engraving "
        "style, palette and line work, from the SAME overhead map viewpoint; do "
        "not reinvent them, restyle them, or switch to an eye-level or interior "
        "view. As you move closer, elaborate them with finer architectural detail"
    )
    named = [f.strip() for f in facts if f and f.strip()]
    if named:
        # Worked in as features the map should SHOW, not text to write — Kontext
        # renders label text as garble, and "label these" drags it into an
        # interior scene. Atmospheric prose stays mood/detail, not a caption.
        text += ", working in the features that belong here: " + "; ".join(named[:8])
    text += (
        ". A closer, faithful continuation of this exact map, not a new scene. "
        "Keep any lettering sparse and legible — no garbled text."
    )
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


async def continue_image(
    image_data_url: str,
    instruction: str,
    model_override: str | None = None,
) -> GeneratedImage:
    """Zoom-continue `image_data_url` per `instruction`, keeping its content,
    style and layout — a closer continuation rather than a fresh generation.
    Default FLUX Kontext (bakeoff winner); FAL_CONTINUE_MODEL override."""
    from obs import span

    _ensure_fal_key()
    model = (
        model_override
        or os.environ.get("FAL_CONTINUE_MODEL")
        or CONTINUE_MODEL_DEFAULT
    )
    image_url = await to_fal_url(image_data_url)
    async with span("image.continue", model=model, instr_len=len(instruction)) as ctx:
        result = await _fal_subscribe(
            model, _edit_args_for(model, instruction, image_url)
        )
        image_info = _first_image(result)
        jpeg_bytes, mime = await _fetch_image_bytes(image_info)
        ctx["bytes"] = len(jpeg_bytes)
    return GeneratedImage(
        jpeg_bytes=jpeg_bytes,
        mime_type=mime,
        model=model,
        provider_request_id=str(result.get("requestId") or "") or None,
    )
