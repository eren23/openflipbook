"""Recorded-reply regression gate for the VLM JSON parse boundary — FREE, ms.

Each fixture in tests/fixtures/vlm_replies/ is a REAL (or faithfully
reconstructed) raw model reply that once broke — or would break — a parse
site. The table below runs every fixture through `salvage_json` plus the
consuming coercer and pins the outcome, so a regression in the shared
boundary or a new model quirk (drop the captured reply in as a new fixture)
fails the suite in seconds instead of surfacing as a silent located=0 in
prod. Origin story: Gemini pretty-prints AND duplicates keys (w+width),
truncating detector replies past max_tokens; the old brace-slice parse then
collapsed everything to [] with no signal, and mis-anchored extractor boxes
won by default.
"""
from __future__ import annotations

from pathlib import Path

from providers.detector import parse_detections
from providers.llm import salvage_json
from providers.llm.extraction import _build_extraction
from providers.segmenter import parse_segments

_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "vlm_replies"


def _raw(name: str) -> str:
    return (_FIXTURES / name).read_text()


def test_gemini_pretty_duplicate_keys_parses_clean() -> None:
    # Captured live 2026-07-02: pretty-printed, every box carrying duplicate
    # w/width h/height keys. Parses clean (JSON last-key-wins) — 4 boxes.
    payload, failure = salvage_json(_raw("detector_gemini_pretty_duplicate_keys.txt"))
    assert failure is None
    dets = parse_detections(payload)
    assert [d["label"] for d in dets] == [
        "The Crystal Lighthouse",
        "Aethelgard Harbor",
        "Aethelgard Marketplace",
        "Aethelgard Trade Ships",
    ]
    assert dets[0]["x_pct"] == 0.135 and dets[0]["h_pct"] == 0.405


def test_truncated_detector_reply_salvages_complete_boxes() -> None:
    # The max_tokens=length cut, mid-third-detection: the two complete boxes
    # are salvaged and the failure reason is loud — never a silent [].
    payload, failure = salvage_json(_raw("detector_truncated_length.txt"))
    assert failure is not None and "salvaged 2" in failure
    dets = parse_detections(payload)
    assert [d["label"] for d in dets] == [
        "The Crystal Lighthouse",
        "Aethelgard Harbor",
    ]


def test_minified_clean_detector_reply() -> None:
    payload, failure = salvage_json(_raw("detector_minified_clean.txt"))
    assert failure is None
    assert [d["label"] for d in parse_detections(payload)] == ["boiler", "chimney"]


def test_truncated_extraction_reply_salvages_complete_entities() -> None:
    payload, failure = salvage_json(_raw("extraction_truncated.txt"))
    assert failure is not None and "salvaged 1" in failure
    result = _build_extraction(payload)
    assert [e.name for e in result.added] == ["The Crystal Lighthouse"]
    assert result.updated == []


def test_truncated_segmenter_reply_salvages_complete_polygons() -> None:
    payload, failure = salvage_json(_raw("segmenter_polygon_truncated.txt"))
    assert failure is not None and "salvaged 1" in failure
    segs = parse_segments(payload)
    assert [s["label"] for s in segs] == ["tower"]
    assert len(segs[0]["polygon"]) == 4


def test_prose_refusal_is_loud_and_empty() -> None:
    payload, failure = salvage_json("I cannot help with that request.")
    assert failure == "unparseable"
    assert parse_detections(payload) == []
