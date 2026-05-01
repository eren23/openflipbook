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
from contextvars import ContextVar
from typing import Any, AsyncIterator

from fastapi import Request

TRACE_HEADER = "x-trace-id"

trace_var: ContextVar[str | None] = ContextVar("openflipbook_trace_id", default=None)

_started_at = time.time()
_last_error_ts: float | None = None
_in_flight = 0
_provider_health_cache: dict[str, tuple[float, bool]] = {}
_PROVIDER_TTL_SEC = 30.0


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % int(
        (time.time() % 1) * 1000
    )


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
    except Exception:  # noqa: BLE001
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
    extra: dict[str, Any] = {}
    _in_flight += 1
    log("info", f"{name}.start", **kv)
    try:
        yield extra
    except Exception as exc:  # noqa: BLE001
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
        raise
    else:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        log("info", f"{name}.end", duration_ms=duration_ms, **kv, **extra)
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
            request._body = body_bytes  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
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


async def _ping(url: str) -> bool:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(url)
        return resp.status_code < 500
    except Exception:  # noqa: BLE001
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
    return {
        "ok": True,
        "service": service,
        "version": os.environ.get("GIT_SHA", "dev"),
        "uptime_s": round(time.time() - _started_at, 1),
        "in_flight": _in_flight,
        "last_error_ts": _last_error_ts,
        "providers": {
            "fal": fal_ok,
            "openrouter": openrouter_ok,
        },
    }
