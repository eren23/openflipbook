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

import pytest

from tests.click_bench import _score
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
    assert report.summary["pass_rate"] >= 0.0
