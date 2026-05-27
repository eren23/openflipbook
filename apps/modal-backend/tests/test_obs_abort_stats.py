"""Tests for the abort-stats accumulator in obs.py."""

from __future__ import annotations

import pytest

import obs


@pytest.fixture(autouse=True)
def _reset_abort_state(monkeypatch: pytest.MonkeyPatch) -> None:
    obs._abort_buffer.clear()
    obs._abort_stage_counts.clear()
    obs._abort_stage_wasted_ms.clear()
    obs._abort_total_count = 0


def test_record_abort_increments_total_and_per_stage() -> None:
    obs.record_abort("pre-plan", 850.0, trace_id="t-1")
    obs.record_abort("pre-plan", 200.0, trace_id="t-2")
    obs.record_abort("pre-image-gen", 2400.0, trace_id="t-3")

    stats = obs.abort_stats()
    assert stats["total"] == 3
    by_stage = {row["stage"]: row for row in stats["by_stage"]}
    assert by_stage["pre-plan"]["count"] == 2
    assert by_stage["pre-plan"]["wasted_ms"] == 1050.0
    assert by_stage["pre-image-gen"]["count"] == 1
    assert by_stage["pre-image-gen"]["wasted_ms"] == 2400.0


def test_record_abort_estimates_dollars_by_stage_cost_rate() -> None:
    obs.record_abort("pre-image-gen", 1000.0, trace_id="t")
    stats = obs.abort_stats()
    row = next(r for r in stats["by_stage"] if r["stage"] == "pre-image-gen")
    # default $0.02/sec * 1.0s = $0.02
    assert row["wasted_usd"] == pytest.approx(0.02, abs=1e-4)


def test_env_override_changes_cost_per_sec(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ABORT_COST_PER_SEC_PRE_IMAGE_GEN", "0.05")
    obs.record_abort("pre-image-gen", 1000.0)
    stats = obs.abort_stats()
    row = next(r for r in stats["by_stage"] if r["stage"] == "pre-image-gen")
    assert row["wasted_usd"] == pytest.approx(0.05, abs=1e-4)


def test_recent_entries_returned_newest_first() -> None:
    obs.record_abort("pre-plan", 100.0, trace_id="t-1")
    obs.record_abort("pre-plan", 200.0, trace_id="t-2")
    obs.record_abort("pre-image-gen", 300.0, trace_id="t-3")

    recent = obs.abort_stats()["recent"]
    assert [r["trace_id"] for r in recent] == ["t-3", "t-2", "t-1"]


def test_recent_buffer_caps_at_max(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(obs, "_ABORT_BUFFER_MAX", 3)
    for i in range(5):
        obs.record_abort("pre-plan", float(i * 100), trace_id=f"t-{i}")
    # Buffer is also pruned in the recorder, so only 3 remain.
    assert len(obs._abort_buffer) == 3
    recent = obs.abort_stats()["recent"]
    assert [r["trace_id"] for r in recent] == ["t-4", "t-3", "t-2"]


def test_extra_kv_recorded_and_passes_through() -> None:
    obs.record_abort("pre-plan", 100.0, trace_id="t", extra={"mode": "tap"})
    entry = obs.abort_stats()["recent"][0]
    assert entry["mode"] == "tap"
    assert entry["stage"] == "pre-plan"


def test_empty_stats_when_no_aborts() -> None:
    stats = obs.abort_stats()
    assert stats["total"] == 0
    assert stats["by_stage"] == []
    assert stats["recent"] == []


def test_limit_zero_returns_empty_recent_only() -> None:
    obs.record_abort("pre-plan", 100.0, trace_id="t")
    stats = obs.abort_stats(limit=0)
    # Per-stage aggregates still meaningful at limit=0, recent suppressed.
    assert stats["recent"] == []
    assert stats["total"] == 1


def test_unknown_stage_uses_fallback_cost() -> None:
    obs.record_abort("custom-stage", 1000.0, trace_id="t")
    stats = obs.abort_stats()
    row = next(r for r in stats["by_stage"] if r["stage"] == "custom-stage")
    # Fallback $0.005/sec * 1s
    assert row["cost_per_sec"] == 0.005
    assert row["wasted_usd"] == pytest.approx(0.005, abs=1e-4)


def test_empty_stage_string_skipped() -> None:
    obs.record_abort("", 100.0, trace_id="t")
    assert obs.abort_stats()["total"] == 0
