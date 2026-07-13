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


def _edit_args_for(
    model: str, instruction: str, image_url: str, style_ref_url: str | None = None
) -> dict[str, Any]:
    # nano-banana/edit + nano-banana-pro both take `image_urls` (list) — append
    # the style exemplar (when present) so the edit keeps the world's art medium.
    if "nano-banana" in model:
        urls = [image_url] + ([style_ref_url] if style_ref_url else [])
        return {"prompt": instruction, "image_urls": urls}
    # flux-pro/kontext takes `image_url` (singular) per fal schema — it can't take
    # a second ref, so the medium lock rides the polished instruction text instead.
    if "kontext" in model:
        return {"prompt": instruction, "image_url": image_url}
    # Reasonable default — mirror the nano-banana shape.
    urls = [image_url] + ([style_ref_url] if style_ref_url else [])
    return {"prompt": instruction, "image_urls": urls}


async def edit_image(
    image_data_url: str,
    instruction: str,
    tier: str | None = None,
    model_override: str | None = None,
    style_ref_url: str | None = None,
) -> GeneratedImage:
    from obs import span
    from providers import mock

    if mock.on():
        m = mock.mock_image(instruction, op="edit")
        return GeneratedImage(m.jpeg_bytes, m.mime_type, m.model, m.request_id)
    _ensure_fal_key()
    model = _resolve_edit_model(tier, model_override)
    image_url = await to_fal_url(image_data_url)
    # The style exemplar only helps the nano models (they accept a 2nd ref);
    # Kontext is singular-ref, so it leans on the instruction's medium clause.
    style_fal: str | None = None
    if style_ref_url and "nano-banana" in model:
        style_fal = await to_fal_url(style_ref_url)
    async with span("image.edit", model=model, instr_len=len(instruction)) as ctx:
        result = await _fal_subscribe(
            model,
            _edit_args_for(model, instruction, image_url, style_fal),
            require_images=True,
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
    *,
    style_anchor: str | None = None,
    view: dict | None = None,
    family: str | None = None,
    label_free: bool = False,
    register: str = "map",
    faithful: bool = False,
    redraw: bool = False,
) -> str:
    """Delegates to prompt_library.instructions (the body moved verbatim;
    view=None is byte-identical to the pre-grammar string — pinned by
    tests/test_image_continue.py + the frozen goldens). With a view, the
    keep-camera fragment is spelled per projection in PRESERVE form. redraw
    (SUBMAP_REDRAW) switches to the fresh re-render wording."""
    from typing import cast

    from providers.prompt_library import instructions as _instructions
    from providers.prompt_library.types import ViewSpec as _ViewSpec

    return _instructions.build_zoom_instruction(
        page_title,
        facts,
        layout_clause,
        style_anchor=style_anchor,
        view=cast("_ViewSpec | None", view),
        family=family,
        label_free=label_free,
        register=register,
        faithful=faithful,
        redraw=redraw,
    )


def build_enter_instruction(
    page_title: str,
    facts: list[str],
    *,
    style_anchor: str | None = None,
    subject_context: str | None = None,
    surroundings: str | None = None,
    layout_clause: str = "",
    view: dict | None = None,
    family: str | None = None,
    style_ref: bool = False,
    surroundings_pov: bool = False,
    surroundings_behind: str | None = None,
    interior: bool = False,
    exterior_appearance: str | None = None,
) -> str:
    """Delegates to prompt_library.instructions (the body moved verbatim;
    view=None is byte-identical to the pre-grammar string). With a view, the
    research/10 per-family skeleton applies — the hardcoded "ground level"
    dies and the deliberate projection (eye_level / oblique / isometric /
    top_down plan) is named instead. interior (INTERIOR_ENTERS) flips every
    variant to the INDOOR register; False stays byte-identical."""
    from typing import cast

    from providers.prompt_library import instructions as _instructions
    from providers.prompt_library.types import ViewSpec as _ViewSpec

    return _instructions.build_enter_instruction(
        page_title,
        facts,
        style_anchor=style_anchor,
        subject_context=subject_context,
        surroundings=surroundings,
        layout_clause=layout_clause,
        view=cast("_ViewSpec | None", view),
        family=family,
        style_ref=style_ref,
        surroundings_pov=surroundings_pov,
        surroundings_behind=surroundings_behind,
        interior=interior,
        exterior_appearance=exterior_appearance,
    )


async def continue_image(
    image_data_url: str,
    instruction: str,
    model_override: str | None = None,
) -> GeneratedImage:
    """Zoom-continue `image_data_url` per `instruction`, keeping its content,
    style and layout — a closer continuation rather than a fresh generation.
    Default FLUX Kontext (bakeoff winner); FAL_CONTINUE_MODEL override."""
    from obs import span
    from providers import mock

    if mock.on():
        m = mock.mock_image(instruction, op="zoom")
        return GeneratedImage(m.jpeg_bytes, m.mime_type, m.model, m.request_id)
    _ensure_fal_key()
    model = (
        model_override
        or os.environ.get("FAL_CONTINUE_MODEL")
        or CONTINUE_MODEL_DEFAULT
    )
    image_url = await to_fal_url(image_data_url)
    async with span("image.continue", model=model, instr_len=len(instruction)) as ctx:
        result = await _fal_subscribe(
            model, _edit_args_for(model, instruction, image_url), require_images=True
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
            model, _expand_args_for(image_url, direction, w, h), require_images=True
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


# B2 OUTWARD: per-hop visual-zoom clamp. The metric span follows the scale ladder
# independently; a big metric jump inserts intermediate rungs upstream rather than
# cramming many orders of magnitude into one outpaint.
_ZOOMOUT_FACTOR_MIN = 1.5
_ZOOMOUT_FACTOR_MAX = 4.0


def _clamp_zoom_factor(factor: float) -> float:
    return max(_ZOOMOUT_FACTOR_MIN, min(_ZOOMOUT_FACTOR_MAX, factor))


def _zoomout_args_for(
    image_url: str, factor: float, width: int, height: int, prompt: str | None = None
) -> dict[str, Any]:
    """OUTWARD: the source CENTERED on a `factor`x larger canvas, full margin
    painted on ALL sides — so it becomes the recognizable central sub-region of a
    wider view of the same world. Contrast `_expand_args_for`, which pins the
    original to one EDGE for a directional map-pan.

    `prompt` STEERS the painted margin: WITHOUT it BRIA fills photorealistically,
    so a hand-drawn map ends up an engraving poster floating in a real sea. Passing
    the source's medium keeps the margin in-style (it still leaves a soft seam at
    the source rectangle — the fresh `scale_parent` path is the seamless default)."""
    cw, ch = int(width * factor), int(height * factor)
    loc = [(cw - width) // 2, (ch - height) // 2]
    args: dict[str, Any] = {
        "image_url": image_url,
        "canvas_size": [cw, ch],
        "original_image_size": [width, height],
        "original_image_location": loc,
    }
    if prompt and prompt.strip():
        args["prompt"] = prompt.strip()
    return args


async def expand_image_zoomout(
    image_data_url: str,
    factor: float = 3.0,
    width: int = 1600,
    height: int = 900,
    model_override: str | None = None,
    prompt: str | None = None,
) -> GeneratedImage:
    """OUTWARD / zoom-out (B2): paint the CONTAINER around the source — the source
    centered on a `factor`x larger canvas with the full margin outpainted, so it
    becomes the central sub-region of a wider frame. The source's pixels are kept,
    but the painted MARGIN drifts to photoreal unless `prompt` carries the source's
    medium — so callers MUST pass it. Same BRIA machinery as `expand_image`; only
    the canvas is centered, not edge-pinned. `factor` is clamped to ~1.5-4x. This is
    the opt-in (SCALE_OUTWARD_OUTPAINT) path; the seamless default is `scale_parent`."""
    from obs import span

    _ensure_fal_key()
    model = (
        model_override
        or os.environ.get("FAL_OUTPAINT_MODEL")
        or EXPAND_MODEL_DEFAULT
    )
    f = _clamp_zoom_factor(factor)
    # BRIA needs the parent's REAL pixel size or it rescales/seams the original.
    w, h = _dims_from_data_url(image_data_url) or (width, height)
    image_url = await to_fal_url(image_data_url)
    async with span("image.zoomout", model=model, factor=f, w=w, h=h) as ctx:
        result = await _fal_subscribe(
            model, _zoomout_args_for(image_url, f, w, h, prompt), require_images=True
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
