"""Free tests for grounding_runner summarize() — the pass/fail brain."""
from __future__ import annotations

from tests.world_bench.grounding_runner import GroundingCaseResult, summarize


def test_summarize_grounding_mean() -> None:
    s = summarize([
        GroundingCaseResult("a", 0.6, 2, [], []),
        GroundingCaseResult("b", 0.8, 3, [], []),
    ])
    assert s["n_cases"] == 2
    assert s["grounding_mean"] == 0.7
    assert s["matched_mean"] == 2.5
