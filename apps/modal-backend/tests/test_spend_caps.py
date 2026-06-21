"""The per-session cap + the shared over_cap() pre-flight gate (Batch 3a).

These guard the non-streaming paid endpoints (extract / edit / plan / precompute),
which previously had no cap check at all. Pure providers.spend — no modal harness.
"""
from __future__ import annotations

import pytest

from providers import spend


@pytest.fixture(autouse=True)
def _fresh_meter(monkeypatch: pytest.MonkeyPatch):
    spend.reset_for_tests()
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    monkeypatch.delenv("MAX_SESSION_SPEND", raising=False)
    yield
    spend.reset_for_tests()


def test_over_cap_is_none_when_both_caps_unset() -> None:
    spend.record("s1", 100.0)  # huge spend, but no cap configured
    assert spend.over_cap("s1") is None
    assert spend.cap_exceeded() is False


def test_daily_cap_blocks_every_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_DAILY_SPEND", "1.00")
    spend.record("s1", 1.50)
    # The daily-global cap is crossed → even a brand-new session is blocked.
    reason = spend.over_cap("s2-never-spent")
    assert reason is not None and "daily" in reason


def test_session_cap_blocks_only_the_spendy_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_SESSION_SPEND", "0.50")
    spend.record("hot", 0.60)
    hot = spend.over_cap("hot")
    assert hot is not None and "session" in hot
    # A different session under its own cap still proceeds.
    assert spend.over_cap("cold") is None


def test_record_vlm_call_counts_toward_caps() -> None:
    before = spend.session_total("s1")
    spend.record_vlm_call("s1")
    after = spend.session_total("s1")
    assert after == pytest.approx(before + spend.VLM_CALL_FLAT)
    assert spend.daily_total() == pytest.approx(spend.VLM_CALL_FLAT)
