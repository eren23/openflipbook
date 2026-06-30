"""Per-IP rate-limit bucket eviction must be LRU, not FIFO."""
from __future__ import annotations

import pytest

from providers import ratelimit


def test_eviction_is_lru_not_fifo(monkeypatch: pytest.MonkeyPatch) -> None:
    # A heavy hitter that keeps getting touched must NOT be the one evicted when
    # the bucket table overflows. The old plain-dict FIFO pop evicted the
    # oldest-INSERTED ip — resetting an actively-limited client to a full bucket.
    monkeypatch.setenv("RATE_LIMIT_RPM", "240")  # capacity 60 -> every allow() passes
    monkeypatch.setattr(ratelimit, "_MAX_BUCKETS", 2)
    ratelimit.reset_for_tests()

    assert ratelimit.allow("A")  # insert A
    assert ratelimit.allow("B")  # insert B            -> table full {A, B}
    assert ratelimit.allow("A")  # touch A (still busy) -> {B, A}
    assert ratelimit.allow("C")  # insert C overflows   -> evict LRU = B

    with ratelimit._lock:
        live = set(ratelimit._buckets)
    assert "A" in live  # heavy hitter survived (FIFO would have dropped it)
    assert "C" in live
    assert "B" not in live  # least-recently-touched got evicted
    ratelimit.reset_for_tests()
