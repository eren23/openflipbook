"""Free tests for layout_runner summarize() — the pass/fail brain."""
from __future__ import annotations

from tests.world_bench._score import LayoutFidelity
from tests.world_bench.layout_runner import ABResult, summarize


def _ab(name: str, without: float, with_: float) -> ABResult:
    return ABResult(
        name,
        LayoutFidelity(without, {}, 0.0),
        LayoutFidelity(with_, {}, 0.0),
    )


def test_summarize_mean_lift() -> None:
    s = summarize([_ab("a", 0.3, 0.6), _ab("b", 0.4, 0.7)])
    assert s["n_cases"] == 2
    assert s["mean_lift"] == 0.3


def test_summarize_empty() -> None:
    s = summarize([])
    assert s["n_cases"] == 0
    assert s["mean_lift"] == 0.0
