"""Pytest gate for the click-resolver bench.

Two layers run here:

1. ``test_score_*`` — unit tests for the phrase-similarity scorer; no
   network, no API key, runs on every commit.
2. ``test_run_bench_against_vlm`` — integration test that calls the real
   click resolver against the fixture set. Skipped unless
   CLICK_BENCH_RUN=1 AND OPENROUTER_API_KEY is set. Also skipped when the
   fixtures file is empty so a default ``pytest`` run never burns API
   credits.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from tests.click_bench import _score, leaderboard, runner
from tests.click_bench.runner import load_fixtures, run_bench

_FIXTURES = Path(__file__).parent / "click_bench" / "fixtures" / "v1.json"


# ---------- scoring unit tests ------------------------------------------


def test_score_exact_match() -> None:
    s = _score.score_subject("steam engine piston rod", "steam engine piston rod")
    assert s.exact is True
    assert s.composite == 1.0


def test_score_case_and_punctuation_normalization() -> None:
    s = _score.score_subject("The Steam-Engine, Piston rod.", "steam engine piston rod")
    assert s.exact is True


def test_score_article_dropping() -> None:
    s = _score.score_subject("the boiler", "boiler")
    assert s.exact is True


def test_score_partial_match() -> None:
    s = _score.score_subject("engine piston", "steam engine piston rod")
    assert s.exact is False
    assert 0.4 <= s.composite < 1.0


def test_score_alternates_pick_best() -> None:
    s = _score.score_subject(
        "valve", expected="cylinder", alternates=["valve", "piston"]
    )
    assert s.exact is True
    assert s.matched_against == "valve"


def test_score_completely_wrong_fails_threshold() -> None:
    s = _score.score_subject("clouds", "steam engine piston rod")
    assert s.composite < 0.4
    assert s.passed() is False


def test_score_jaccard_handles_reordering() -> None:
    s = _score.score_subject("piston rod of engine", "engine piston rod")
    # Same tokens, different order — should pass.
    assert s.passed() is True


# ---------- fixtures validation -----------------------------------------


def test_fixture_file_parseable() -> None:
    assert _FIXTURES.exists(), f"missing fixture file: {_FIXTURES}"
    raw = json.loads(_FIXTURES.read_text())
    assert "cases" in raw
    assert isinstance(raw["cases"], list)


def test_fixture_cases_have_required_fields() -> None:
    cases = load_fixtures(_FIXTURES)
    for case in cases:
        assert case.case_id, f"case missing case_id: {case}"
        assert case.image_path, f"case {case.case_id} missing image_path"
        assert 0.0 <= case.x_pct <= 1.0
        assert 0.0 <= case.y_pct <= 1.0
        assert case.expected_subject, f"case {case.case_id} missing expected_subject"


# ---------- annotation smoke test ---------------------------------------


def test_annotate_runs_on_tiny_image() -> None:
    pytest.importorskip("PIL", reason="Pillow not installed; skipping annotation test")

    from io import BytesIO

    from PIL import Image

    from tests.click_bench._annotate import annotate_click_point

    img = Image.new("RGB", (256, 256), color=(128, 128, 128))
    buf = BytesIO()
    img.save(buf, format="JPEG")
    annotated = annotate_click_point(buf.getvalue(), 0.5, 0.5)
    assert isinstance(annotated, bytes)
    assert len(annotated) > 0
    # Verify it's still a valid JPEG.
    Image.open(BytesIO(annotated)).verify()


# ---------- live VLM bench (gated) --------------------------------------


@pytest.mark.asyncio
async def test_run_bench_against_vlm() -> None:
    if os.environ.get("CLICK_BENCH_RUN", "").lower() not in ("1", "true", "yes"):
        pytest.skip("set CLICK_BENCH_RUN=1 to run the live bench")
    if not os.environ.get("OPENROUTER_API_KEY"):
        pytest.skip("OPENROUTER_API_KEY required for live bench")

    cases = load_fixtures(_FIXTURES)
    if not cases:
        pytest.skip("fixture file has no cases — see fixtures/v1.json _meta")

    report = await run_bench(_FIXTURES)
    assert report.summary["n"] == len(cases)
    # Loose floor; tighten as fixtures grow + baseline is established.
    assert report.summary.get("subject_pass_rate", 0.0) >= 0.0


# ---------- _summarize: subject metrics + groundability rejection --------


def _make_case(
    case_id: str,
    *,
    composite: float,
    ok: bool,
    expected_groundable: bool = True,
    predicted_groundable: bool = True,
    latency: float = 100.0,
    error: str | None = None,
) -> runner.CaseResult:
    return runner.CaseResult(
        case_id=case_id,
        predicted_subject="x",
        predicted_style="",
        predicted_context="",
        expected_subject="y",
        score={"composite": composite},
        latency_ms=latency,
        ok=ok,
        error=error,
        expected_groundable=expected_groundable,
        predicted_groundable=predicted_groundable,
        predicted_confidence=0.9,
    )


def test_summarize_empty_returns_n_zero() -> None:
    assert runner._summarize([]) == {"n": 0}


def test_summarize_subject_pass_rate_over_groundable_true() -> None:
    results = [
        _make_case("a", composite=0.9, ok=True),
        _make_case("b", composite=0.5, ok=False),
    ]
    s = runner._summarize(results)
    assert s["n"] == 2
    assert s["n_groundable"] == 2
    assert s["n_passed"] == 1
    assert s["subject_pass_rate"] == 0.5
    assert s["composite_mean"] == 0.7  # (0.9 + 0.5) / 2


def test_summarize_excludes_non_groundable_from_subject_metrics() -> None:
    # A non-groundable tap has a meaningless subject score; it must not drag
    # down subject_pass_rate / composite_mean.
    results = [
        _make_case("a", composite=0.9, ok=True, expected_groundable=True),
        _make_case(
            "sky",
            composite=0.0,
            ok=False,
            expected_groundable=False,
            predicted_groundable=False,
        ),
    ]
    s = runner._summarize(results)
    assert s["n_groundable"] == 1
    assert s["subject_pass_rate"] == 1.0
    assert s["composite_mean"] == 0.9


def test_summarize_rejection_recall() -> None:
    results = [
        _make_case("a", composite=0.9, ok=True, expected_groundable=True),
        # correct rejection — VLM flagged empty space as non-groundable
        _make_case(
            "sky",
            composite=0.0,
            ok=False,
            expected_groundable=False,
            predicted_groundable=False,
        ),
        # missed rejection — VLM confabulated a subject on empty space
        _make_case(
            "deco",
            composite=0.0,
            ok=False,
            expected_groundable=False,
            predicted_groundable=True,
        ),
    ]
    s = runner._summarize(results)
    assert s["n_groundable_false"] == 2
    assert s["rejection_recall"] == 0.5


def test_summarize_groundable_accuracy_over_all_completed() -> None:
    results = [
        _make_case(
            "a", composite=0.9, ok=True, expected_groundable=True, predicted_groundable=True
        ),
        _make_case(
            "sky", composite=0.0, ok=False, expected_groundable=False, predicted_groundable=False
        ),
        _make_case(
            "deco", composite=0.0, ok=False, expected_groundable=False, predicted_groundable=True
        ),
    ]
    s = runner._summarize(results)
    assert s["groundable_accuracy"] == round(2 / 3, 4)


def test_summarize_counts_errors_separately() -> None:
    results = [
        _make_case("a", composite=0.9, ok=True),
        _make_case("err", composite=0.0, ok=False, error="boom"),
    ]
    s = runner._summarize(results)
    assert s["n"] == 2
    assert s["n_completed"] == 1
    assert s["n_errored"] == 1


# ---------- leaderboard markdown rendering (pure, no network) ------------


def _row(model: str, **summary: Any) -> dict[str, Any]:
    return {"model": model, "summary": summary}


def test_render_markdown_has_header_and_rows() -> None:
    rows = [
        _row(
            "google/gemini-3-flash-preview",
            n=10,
            subject_pass_rate=0.8,
            composite_mean=0.84,
            rejection_recall=0.75,
            groundable_accuracy=0.9,
            latency_p50_ms=820.0,
        ),
        _row(
            "qwen/qwen3-vl-8b-instruct",
            n=10,
            subject_pass_rate=0.5,
            composite_mean=0.61,
            rejection_recall=0.25,
            groundable_accuracy=0.6,
            latency_p50_ms=540.0,
        ),
    ]
    md = leaderboard.render_markdown(rows)
    assert "| Model |" in md
    assert "google/gemini-3-flash-preview" in md
    assert "qwen/qwen3-vl-8b-instruct" in md
    # A markdown table separator row must be present.
    assert "|---|" in md.replace(" ", "")


def test_render_markdown_sorts_by_subject_pass_rate_desc() -> None:
    rows = [
        _row("weak", n=5, subject_pass_rate=0.2, composite_mean=0.3),
        _row("strong", n=5, subject_pass_rate=0.9, composite_mean=0.91),
    ]
    md = leaderboard.render_markdown(rows)
    assert md.index("strong") < md.index("weak")


def test_render_markdown_tolerates_missing_metrics() -> None:
    # An errored / empty run may lack most summary keys — render must not raise.
    md = leaderboard.render_markdown([_row("broken", n=0)])
    assert "broken" in md


# ---------- multi-run aggregation (denoise, pure) -----------------------


def test_aggregate_summaries_means_and_stdev() -> None:
    runs = [
        {"n": 15, "subject_pass_rate": 0.80, "composite_mean": 0.70, "latency_p50_ms": 100.0},
        {"n": 15, "subject_pass_rate": 0.90, "composite_mean": 0.80, "latency_p50_ms": 200.0},
    ]
    agg = leaderboard.aggregate_summaries(runs)
    assert agg["runs"] == 2
    assert agg["n"] == 15  # counts carried, not averaged
    assert agg["subject_pass_rate"] == pytest.approx(0.85)
    assert agg["composite_mean"] == pytest.approx(0.75)
    # sample stdev of {0.8, 0.9} = 0.0707…
    assert agg["std"]["subject_pass_rate"] == pytest.approx(0.0707, abs=1e-3)
    assert agg["std"]["latency_p50_ms"] == pytest.approx(70.71, abs=1e-2)


def test_aggregate_summaries_single_run_zero_std() -> None:
    agg = leaderboard.aggregate_summaries([{"n": 5, "subject_pass_rate": 0.6}])
    assert agg["runs"] == 1
    assert agg["subject_pass_rate"] == pytest.approx(0.6)
    assert agg["std"]["subject_pass_rate"] == 0.0
    assert leaderboard.aggregate_summaries([]) == {"runs": 0}


def test_aggregate_summaries_skips_absent_metric() -> None:
    # gemini-2.5-pro-style: some runs error and omit a metric entirely.
    runs = [
        {"n": 3, "subject_pass_rate": 0.5, "rejection_recall": 0.4},
        {"n": 3, "subject_pass_rate": 0.7},  # no rejection_recall this run
    ]
    agg = leaderboard.aggregate_summaries(runs)
    assert agg["subject_pass_rate"] == pytest.approx(0.6)
    # single present value → mean of it, std 0 (not a crash)
    assert agg["rejection_recall"] == pytest.approx(0.4)
    assert agg["std"]["rejection_recall"] == 0.0


def test_render_markdown_shows_pm_when_std_present() -> None:
    agg = leaderboard.aggregate_summaries(
        [
            {"n": 15, "subject_pass_rate": 0.80, "composite_mean": 0.70},
            {"n": 15, "subject_pass_rate": 0.90, "composite_mean": 0.80},
        ]
    )
    md = leaderboard.render_markdown([{"model": "m", "summary": agg}])
    assert "±" in md  # variance surfaced for a multi-run row


def test_render_markdown_single_run_has_no_pm() -> None:
    # Byte-compat: a plain single-run summary (no `std`) renders without ±.
    md = leaderboard.render_markdown(
        [_row("m", n=15, subject_pass_rate=0.8, composite_mean=0.7)]
    )
    assert "±" not in md


# ---------- synthetic smoke fixtures ------------------------------------


def test_synthetic_fixtures_present_and_loadable() -> None:
    path = Path(__file__).parent / "click_bench" / "fixtures" / "synthetic.json"
    assert path.exists(), "run `python -m tests.click_bench._gen_synthetic`"
    cases = load_fixtures(path)
    assert len(cases) >= 4
    # Must include both groundable elements and empty-region rejection cases.
    assert any(c.groundable for c in cases)
    assert any(not c.groundable for c in cases)
    # Every referenced image actually exists on disk.
    for c in cases:
        assert (path.parent / c.image_path).exists(), f"missing image for {c.case_id}"
