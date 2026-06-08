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

import base64
import os
import struct
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


# --- Map-pan (expand outward) -------------------------------------------------

# BRIA Expand: seamless, pixel-preserving outpaint — the parent keeps its pixels,
# the new margin is painted to match. A bakeoff picked it over nano-banana /
# Kontext for "pan the world outward". Override with FAL_EXPAND_MODEL.
EXPAND_MODEL_DEFAULT = "fal-ai/bria/expand"
_EXPAND_GROW = 0.5  # extend by 50% of the parent in the chosen direction


def _expand_args_for(
    image_url: str, direction: str, width: int, height: int
) -> dict[str, Any]:
    """BRIA places the original on a larger canvas and paints the empty margin.
    `original_image_location` is the parent's top-left on that canvas."""
    gw, gh = int(width * _EXPAND_GROW), int(height * _EXPAND_GROW)
    if direction in ("east", "west"):
        canvas = [width + gw, height]
        loc = [0, 0] if direction == "east" else [gw, 0]
    else:  # north / south
        canvas = [width, height + gh]
        loc = [0, 0] if direction == "south" else [0, gh]
    return {
        "image_url": image_url,
        "canvas_size": canvas,
        "original_image_size": [width, height],
        "original_image_location": loc,
    }


def _img_dims(data: bytes) -> tuple[int, int] | None:
    """Read (width, height) straight from PNG/JPEG headers — Pillow isn't in the
    runtime, and BRIA needs the parent's REAL pixel size or it rescales (and
    seams) the original. Returns None for anything we can't measure."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return int(w), int(h)
    if data[:2] == b"\xff\xd8":  # JPEG: scan to the first SOF marker.
        i, n = 2, len(data)
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return int(w), int(h)
            if marker == 0xD8 or marker == 0xD9 or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
    return None


def _dims_from_data_url(data_url: str) -> tuple[int, int] | None:
    """Parent dims from a `data:` URL (the fresh in-session path). http(s) URLs
    fall back to the caller's width/height."""
    if not data_url.startswith("data:") or "," not in data_url:
        return None
    try:
        return _img_dims(base64.b64decode(data_url.split(",", 1)[1]))
    except Exception:
        return None


def _expand_first_image(result: dict[str, Any]) -> dict[str, Any]:
    """BRIA Expand answers with a singular `image` object; nano-banana-style
    models use `images: [...]`. Accept either."""
    image = result.get("image")
    if isinstance(image, dict):
        return image
    return _first_image(result)


async def expand_image(
    image_data_url: str,
    direction: str,
    width: int = 1600,
    height: int = 900,
    model_override: str | None = None,
) -> GeneratedImage:
    """Map-pan: outpaint the parent OUTWARD in `direction` (west/east/north/
    south) so 'expand' extends the same place seamlessly rather than blooming
    new subjects. Default BRIA Expand (bakeoff winner); FAL_EXPAND_MODEL override."""
    from obs import span

    _ensure_fal_key()
    model = (
        model_override
        or os.environ.get("FAL_EXPAND_MODEL")
        or EXPAND_MODEL_DEFAULT
    )
    # BRIA places the parent at its true size on the bigger canvas; a wrong size
    # rescales/seams it, so measure rather than trust the aspect-ratio default.
    w, h = _dims_from_data_url(image_data_url) or (width, height)
    image_url = await to_fal_url(image_data_url)
    async with span("image.expand", model=model, direction=direction, w=w, h=h) as ctx:
        result = await _fal_subscribe(
            model, _expand_args_for(image_url, direction, w, h)
        )
        image_info = _expand_first_image(result)
        jpeg_bytes, mime = await _fetch_image_bytes(image_info)
        ctx["bytes"] = len(jpeg_bytes)
    return GeneratedImage(
        jpeg_bytes=jpeg_bytes,
        mime_type=mime,
        model=model,
        provider_request_id=str(result.get("requestId") or "") or None,
    )
