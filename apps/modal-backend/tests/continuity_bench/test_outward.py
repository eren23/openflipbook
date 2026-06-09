"""Free (unpaid) tests for the OUTWARD-drift A/B — the cases + the gate's brain.

The paid run (`outward_runner._cli`, gated on OUTWARD_BENCH_RUN) spends on fal gens
+ the Gemini judge. These cover the parts that don't: the cases are well-formed and
`summarize` computes the drift + flips `fresh_trustworthy` at the threshold, so the
"is the rerender path safe to enable" decision is itself unit-tested.
"""
from __future__ import annotations

from tests.continuity_bench.outward_runner import (
    _CASES,
    CaseResult,
    summarize,
)


def _result(name: str, outpaint: float, fresh: float) -> CaseResult:
    return CaseResult(
        name=name,
        outpaint_score=outpaint,
        fresh_score=fresh,
        outpaint_rationale="",
        fresh_rationale="",
    )


def test_cases_are_well_formed() -> None:
    assert _CASES, "need at least one styled source to measure OUTWARD drift"
    for c in _CASES:
        assert c.source_prompt.strip() and c.style.strip() and c.subject.strip()
        assert c.from_tier in ("city", "district", "place", "region", "world", "room")


def test_drift_is_outpaint_minus_fresh() -> None:
    # The fresh container lost 4 points of medium-faithfulness vs the zero-drift outpaint.
    assert _result("x", 9.0, 5.0).drift == 4.0


def test_summarize_drift_and_distrust() -> None:
    s = summarize([_result("a", 9.0, 5.0), _result("b", 8.0, 6.0)])
    assert s["outpaint_medium_mean"] == 8.5
    assert s["fresh_medium_mean"] == 5.5
    assert s["drift"] == 3.0
    assert s["fresh_trustworthy"] is False  # 5.5 < 6.5 → keep SCALE_OUTWARD_RERENDER off


def test_summarize_trusts_fresh_when_it_holds() -> None:
    s = summarize([_result("a", 9.0, 8.0), _result("b", 9.0, 7.0)])
    assert s["fresh_trustworthy"] is True  # 7.5 >= 6.5
    assert s["drift"] == 1.5
