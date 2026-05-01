"""Shared helpers across image, image_edit, video providers.

Kept tiny on purpose — only consolidates patterns that were duplicated.
"""

from __future__ import annotations

import base64

import fal_client


async def to_fal_url(image_data_url: str) -> str:
    """Convert an inline data URL to a fal storage URL.

    fal's queue endpoints can reject or stall on large data URLs (high-res
    seedream / nano-banana-pro outputs hit 1-3MB easily). Uploading to fal
    storage first sidesteps the limit and is what fal recommends. Pass-through
    if the input already looks like an http(s) URL.
    """
    if not image_data_url.startswith("data:"):
        return image_data_url
    header, _, b64 = image_data_url.partition(",")
    mime = "image/jpeg"
    if ";" in header and ":" in header:
        mime = header.split(":", 1)[1].split(";", 1)[0] or mime
    raw = base64.b64decode(b64)
    return await fal_client.upload_async(raw, content_type=mime)
