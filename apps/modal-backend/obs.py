"""Observability primitives for the openflipbook backend.

Goal: end-to-end trace correlation + timing across the SSE pipeline without
adding a real APM dependency. All output is JSON-on-stdout, parseable by any
log shipper. Trace IDs flow in via `X-Trace-Id` header (or body `trace_id`),
ride a ContextVar through async spans, and ride back out on every event.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import Any

from fastapi import Request

TRACE_HEADER = "x-trace-id"

trace_var: ContextVar[str | None] = ContextVar("openflipbook_trace_id", default=None)

_started_at = time.time()
_last_error_ts: float | None = None
_in_flight = 0
_provider_health_cache: dict[str, tuple[float, bool]] = {}
_PROVIDER_TTL_SEC = 30.0

# Bounded in-memory trace ring buffer for the /trace/recent dashboard.
# trace_id -> list of completed span records. Eviction is LRU on the trace.
_TRACE_BUFFER_MAX = int(os.environ.get("TRACE_BUFFER_MAX", "200"))
_SPANS_PER_TRACE_MAX = int(os.environ.get("TRACE_SPANS_PER_TRACE_MAX", "200"))
_trace_buffer: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()

# Abort ring buffer + per-stage counters. Powers /trace/abort-stats so we can
# confirm or refute the "stale-click cost" estimate empirically. Each entry
# records which stage was running when the client dropped the SSE socket,
# how much wall-time had already been spent, and a coarse $-cost estimate.
_ABORT_BUFFER_MAX = int(os.environ.get("ABORT_BUFFER_MAX", "500"))
_abort_buffer: list[dict[str, Any]] = []
_abort_stage_counts: dict[str, int] = {}
_abort_stage_wasted_ms: dict[str, float] = {}
_abort_total_count = 0

# Coarse per-second cost rate ($/sec) used to estimate wasted spend. These
# are rough — image-gen via fal-ai/nano-banana is the dominant per-call
# cost (~$0.039 for a ~2s render), so $0.02/sec is a useful order-of-
# magnitude rate. Override via env if you have firmer numbers.
_DEFAULT_STAGE_COST_PER_SEC: dict[str, float] = {
    "pre-click-resolve": 0.005,
    "pre-plan": 0.020,
    "pre-image-gen": 0.020,
}


def _stage_cost_per_sec(stage: str) -> float:
    env_key = "ABORT_COST_PER_SEC_" + stage.upper().replace("-", "_")
    raw = os.environ.get(env_key)
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    return _DEFAULT_STAGE_COST_PER_SEC.get(stage, 0.005)


def record_abort(
    stage: str,
    elapsed_ms: float,
    *,
    trace_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Record a client-disconnect at a specific stage of the SSE pipeline.

    Cost estimate is ``elapsed_ms`` * ``$/sec`` for the stage; this is
    intentionally simple — the dashboard reads stage_cost_per_sec from env
    and can recompute against firmer pricing later.
    """
    global _abort_total_count

    if not stage:
        return
    cost_per_sec = _stage_cost_per_sec(stage)
    wasted_usd = (elapsed_ms / 1000.0) * cost_per_sec

    entry: dict[str, Any] = {
        "ts_ms": round(time.time() * 1000.0, 2),
        "stage": stage,
        "elapsed_ms": round(elapsed_ms, 2),
        "wasted_usd": round(wasted_usd, 5),
        "cost_per_sec": cost_per_sec,
        "trace_id": trace_id or trace_var.get(),
    }
    if extra:
        for k, v in extra.items():
            try:
                json.dumps(v)
                entry[k] = v
            except (TypeError, ValueError):
                entry[k] = repr(v)

    _abort_buffer.append(entry)
    if len(_abort_buffer) > _ABORT_BUFFER_MAX:
        del _abort_buffer[: len(_abort_buffer) - _ABORT_BUFFER_MAX]

    _abort_stage_counts[stage] = _abort_stage_counts.get(stage, 0) + 1
    _abort_stage_wasted_ms[stage] = _abort_stage_wasted_ms.get(stage, 0.0) + elapsed_ms
    _abort_total_count += 1


def abort_stats(limit: int = 100) -> dict[str, Any]:
    """Return aggregated abort counts + recent abort entries."""
    if limit <= 0:
        return {
            "total": _abort_total_count,
            "by_stage": [],
            "recent": [],
        }
    by_stage: list[dict[str, Any]] = []
    for stage, count in _abort_stage_counts.items():
        wasted_ms = _abort_stage_wasted_ms.get(stage, 0.0)
        cost_per_sec = _stage_cost_per_sec(stage)
        by_stage.append(
            {
                "stage": stage,
                "count": count,
                "wasted_ms": round(wasted_ms, 2),
                "wasted_usd": round((wasted_ms / 1000.0) * cost_per_sec, 5),
                "cost_per_sec": cost_per_sec,
            }
        )
    by_stage.sort(key=lambda r: r["wasted_usd"], reverse=True)

    recent = list(reversed(_abort_buffer[-limit:]))
    return {
        "total": _abort_total_count,
        "by_stage": by_stage,
        "recent": recent,
    }


def _record_span(
    trace_id: str | None,
    *,
    name: str,
    start_epoch_ms: float,
    end_epoch_ms: float,
    duration_ms: float,
    level: str,
    error: str | None,
    kv: dict[str, Any],
) -> None:
    if not trace_id:
        return
    record: dict[str, Any] = {
        "name": name,
        "start_ms": round(start_epoch_ms, 2),
        "end_ms": round(end_epoch_ms, 2),
        "duration_ms": duration_ms,
        "level": level,
    }
    if error:
        record["error"] = error
    if kv:
        safe: dict[str, Any] = {}
        for k, v in kv.items():
            try:
                json.dumps(v)
                safe[k] = v
            except (TypeError, ValueError):
                safe[k] = repr(v)
        record["kv"] = safe
    bucket = _trace_buffer.get(trace_id)
    if bucket is None:
        if len(_trace_buffer) >= _TRACE_BUFFER_MAX:
            _trace_buffer.popitem(last=False)
        bucket = []
        _trace_buffer[trace_id] = bucket
    else:
        _trace_buffer.move_to_end(trace_id)
    bucket.append(record)
    if len(bucket) > _SPANS_PER_TRACE_MAX:
        del bucket[: len(bucket) - _SPANS_PER_TRACE_MAX]


def recent_traces(limit: int = 50) -> list[dict[str, Any]]:
    """Return up to ``limit`` most-recent traces, newest first.

    Each entry is a self-contained summary: trace_id, spans, wall-clock
    duration (max end - min start), span count, and whether any span
    errored. The dashboard renders this directly.
    """
    if limit <= 0:
        return []
    items = list(_trace_buffer.items())[-limit:]
    items.reverse()
    summaries: list[dict[str, Any]] = []
    for trace_id, spans in items:
        if not spans:
            continue
        start_ms = min(s["start_ms"] for s in spans)
        end_ms = max(s["end_ms"] for s in spans)
        summaries.append(
            {
                "trace_id": trace_id,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "wall_ms": round(end_ms - start_ms, 2),
                "span_count": len(spans),
                "errored": any(s.get("level") == "error" for s in spans),
                "spans": spans,
            }
        )
    return summaries


def _init_sentry() -> bool:
    """No-op when SENTRY_DSN is unset, so this is safe to ship without Sentry."""
    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        return False
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("SENTRY_ENVIRONMENT", os.environ.get("MODAL_ENVIRONMENT", "dev")),
            traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            send_default_pii=False,
        )
        return True
    except Exception:
        return False


_SENTRY_ON = _init_sentry()


def _now_iso() -> str:
    millis = int((time.time() % 1) * 1000)
    return f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())}.{millis:03d}Z"


def log(level: str, span: str, **kv: Any) -> None:
    """Emit one JSON log line to stdout. Never raises."""
    record: dict[str, Any] = {
        "ts": _now_iso(),
        "level": level,
        "span": span,
        "trace_id": trace_var.get(),
    }
    for k, v in kv.items():
        try:
            json.dumps(v)
            record[k] = v
        except (TypeError, ValueError):
            record[k] = repr(v)
    try:
        sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


@contextlib.asynccontextmanager
async def span(name: str, **kv: Any) -> AsyncIterator[dict[str, Any]]:
    """Async context manager that times a block and emits start/end log lines.

    Usage:
        async with span("vlm.click_to_subject", x=0.5):
            ...
    """
    global _in_flight, _last_error_ts
    started = time.perf_counter()
    start_epoch_ms = time.time() * 1000.0
    extra: dict[str, Any] = {}
    _in_flight += 1
    log("info", f"{name}.start", **kv)
    try:
        yield extra
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        _last_error_ts = time.time()
        log(
            "error",
            f"{name}.end",
            duration_ms=duration_ms,
            error=f"{type(exc).__name__}: {exc}",
            **kv,
            **extra,
        )
        _record_span(
            trace_var.get(),
            name=name,
            start_epoch_ms=start_epoch_ms,
            end_epoch_ms=time.time() * 1000.0,
            duration_ms=duration_ms,
            level="error",
            error=f"{type(exc).__name__}: {exc}",
            kv={**kv, **extra},
        )
        raise
    else:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        log("info", f"{name}.end", duration_ms=duration_ms, **kv, **extra)
        _record_span(
            trace_var.get(),
            name=name,
            start_epoch_ms=start_epoch_ms,
            end_epoch_ms=time.time() * 1000.0,
            duration_ms=duration_ms,
            level="info",
            error=None,
            kv={**kv, **extra},
        )
    finally:
        _in_flight = max(0, _in_flight - 1)


async def trace_id_dep(request: Request) -> str:
    """FastAPI dependency: extract a trace_id and bind it to the contextvar.

    Order: header X-Trace-Id > query ?trace_id= > body field trace_id (if
    JSON) > newly-minted UUID. The contextvar binding lasts the request.
    """
    trace_id = request.headers.get(TRACE_HEADER) or request.query_params.get("trace_id")
    if not trace_id and request.method in ("POST", "PUT", "PATCH"):
        try:
            body_bytes = await request.body()
            if body_bytes:
                parsed = json.loads(body_bytes.decode("utf-8"))
                if isinstance(parsed, dict):
                    candidate = parsed.get("trace_id")
                    if isinstance(candidate, str) and candidate:
                        trace_id = candidate
            request._body = body_bytes
        except Exception:
            pass
    if not trace_id:
        trace_id = str(uuid.uuid4())
    trace_var.set(trace_id)
    return trace_id


def bind_trace(trace_id: str | None) -> str:
    """Set the trace contextvar to a known id (e.g. from a body model)."""
    if not trace_id:
        trace_id = str(uuid.uuid4())
    trace_var.set(trace_id)
    return trace_id


def current_trace() -> str | None:
    return trace_var.get()


def record_error(kind: str, exc: Exception, **kv: Any) -> None:
    global _last_error_ts
    _last_error_ts = time.time()
    log(
        "error",
        f"err.{kind}",
        error=f"{type(exc).__name__}: {exc}",
        **kv,
    )
    if _SENTRY_ON:
        try:
            import sentry_sdk

            with sentry_sdk.push_scope() as scope:
                scope.set_tag("kind", kind)
                tid = trace_var.get()
                if tid:
                    scope.set_tag("trace_id", tid)
                for k, v in kv.items():
                    scope.set_extra(k, v)
                sentry_sdk.capture_exception(exc)
        except Exception:
            pass


async def _ping(url: str) -> bool:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(url)
        return resp.status_code < 500
    except Exception:
        return False


async def _check_provider(name: str, url: str) -> bool:
    cached = _provider_health_cache.get(name)
    now = time.time()
    if cached and now - cached[0] < _PROVIDER_TTL_SEC:
        return cached[1]
    ok = await _ping(url)
    _provider_health_cache[name] = (now, ok)
    return ok


async def status_payload(service: str) -> dict[str, Any]:
    """Build the payload for /status endpoints. Cheap; safe to call often."""
    fal_ok, openrouter_ok = await asyncio.gather(
        _check_provider("fal", "https://fal.run/health"),
        _check_provider("openrouter", "https://openrouter.ai/api/v1/models"),
    )
    providers: dict[str, bool] = {
        "fal": fal_ok,
        "openrouter": openrouter_ok,
    }
    # Requesty is an optional OpenRouter-shaped LLM provider; only probe (and
    # surface) it when it's the configured provider, so the default payload is
    # unchanged for the OpenRouter path.
    if (os.environ.get("LLM_PROVIDER", "").strip().lower()) == "requesty":
        providers["requesty"] = await _check_provider(
            "requesty", "https://router.requesty.ai/v1/models"
        )
    return {
        "ok": True,
        "service": service,
        "version": os.environ.get("GIT_SHA", "dev"),
        "uptime_s": round(time.time() - _started_at, 1),
        "in_flight": _in_flight,
        "last_error_ts": _last_error_ts,
        "providers": providers,
    }
