"""Per-IP rate-limit bucket eviction must be LRU, not FIFO."""
from __future__ import annotations

import pytest

import obs
from providers import ratelimit


def test_malformed_rpm_warns_once_and_disables(monkeypatch: pytest.MonkeyPatch) -> None:
    # A typo'd RATE_LIMIT_RPM used to silently turn the limiter OFF — it still
    # degrades to off (never blocks traffic on a config error) but now says so,
    # once per container, not per request.
    monkeypatch.setenv("RATE_LIMIT_RPM", "sixty")
    ratelimit.reset_for_tests()
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(
        obs, "log", lambda level, event, **kw: events.append((level, event))
    )
    assert ratelimit.rpm() == 0.0
    assert ratelimit.allow("A")  # limiter off, requests pass
    assert ratelimit.rpm() == 0.0  # second read: no second warn
    assert events.count(("warn", "ratelimit.bad_rpm")) == 1
    ratelimit.reset_for_tests()


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
