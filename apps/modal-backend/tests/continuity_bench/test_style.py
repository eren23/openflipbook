"""Free (unpaid) tests for the style A/B — the case set + the pass/fail brain.

The paid run (style_runner._cli, gated on STYLE_BENCH_RUN) spends on fal edits +
the Gemini judge. These cover the parts that don't: that the cases are well-formed
and that `summarize` flips pass→fail at the threshold, so the regression guard's
decision is itself unit-tested.
"""
from __future__ import annotations

from tests.continuity_bench.style_runner import (
    _CASES,
    _PASS_THRESHOLD,
    CaseResult,
    summarize,
)


def _result(name: str, without: float, with_: float) -> CaseResult:
    return CaseResult(name=name, without_score=without, with_score=with_,
                      without_rationale="", with_rationale="")


def test_cases_are_well_formed() -> None:
    assert _CASES, "need at least one drift-prone case to guard the medium lock"
    for c in _CASES:
        assert c.source_prompt.strip() and c.style.strip() and c.edit.strip()


def test_lift_is_with_minus_without() -> None:
    assert _result("x", 3.0, 8.0).lift == 5.0


def test_summarize_passes_when_locked_arm_holds() -> None:
    # The shipped behaviour: WITHOUT drifts low, WITH holds high → pass.
    s = summarize([_result("a", 2.0, 9.0), _result("b", 3.0, 8.0)])
    assert s["with_medium_lock_mean"] == 8.5
    assert s["mean_lift"] == 6.0
    assert s["pass"] is True


def test_summarize_fails_when_lock_regresses() -> None:
    # If a future change lets the WITH arm drift below threshold → the guard trips.
    s = summarize([_result("a", 2.0, 4.0), _result("b", 3.0, 5.0)])
    assert s["with_medium_lock_mean"] == 4.5
    assert s["with_medium_lock_mean"] < _PASS_THRESHOLD
    assert s["pass"] is False
