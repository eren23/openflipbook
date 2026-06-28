"""The SSE keepalive wrapper: a long silent image gen (riverflow's 2-3 min) must
not let an intermediary's idle/body timeout (undici's 300s UND_ERR_BODY_TIMEOUT,
nginx, a load balancer) guillotine the stream. _with_heartbeat fills silent gaps
with SSE comment lines, which the browser parser ignores."""
from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator
from unittest.mock import MagicMock

sys.modules.setdefault("modal", MagicMock())

from generate import _with_heartbeat  # noqa: E402


async def _slow_stream() -> AsyncIterator[bytes]:
    yield b"data: 1\n\n"
    await asyncio.sleep(0.06)  # a silent gap longer than the heartbeat interval
    yield b"data: 2\n\n"


async def test_heartbeat_fills_silent_gaps_and_preserves_events() -> None:
    out: list[bytes] = []
    async for chunk in _with_heartbeat(_slow_stream(), interval_s=0.02):
        out.append(chunk)

    # every real event survives, in order
    assert [c for c in out if c.startswith(b"data:")] == [b"data: 1\n\n", b"data: 2\n\n"]
    # the 0.06s gap (>= 2 intervals of 0.02s) was filled with keepalive(s)
    assert b": keepalive\n\n" in out
    # …and the only non-data chunks are keepalive COMMENTS (ignored by the client)
    assert all(c == b": keepalive\n\n" for c in out if not c.startswith(b"data:"))


async def test_heartbeat_is_silent_when_the_stream_is_fast() -> None:
    async def _fast() -> AsyncIterator[bytes]:
        yield b"data: a\n\n"
        yield b"data: b\n\n"

    out = [c async for c in _with_heartbeat(_fast(), interval_s=5.0)]
    assert out == [b"data: a\n\n", b"data: b\n\n"]  # no spurious keepalives
