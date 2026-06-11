"""Per-slug circuit breaker — in-process, same posture as providers/spend.py.

Three consecutive terminal failures open a slug's circuit for a cooldown;
while open, the fallback chain starts from the next candidate instead of
re-burning wall-clock (and retries) on a provider that's down. Success
closes the circuit. In-process by design: per container, reset on restart —
right-sized for a self-hosted stack.
"""
from __future__ import annotations

import threading
import time

FAILURE_THRESHOLD = 3
COOLDOWN_S = 120.0

_lock = threading.Lock()
_failures: dict[str, int] = {}
_open_until: dict[str, float] = {}


def available(slug: str) -> bool:
    with _lock:
        until = _open_until.get(slug, 0.0)
        return not (until and time.monotonic() < until)


def record_success(slug: str) -> None:
    with _lock:
        _failures.pop(slug, None)
        _open_until.pop(slug, None)


def record_failure(slug: str) -> None:
    with _lock:
        count = _failures.get(slug, 0) + 1
        _failures[slug] = count
        if count >= FAILURE_THRESHOLD:
            _open_until[slug] = time.monotonic() + COOLDOWN_S


def reset_for_tests() -> None:
    with _lock:
        _failures.clear()
        _open_until.clear()
