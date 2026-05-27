"""Pytest gate for the continuity bench.

Layer 1 — pure unit tests:
  - ``_score._parse_judgement`` resilience against malformed JSON
  - ``_replay.load_session`` round-trip on the example fixture

Layer 2 — live VLM judge (skipped unless CONTINUITY_BENCH_RUN=1):
  - run_bench against a captured session manifest, with at least 2 pages
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tests.continuity_bench import _replay, _score
from tests.continuity_bench.runner import run_bench

_FIXTURE = (
    Path(__file__).parent
    / "continuity_bench"
    / "fixtures"
    / "example_session"
    / "manifest.json"
)


# ---------- parse robustness --------------------------------------------


def test_parse_judgement_strict_json() -> None:
    raw = '{"score": 7.5, "rationale": "warm palette but flatter lines"}'
    out = _score._parse_judgement(raw)
    assert out.score == 7.5
    assert "warm palette" in out.rationale


def test_parse_judgement_score_only_via_regex() -> None:
    raw = 'some prose then "score": 3 here'
    out = _score._parse_judgement(raw)
    assert out.score == 3.0


def test_parse_judgement_garbage_defaults_to_zero() -> None:
    out = _score._parse_judgement("no score anywhere in this string")
    assert out.score == 0.0


def test_parse_judgement_handles_extra_keys() -> None:
    raw = '{"score": 9, "rationale": "good", "extra": true}'
    out = _score._parse_judgement(raw)
    assert out.score == 9.0
    assert out.rationale == "good"


# ---------- replay round-trip -------------------------------------------


def test_load_example_session_manifest() -> None:
    assert _FIXTURE.exists(), f"missing fixture: {_FIXTURE}"
    session = _replay.load_session(_FIXTURE)
    assert session.session_id == "example-empty"
    assert session.pages == []


def test_load_session_with_synthetic_manifest(tmp_path: Path) -> None:
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    (images_dir / "p0.jpg").write_bytes(b"\xff\xd8\xff")
    (images_dir / "p1.jpg").write_bytes(b"\xff\xd8\xff")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "session_id": "test-2",
                "pages": [
                    {
                        "page_id": "p0",
                        "page_title": "Boilers",
                        "image_path": "images/p0.jpg",
                        "prompt": "an illustrated boiler",
                        "subject": "boiler",
                        "entities": [
                            {
                                "entity_id": "boiler",
                                "name": "Boiler",
                                "appearance": "iron, riveted",
                            }
                        ],
                    },
                    {
                        "page_id": "p1",
                        "page_title": "Pistons",
                        "image_path": "images/p1.jpg",
                        "prompt": "an illustrated piston",
                        "subject": "piston",
                        "parent_page_id": "p0",
                        "entities": [
                            {
                                "entity_id": "boiler",
                                "name": "Boiler",
                                "appearance": "iron, riveted",
                            }
                        ],
                    },
                ],
            }
        )
    )
    session = _replay.load_session(manifest)
    assert len(session.pages) == 2
    assert session.pages[0].entities[0].entity_id == "boiler"
    assert session.pages[1].parent_page_id == "p0"


# ---------- live judge (gated) ------------------------------------------


@pytest.mark.asyncio
async def test_run_continuity_bench_live() -> None:
    if os.environ.get("CONTINUITY_BENCH_RUN", "").lower() not in ("1", "true", "yes"):
        pytest.skip("set CONTINUITY_BENCH_RUN=1 to run the live judge")
    if not os.environ.get("OPENROUTER_API_KEY"):
        pytest.skip("OPENROUTER_API_KEY required for live bench")

    session = _replay.load_session(_FIXTURE)
    if len(session.pages) < 2:
        pytest.skip("fixture has fewer than 2 pages — see manifest.json _meta")

    report = await run_bench(_FIXTURE)
    assert report.summary["n_pages"] >= 2
