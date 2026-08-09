"""The zoom pre-judge preview bridge (_race_preview) — VIEW_LOOP_PREVIEW.

_judged_zoom is a task, not a generator, so it hands its first render to the SSE
body through a queue. `_race_preview` drains that queue but must never deadlock
if the render fails (the queue then stays empty while the task raises).
"""
from __future__ import annotations

import asyncio

import pytest

from providers.generate_modes.tap import _race_preview


async def test_race_preview_returns_bytes_when_render_lands_first() -> None:
    q: asyncio.Queue[bytes] = asyncio.Queue()

    async def judged() -> str:
        await asyncio.sleep(0.05)  # the judge tail runs after the render enqueues
        return "final"

    task = asyncio.ensure_future(judged())
    q.put_nowait(b"first-render")
    assert await _race_preview(q, task) == b"first-render"
    await task


async def test_race_preview_none_when_task_finishes_without_a_render() -> None:
    # First render never enqueued (e.g. a no-judge early return) — the get must
    # not block forever; the task completing resolves the race to None.
    q: asyncio.Queue[bytes] = asyncio.Queue()

    async def judged() -> str:
        return "final"

    assert await _race_preview(q, asyncio.ensure_future(judged())) is None


async def test_race_preview_none_when_render_raises_no_deadlock() -> None:
    q: asyncio.Queue[bytes] = asyncio.Queue()

    async def judged() -> str:
        raise RuntimeError("first render failed")

    task = asyncio.ensure_future(judged())
    assert await _race_preview(q, task) is None  # no deadlock
    with pytest.raises(RuntimeError):
        await task  # the error still propagates to the real await
