"""Shared SSE progress-frame paint for the render/edit streams.

Its own module, not ``__init__.py`` — the package init imports the mode
modules, so a helper there would cycle.
"""
from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable


async def progress_frame(
    sse: Callable[..., bytes],
    jpeg_bytes: bytes,
    index: int,
    trace_id: str,
) -> bytes:
    """b64-encode a JPEG off-thread and wrap it as the ``progress`` SSE event.

    The encode runs in a thread so the event loop stays free — a sync
    b64encode of a 1-3MB JPEG stalls it ~5-15ms, in the hot path right
    when the user watches. Byte-identical to the six hand-rolled paint
    blocks this replaced.
    """
    b64 = (await asyncio.to_thread(base64.b64encode, jpeg_bytes)).decode("ascii")
    return sse(
        {"type": "progress", "frame_index": index, "jpeg_b64": b64},
        trace_id,
    )
