"""Tests for ClickResolution parsing helpers + groundability fields.

These are pure unit tests on the JSON → ClickResolution mapping; no
network. The live click_to_subject call is covered by the click bench
under tests/click_bench (gated behind CLICK_BENCH_RUN=1).
"""

from __future__ import annotations

from providers import llm

# ---------- _coerce_unit --------------------------------------------------


def test_coerce_unit_passes_through_in_range() -> None:
    assert llm._coerce_unit(0.0) == 0.0
    assert llm._coerce_unit(0.42) == 0.42
    assert llm._coerce_unit(1.0) == 1.0


def test_coerce_unit_clamps_below_zero() -> None:
    assert llm._coerce_unit(-0.5) == 0.0


def test_coerce_unit_clamps_above_one() -> None:
    assert llm._coerce_unit(1.7) == 1.0


def test_coerce_unit_handles_string_numerics() -> None:
    assert llm._coerce_unit("0.25") == 0.25


def test_coerce_unit_rejects_non_numeric() -> None:
    assert llm._coerce_unit("nope") is None
    assert llm._coerce_unit(None) is None
    assert llm._coerce_unit({}) is None


# ---------- _parse_point / _parse_bbox ------------------------------------


def test_parse_point_dict_form() -> None:
    assert llm._parse_point({"x": 0.4, "y": 0.6}) == (0.4, 0.6)


def test_parse_point_list_form() -> None:
    assert llm._parse_point([0.1, 0.9]) == (0.1, 0.9)


def test_parse_point_clamps_out_of_range() -> None:
    assert llm._parse_point({"x": 1.5, "y": -0.2}) == (1.0, 0.0)


def test_parse_point_returns_none_when_invalid() -> None:
    assert llm._parse_point(None) is None
    assert llm._parse_point("not a point") is None
    assert llm._parse_point({"x": 0.4}) is None  # missing y


def test_parse_bbox_dict_form() -> None:
    bbox = llm._parse_bbox({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})
    assert bbox == (0.1, 0.2, 0.3, 0.4)


def test_parse_bbox_accepts_width_height_keys() -> None:
    bbox = llm._parse_bbox({"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4})
    assert bbox == (0.1, 0.2, 0.3, 0.4)


def test_parse_bbox_rejects_zero_dimension() -> None:
    assert llm._parse_bbox({"x": 0.1, "y": 0.2, "w": 0.0, "h": 0.4}) is None


def test_parse_bbox_list_form() -> None:
    assert llm._parse_bbox([0.1, 0.2, 0.3, 0.4]) == (0.1, 0.2, 0.3, 0.4)


# ---------- _build_click_resolution ---------------------------------------


def test_build_full_payload_round_trip() -> None:
    payload = {
        "subject": "Boiler",
        "style": "flat infographic, blue accents",
        "subject_context": "steam generator at the heart of the engine",
        "groundable": True,
        "confidence": 0.85,
        "point": {"x": 0.42, "y": 0.61},
        "bbox": {"x": 0.30, "y": 0.50, "w": 0.30, "h": 0.30},
    }
    res = llm._build_click_resolution(
        payload, x_pct=0.42, y_pct=0.61, fallback_subject="Steam Engine"
    )
    assert res.subject == "Boiler"
    assert res.style.startswith("flat infographic")
    assert res.groundable is True
    assert res.confidence == 0.85
    assert res.point == (0.42, 0.61)
    assert res.bbox == (0.30, 0.50, 0.30, 0.30)


def test_build_missing_groundability_defaults_to_true() -> None:
    payload = {"subject": "Boiler", "style": "", "subject_context": ""}
    res = llm._build_click_resolution(
        payload, x_pct=0.5, y_pct=0.5, fallback_subject="X"
    )
    assert res.groundable is True
    assert res.confidence == 1.0


def test_build_groundable_false_preserved() -> None:
    payload = {
        "subject": "background sky",
        "style": "",
        "subject_context": "",
        "groundable": False,
        "confidence": 0.1,
    }
    res = llm._build_click_resolution(
        payload, x_pct=0.5, y_pct=0.5, fallback_subject="X"
    )
    assert res.groundable is False
    assert res.confidence == 0.1


def test_build_groundable_string_false_treated_as_false() -> None:
    payload = {"subject": "x", "style": "", "subject_context": "", "groundable": "false"}
    res = llm._build_click_resolution(
        payload, x_pct=0.0, y_pct=0.0, fallback_subject="X"
    )
    assert res.groundable is False


def test_build_missing_point_uses_crosshair_position() -> None:
    payload = {"subject": "Boiler", "style": "", "subject_context": ""}
    res = llm._build_click_resolution(
        payload, x_pct=0.33, y_pct=0.77, fallback_subject="X"
    )
    assert res.point == (0.33, 0.77)


def test_build_invalid_point_falls_back_to_crosshair() -> None:
    payload = {
        "subject": "x",
        "style": "",
        "subject_context": "",
        "point": "not a point",
    }
    res = llm._build_click_resolution(
        payload, x_pct=0.1, y_pct=0.2, fallback_subject="X"
    )
    assert res.point == (0.1, 0.2)


def test_build_invalid_bbox_drops_to_none() -> None:
    payload = {
        "subject": "x",
        "style": "",
        "subject_context": "",
        "bbox": [0.0, 0.0, 0.0, 0.0],  # zero-size
    }
    res = llm._build_click_resolution(
        payload, x_pct=0.0, y_pct=0.0, fallback_subject="X"
    )
    assert res.bbox is None


def test_build_uses_fallback_subject_when_payload_empty() -> None:
    res = llm._build_click_resolution(
        {}, x_pct=0.5, y_pct=0.5, fallback_subject="Parent Title"
    )
    assert res.subject == "Parent Title"


def test_build_oob_confidence_clamps_to_unit_range() -> None:
    payload = {"subject": "x", "style": "", "subject_context": "", "confidence": 5.0}
    res = llm._build_click_resolution(
        payload, x_pct=0.0, y_pct=0.0, fallback_subject="X"
    )
    assert res.confidence == 1.0


def test_build_negative_confidence_clamps_to_zero() -> None:
    payload = {"subject": "x", "style": "", "subject_context": "", "confidence": -0.5}
    res = llm._build_click_resolution(
        payload, x_pct=0.0, y_pct=0.0, fallback_subject="X"
    )
    assert res.confidence == 0.0


def test_build_garbage_confidence_falls_back_to_one() -> None:
    payload = {
        "subject": "x",
        "style": "",
        "subject_context": "",
        "confidence": "very sure",
    }
    res = llm._build_click_resolution(
        payload, x_pct=0.0, y_pct=0.0, fallback_subject="X"
    )
    assert res.confidence == 1.0


# ---------- World Mode: enter_as + clarifiers -----------------------------


def test_build_defaults_enter_as_explainer_and_no_clarifiers() -> None:
    # Classic (non-world) payloads omit these → explainer, no questions.
    res = llm._build_click_resolution(
        {"subject": "x"}, x_pct=0.5, y_pct=0.5, fallback_subject="X"
    )
    assert res.enter_as == "explainer"
    assert res.clarifiers == []


def test_build_parses_enter_as_scene() -> None:
    res = llm._build_click_resolution(
        {"subject": "The Shades", "enter_as": "scene"},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="X",
    )
    assert res.enter_as == "scene"


def test_build_invalid_enter_as_falls_back_to_explainer() -> None:
    res = llm._build_click_resolution(
        {"subject": "x", "enter_as": "teleport"},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="X",
    )
    assert res.enter_as == "explainer"


def test_build_clarifiers_caps_at_two_and_filters_non_strings() -> None:
    res = llm._build_click_resolution(
        {"subject": "x", "clarifiers": ["Day or night?", "  ", "Busy?", "Third?", 5]},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="X",
    )
    assert res.clarifiers == ["Day or night?", "Busy?"]
