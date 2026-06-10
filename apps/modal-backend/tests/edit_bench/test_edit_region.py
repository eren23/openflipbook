"""Free gates for the edit-region bench (tests/edit_bench/runner.py).

The paid runner's pure parts, pinned every commit: cases stay well-formed,
the mask builder honors the wire convention (white = edit, source dims),
and summarize()'s three gates flip exactly when they should.
"""
from __future__ import annotations

import io

from PIL import Image

from tests.edit_bench import runner


def test_cases_well_formed() -> None:
    assert len(runner._CASES) >= 2
    names = [c.name for c in runner._CASES]
    assert len(names) == len(set(names))
    for c in runner._CASES:
        x, y, w, h = c.region
        assert x >= 0.0 and y >= 0.0 and w > 0.0 and h > 0.0
        assert x + w <= 1.0 and y + h <= 1.0
        assert c.instruction.strip()
        assert c.style.strip()


def test_build_mask_is_white_rect_at_source_dims() -> None:
    mask = runner.build_mask((160, 90), (0.25, 0.2, 0.5, 0.6))
    im = Image.open(io.BytesIO(mask))
    assert im.size == (160, 90)
    hist = im.convert("L").histogram()
    white, total = hist[255], sum(hist)
    assert abs(white / total - 0.3) < 0.02  # 0.5 * 0.6 of the frame
    assert hist[0] + white == total  # binary: no grays


def _arm(arm: str = "production", alignment: float = 9.0, outside: float = 0.0, medium: float = 9.0) -> runner.ArmResult:
    return runner.ArmResult(
        arm=arm, model="m", alignment=alignment, outside=outside,
        medium=medium, alignment_rationale="",
    )


def _case(name: str, *arms: runner.ArmResult) -> runner.CaseResult:
    return runner.CaseResult(name=name, description="d", arms=list(arms))


def test_summarize_all_gates_pass() -> None:
    s = runner.summarize([_case("a", _arm()), _case("b", _arm())])
    assert s["asked_change_landed"] and s["outside_stable"] and s["medium_floor_held"]
    assert s["alignment_mean"] == 9.0
    assert s["n_cases"] == 2


def test_summarize_alignment_gate_fails_on_low_mean() -> None:
    s = runner.summarize([_case("a", _arm(alignment=5.0)), _case("b", _arm(alignment=7.0))])
    assert not s["asked_change_landed"]


def test_summarize_outside_gate_is_per_case_not_mean() -> None:
    # One leaky case must fail the gate even if the average looks fine.
    s = runner.summarize([_case("a", _arm()), _case("b", _arm(outside=0.3))])
    assert not s["outside_stable"]


def test_summarize_medium_floor() -> None:
    s = runner.summarize([_case("a", _arm(medium=3.0)), _case("b", _arm(medium=5.0))])
    assert not s["medium_floor_held"]


def test_summarize_extra_arms_reported_but_not_gated() -> None:
    leaky_extra = _arm(arm="openai/gpt-image-2/edit", outside=0.9, alignment=2.0)
    s = runner.summarize([_case("a", _arm(), leaky_extra)])
    assert s["outside_stable"] and s["asked_change_landed"]
    assert s["arms"]["openai/gpt-image-2/edit"]["outside_max"] == 0.9


def test_summarize_empty_production_fails_closed() -> None:
    s = runner.summarize([])
    assert not (s["asked_change_landed"] or s["outside_stable"] or s["medium_floor_held"])
