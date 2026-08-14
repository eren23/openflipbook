"""Unit tests for the multi-hop drift bench's pure gate brain (`summarize`).

The paid k-hop chain is exercised only under CHAIN_BENCH_RUN; the DECISION —
half-life, total drift, the safe-hop cap — is pure over synthetic score
sequences and tested here for free (research/05 §4.1: "unit-test summarize on
synthetic score sequences")."""
from __future__ import annotations

from tests.continuity_bench.chain_runner import summarize


def test_half_life_is_first_hop_below_the_floor() -> None:
    # faithfulness-to-source decays; first value strictly under floor 6 is hop 3.
    s = summarize([9.0, 8.0, 5.0, 3.0], [9.0, 8.0, 6.0, 7.0], floor=6.0)
    assert s["half_life"] == 3
    assert s["half_life_reached"] is True
    # product rule: cap auto-OUTWARD one hop before the drift crosses.
    assert s["safe_hops"] == 2


def test_floor_is_strict_below_not_equal() -> None:
    # exactly at the floor is still trusted — only BELOW crosses.
    s = summarize([6.0, 6.0], [8.0, 8.0], floor=6.0)
    assert s["half_life"] is None
    assert s["half_life_reached"] is False
    assert s["safe_hops"] == 2  # never crossed → all hops safe


def test_total_and_mean_drift_from_the_source_baseline() -> None:
    s = summarize([9.0, 8.0, 5.0, 3.0], [9.0, 8.0, 6.0, 7.0], source_baseline=10.0)
    assert s["total_drift"] == 7.0  # 10 - final(3)
    assert s["mean_drift_per_hop"] == 1.75  # 7 / 4 hops
    assert s["mean_step_retention"] == 7.5  # mean of the step scores


def test_a_chain_that_never_drifts_reports_no_half_life() -> None:
    s = summarize([9.0, 9.0, 8.5, 8.0], [9.0, 9.0, 9.0, 9.0], floor=6.0)
    assert s["half_life"] is None
    assert s["safe_hops"] == 4
    assert s["total_drift"] == 2.0


def test_empty_chain_is_total() -> None:
    s = summarize([], [], floor=6.0)
    assert s["k_hops"] == 0
    assert s["half_life"] is None
    assert s["mean_drift_per_hop"] == 0.0
