"""providers/spend.py — the in-process meter behind MAX_DAILY_SPEND."""
from __future__ import annotations

import pytest

from providers import spend


@pytest.fixture(autouse=True)
def _fresh_meter(monkeypatch: pytest.MonkeyPatch):
    spend.reset_for_tests()
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    yield
    spend.reset_for_tests()


def test_estimate_image_longest_prefix_wins() -> None:
    assert spend.estimate_image("fal-ai/nano-banana") == 0.039
    assert spend.estimate_image("fal-ai/nano-banana-pro") == 0.15
    assert spend.estimate_image("fal-ai/nano-banana-pro/edit") == 0.15
    assert spend.estimate_image("fal-ai/flux-pro/kontext") == 0.04
    assert spend.estimate_image("openrouter:sourceful/riverflow-v2.5-pro") == 0.24
    # unknown slug -> the balanced default, never zero
    assert spend.estimate_image("acme/mystery-model") == 0.15
    assert spend.estimate_image(None) == 0.15


def test_record_generation_accumulates_per_session_and_day() -> None:
    total = spend.record_generation("s1", "fal-ai/nano-banana-pro", images=2)
    assert total == pytest.approx(0.15 * 2 + spend.VLM_STACK_FLAT)
    spend.record_generation("s2", "fal-ai/nano-banana")
    assert spend.session_total("s1") == pytest.approx(0.32)
    assert spend.session_total("s2") == pytest.approx(0.059)
    assert spend.daily_total() == pytest.approx(0.32 + 0.059)


def test_cap_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    assert spend.cap_exceeded() is False  # uncapped by default
    monkeypatch.setenv("MAX_DAILY_SPEND", "0.10")
    assert spend.cap_exceeded() is False
    spend.record("s1", 0.11)
    assert spend.cap_exceeded() is True
    monkeypatch.setenv("MAX_DAILY_SPEND", "junk")
    assert spend.cap_exceeded() is False  # bad value -> uncapped, never bricked


def test_session_totals_are_bounded() -> None:
    for i in range(600):
        spend.record(f"s{i}", 0.01)
    # the LRU keeps the most recent 512; the earliest sessions are evicted
    assert spend.session_total("s0") == 0.0
    assert spend.session_total("s599") == pytest.approx(0.01)
