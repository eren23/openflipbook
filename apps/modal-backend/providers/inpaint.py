"""Mask-scoped inpaint — the provider function MODEL_SLOTS["inpaint"] waited for.

The 2026-06-10 mask smoke (tests/edit_bench/mask_smoke.py) picked the model:
`fal-ai/flux-pro/v1/fill` is a TRUE compositor — pixels outside the mask come
back byte-identical (outside changed-fraction 0.0000) and source dims are
kept. gpt-image-2/edit ACCEPTS mask_url and honors none of the three mask
conventions (whole-canvas repaint), so there is no mask-honoring fallback:
callers degrade to the whole-image edit path on failure rather than pretend
gpt confines.

Wire mask convention (fill's native one): an opaque PNG at the source's dims,
WHITE = edit / inpaint, black = keep. Fill wants the prompt to DESCRIBE what
the masked region should contain (llm.polish_fill_description), not an edit
command. The gpt arg-shape branch below exists only so the edit-region bench
can A/B other models through the same call.
"""

from __future__ import annotations

from typing import Any

from ._common import to_fal_url
from .image import (
    GeneratedImage,
    _ensure_fal_key,
    _fal_subscribe,
    _fetch_image_bytes,
    _first_image,
)
from .model_router import resolve_model

INPAINT_MODEL_DEFAULT = "fal-ai/flux-pro/v1/fill"


def _inpaint_args_for(
    model: str, instruction: str, image_url: str, mask_url: str
) -> dict[str, Any]:
    # gpt-image-2/edit takes image_urls (list) + mask_url — bench arms only;
    # its mask is decorative (see the module docstring).
    if "gpt-image-2" in model:
        return {"prompt": instruction, "image_urls": [image_url], "mask_url": mask_url}
    # flux-pro/v1/fill (the slot default): image_url SINGULAR + mask_url, per
    # scripts/verify-fal-models.py.
    return {"prompt": instruction, "image_url": image_url, "mask_url": mask_url}


async def inpaint_image(
    image_data_url: str,
    mask_data_url: str,
    instruction: str,
    model_override: str | None = None,
) -> GeneratedImage:
    """Repaint ONLY the mask's white region of `image_data_url` so it shows
    what `instruction` describes. Default the `inpaint` slot (flux fill;
    FAL_INPAINT_MODEL override)."""
    from obs import span
    from providers import mock

    if mock.on():
        m = mock.mock_image(instruction, op="inpaint")
        return GeneratedImage(m.jpeg_bytes, m.mime_type, m.model, m.request_id)
    _ensure_fal_key()
    model = model_override or resolve_model("inpaint") or INPAINT_MODEL_DEFAULT
    image_url = await to_fal_url(image_data_url)
    mask_url = await to_fal_url(mask_data_url)
    async with span("image.inpaint", model=model, instr_len=len(instruction)) as ctx:
        result = await _fal_subscribe(
            model,
            _inpaint_args_for(model, instruction, image_url, mask_url),
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
