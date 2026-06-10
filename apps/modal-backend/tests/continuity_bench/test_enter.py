"""Free (unpaid) tests for the ENTER-consistency A/B — the cases + the gate's brain.

The paid run (`enter_runner._cli`, gated on ENTER_BENCH_RUN) spends on fal gens
+ the Gemini judge. These cover the parts that don't: the cases are well-formed,
the crop mirrors the client, and `summarize` computes the LIFT + flips
`edit_trustworthy` at the threshold — the "did the fix actually fix it" decision
is itself unit-tested.
"""
from __future__ import annotations

from tests.continuity_bench.enter_runner import (
    _CASES,
    CaseResult,
    summarize,
)


def _result(
    name: str,
    fresh: float,
    edit: float,
    extra: dict[str, float] | None = None,
) -> CaseResult:
    return CaseResult(
        name=name,
        fresh_score=fresh,
        edit_score=edit,
        fresh_rationale="",
        edit_rationale="",
        edit_medium_score=8.0,
        extra_models=extra or {},
    )


def test_cases_are_well_formed() -> None:
    assert len(_CASES) >= 2, "need >= 2 cases for a trustworthy mean (n_min)"
    for c in _CASES:
        assert c.map_prompt.strip() and c.style.strip() and c.place_label.strip()
        assert c.subject_context.strip() and c.surroundings.strip()
        x, y = c.tap
        assert 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0
        # The map prompt must PLACE the tapped landmark so the tap can aim.
        anchor = c.place_label.removeprefix("The ").split()[0].lower()
        assert anchor in c.map_prompt.lower()


def test_lift_is_edit_minus_fresh() -> None:
    # The old fresh path scored 3 on "same place?"; the edit route scored 8.
    assert _result("x", 3.0, 8.0).lift == 5.0


def test_summarize_lift_and_trust() -> None:
    s = summarize([_result("a", 3.0, 8.0), _result("b", 4.0, 7.0)])
    assert s["fresh_same_place_mean"] == 3.5
    assert s["edit_same_place_mean"] == 7.5
    assert s["mean_lift"] == 4.0
    assert s["edit_trustworthy"] is True  # 7.5 >= 6.5


def test_summarize_distrusts_a_weak_edit() -> None:
    # Even with a positive lift, a low absolute mean means the enter still
    # isn't a faithful continuation — don't celebrate a lift over garbage.
    s = summarize([_result("a", 2.0, 5.0), _result("b", 3.0, 6.0)])
    assert s["mean_lift"] == 3.0
    assert s["edit_trustworthy"] is False  # 5.5 < 6.5


def test_summarize_aggregates_extra_model_arms() -> None:
    s = summarize(
        [
            _result("a", 3.0, 8.0, {"fal-ai/flux-pro/kontext": 6.0}),
            _result("b", 4.0, 7.0, {"fal-ai/flux-pro/kontext": 7.0}),
        ]
    )
    assert s["extra_model_same_place_means"] == {"fal-ai/flux-pro/kontext": 6.5}
