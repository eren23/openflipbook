"""Shared helpers across image, image_edit, video providers.

Kept tiny on purpose — only consolidates patterns that were duplicated.
"""

from __future__ import annotations

import base64
import hashlib
from collections import OrderedDict

import fal_client

# Memoize data-URL → fal storage URL within the process. The judged loops
# (edit_loop / render_loop) re-render the SAME source image across retry
# attempts, and the mask path uploads the same source for both polish and
# inpaint — each upload is a full-res (1-3MB) round-trip that, on a slow link,
# measured ~3.5min for one edit. fal storage URLs are stable, so the same
# bytes need uploading only once. Bounded LRU so long sessions don't grow
# unbounded; keyed by content hash (identical bytes → one upload).
_URL_CACHE: OrderedDict[str, str] = OrderedDict()
_URL_CACHE_MAX = 64


async def to_fal_url(image_data_url: str) -> str:
    """Convert an inline data URL to a fal storage URL (memoized).

    fal's queue endpoints can reject or stall on large data URLs (high-res
    seedream / nano-banana-pro outputs hit 1-3MB easily). Uploading to fal
    storage first sidesteps the limit and is what fal recommends. Pass-through
    if the input already looks like an http(s) URL. Identical bytes seen again
    (a retry attempt re-rendering the same source) reuse the cached upload.
    """
    if not image_data_url.startswith("data:"):
        return image_data_url
    header, _, b64 = image_data_url.partition(",")
    mime = "image/jpeg"
    if ";" in header and ":" in header:
        mime = header.split(":", 1)[1].split(";", 1)[0] or mime
    raw = base64.b64decode(b64)
    key = hashlib.sha256(raw).hexdigest()
    cached = _URL_CACHE.get(key)
    if cached is not None:
        _URL_CACHE.move_to_end(key)
        return cached
    url = await fal_client.upload_async(raw, content_type=mime)
    _URL_CACHE[key] = url
    _URL_CACHE.move_to_end(key)
    while len(_URL_CACHE) > _URL_CACHE_MAX:
        _URL_CACHE.popitem(last=False)
    return url
