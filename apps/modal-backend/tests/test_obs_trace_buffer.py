"""Tests for the in-memory trace ring buffer in obs.py.

The buffer powers the /admin/trace dashboard. These tests verify:
  - completed spans land in the buffer keyed by trace_id
  - errored spans are recorded with level="error"
  - traces beyond TRACE_BUFFER_MAX evict oldest
  - per-trace spans beyond _SPANS_PER_TRACE_MAX evict oldest
"""

from __future__ import annotations

import pytest

import obs


@pytest.fixture(autouse=True)
def _clear_buffer() -> None:
    obs._trace_buffer.clear()
    obs.trace_var.set(None)


async def test_span_records_when_trace_bound() -> None:
    obs.bind_trace("trace-A")
    async with obs.span("test.simple"):
        pass

    traces = obs.recent_traces()
    assert len(traces) == 1
    assert traces[0]["trace_id"] == "trace-A"
    assert traces[0]["span_count"] == 1
    assert traces[0]["spans"][0]["name"] == "test.simple"
    assert traces[0]["spans"][0]["level"] == "info"
    assert traces[0]["wall_ms"] >= 0


async def test_span_skipped_when_no_trace_bound() -> None:
    obs.trace_var.set(None)
    async with obs.span("test.untraced"):
        pass

    assert obs.recent_traces() == []


async def test_errored_span_recorded_with_error_level() -> None:
    obs.bind_trace("trace-error")
    with pytest.raises(RuntimeError):
        async with obs.span("test.boom"):
            raise RuntimeError("nope")

    traces = obs.recent_traces()
    assert len(traces) == 1
    assert traces[0]["errored"] is True
    span = traces[0]["spans"][0]
    assert span["level"] == "error"
    assert "RuntimeError" in span["error"]


async def test_multiple_spans_within_one_trace_accumulate() -> None:
    obs.bind_trace("trace-multi")
    async with obs.span("step.1"):
        pass
    async with obs.span("step.2"):
        pass
    async with obs.span("step.3"):
        pass

    traces = obs.recent_traces()
    assert len(traces) == 1
    assert traces[0]["span_count"] == 3
    names = [s["name"] for s in traces[0]["spans"]]
    assert names == ["step.1", "step.2", "step.3"]


async def test_recent_traces_returns_newest_first() -> None:
    obs.bind_trace("first")
    async with obs.span("a"):
        pass
    obs.bind_trace("second")
    async with obs.span("b"):
        pass
    obs.bind_trace("third")
    async with obs.span("c"):
        pass

    traces = obs.recent_traces()
    assert [t["trace_id"] for t in traces] == ["third", "second", "first"]


async def test_trace_buffer_evicts_oldest_when_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(obs, "_TRACE_BUFFER_MAX", 3)

    for i in range(5):
        obs.bind_trace(f"trace-{i}")
        async with obs.span("x"):
            pass

    traces = obs.recent_traces()
    ids = [t["trace_id"] for t in traces]
    # Oldest two (trace-0, trace-1) evicted; newest three remain.
    assert ids == ["trace-4", "trace-3", "trace-2"]


async def test_recent_traces_limit_clamps_to_available() -> None:
    for i in range(3):
        obs.bind_trace(f"t-{i}")
        async with obs.span("x"):
            pass

    assert len(obs.recent_traces(limit=2)) == 2
    assert len(obs.recent_traces(limit=10)) == 3


async def test_recent_traces_zero_limit_returns_empty() -> None:
    obs.bind_trace("t")
    async with obs.span("x"):
        pass
    assert obs.recent_traces(limit=0) == []


async def test_kv_payload_preserved_on_record() -> None:
    obs.bind_trace("t-kv")
    async with obs.span("vlm.click", model="qwen-vl-72b", x=0.5) as ctx:
        ctx["tokens"] = 132

    traces = obs.recent_traces()
    span = traces[0]["spans"][0]
    assert span["kv"]["model"] == "qwen-vl-72b"
    assert span["kv"]["x"] == 0.5
    assert span["kv"]["tokens"] == 132
