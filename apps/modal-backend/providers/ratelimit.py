"""Per-IP token bucket — in-process, locked (the spend.py posture).

RATE_LIMIT_RPM (requests/minute, env) arms it; absent/0 = off, byte-identical.
Burst capacity is rpm/4 (floor 2) so a human's quick double-action passes
while a flood drains immediately. Per container, reset on restart — a public
deployment that needs real limits should still front this with a proxy; this
is the in-app seatbelt.
"""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict

_lock = threading.Lock()
_buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()  # ip -> (tokens, last_ts)
_MAX_BUCKETS = 4096


def rpm() -> float:
    try:
        return max(0.0, float(os.environ.get("RATE_LIMIT_RPM", "") or 0.0))
    except ValueError:
        return 0.0


def allow(ip: str) -> bool:
    rate = rpm()
    if rate <= 0:
        return True
    capacity = max(2.0, rate / 4.0)
    refill_per_s = rate / 60.0
    now = time.monotonic()
    with _lock:
        tokens, last = _buckets.get(ip, (capacity, now))
        tokens = min(capacity, tokens + (now - last) * refill_per_s)
        if tokens < 1.0:
            _buckets[ip] = (tokens, now)
            _buckets.move_to_end(ip)
            return False
        _buckets[ip] = (tokens - 1.0, now)
        _buckets.move_to_end(ip)
        if len(_buckets) > _MAX_BUCKETS:
            # Evict the least-recently-touched IP (LRU), not the oldest-inserted.
            # A plain dict value-update keeps insertion order, so the old FIFO pop
            # could evict (and full-reset) a heavy hitter still being limited.
            _buckets.popitem(last=False)
        return True


def reset_for_tests() -> None:
    with _lock:
        _buckets.clear()
