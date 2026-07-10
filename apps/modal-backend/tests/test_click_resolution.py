"""Tests for ClickResolution parsing helpers + groundability fields.

These are pure unit tests on the JSON → ClickResolution mapping; no
network. The live click_to_subject call is covered by the click bench
under tests/click_bench (gated behind CLICK_BENCH_RUN=1).
"""

from __future__ import annotations

import pytest

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


def test_build_parses_surroundings_and_defaults_empty() -> None:
    res = llm._build_click_resolution(
        {"subject": "x", "surroundings": "  river to the south, market NE "},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="X",
    )
    assert res.surroundings == "river to the south, market NE"
    bare = llm._build_click_resolution(
        {"subject": "x"}, x_pct=0.5, y_pct=0.5, fallback_subject="X"
    )
    assert bare.surroundings == ""


# ---------- classic-mode classification (TAP_ZOOM_CONTINUE) ------------------
#
# Classic taps classify too now: the prompt asks for `enter_as` in BOTH modes
# (wording differs), and precompute candidates carry it so warm taps can route
# to the faithful zoom without a second resolve.


def test_click_prompt_asks_enter_as_in_classic_mode(monkeypatch) -> None:
    import asyncio
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    captured: dict = {}

    async def fake_complete_json(**kwargs):
        captured["messages"] = kwargs.get("messages")
        return {"subject": "x"}

    monkeypatch.setattr(click_mod._llm, "_complete_json", AsyncMock(side_effect=fake_complete_json))
    asyncio.run(
        click_mod.click_to_subject(
            image_data_url="data:image/jpeg;base64,x",
            x_pct=0.5,
            y_pct=0.5,
            parent_title="T",
            parent_query="q",
            world_mode=False,
        )
    )
    system = str(captured["messages"][0]["content"])
    assert "`enter_as`" in system
    # classic wording, not the world-mode "step INTO" phrasing
    assert "move CLOSER to" in system
    assert "step INTO" not in system


def test_click_prompt_world_mode_wording_unchanged(monkeypatch) -> None:
    import asyncio
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    captured: dict = {}

    async def fake_complete_json(**kwargs):
        captured["messages"] = kwargs.get("messages")
        return {"subject": "x"}

    monkeypatch.setattr(click_mod._llm, "_complete_json", AsyncMock(side_effect=fake_complete_json))
    asyncio.run(
        click_mod.click_to_subject(
            image_data_url="data:image/jpeg;base64,x",
            x_pct=0.5,
            y_pct=0.5,
            parent_title="T",
            parent_query="q",
            world_mode=True,
        )
    )
    system = str(captured["messages"][0]["content"])
    assert "step INTO" in system  # the world clause is byte-identical
    assert "place_form" in system


def test_precompute_candidates_parse_enter_as(monkeypatch) -> None:
    import asyncio
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    async def fake_complete_json(**kwargs):
        return {
            "candidates": [
                {"x_pct": 0.2, "y_pct": 0.3, "subject": "castle", "salience": 0.9,
                 "enter_as": "scene"},
                {"x_pct": 0.6, "y_pct": 0.5, "subject": "legend box", "salience": 0.5,
                 "enter_as": "bogus-value"},
                {"x_pct": 0.8, "y_pct": 0.7, "subject": "harbor", "salience": 0.7},
            ]
        }

    monkeypatch.setattr(click_mod._llm, "_complete_json", AsyncMock(side_effect=fake_complete_json))
    cands = asyncio.run(
        click_mod.precompute_click_candidates(
            image_data_url="data:image/jpeg;base64,x",
            parent_title="T",
            parent_query="q",
        )
    )
    by_subject = {c.subject: c for c in cands}
    assert by_subject["castle"].enter_as == "scene"
    # non-whitelisted value coerces to the safe default
    assert by_subject["legend box"].enter_as == "explainer"
    # absent → default
    assert by_subject["harbor"].enter_as == "explainer"


# ---------- empty-roll retry (gemini-flash sometimes returns a well-formed
# ---------- empty list for scenic pages; one hotter retry flips it) -------


def _precompute(click_mod):
    import asyncio

    return asyncio.run(
        click_mod.precompute_click_candidates(
            image_data_url="data:image/jpeg;base64,x",
            parent_title="T",
            parent_query="q",
        )
    )


def test_precompute_empty_roll_retries_once_hotter(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    replies = [
        {"candidates": []},
        {"candidates": [{"x_pct": 0.2, "y_pct": 0.3, "subject": "castle", "salience": 0.9}]},
    ]
    mock = AsyncMock(side_effect=lambda **kw: replies[mock.await_count - 1])
    monkeypatch.setattr(click_mod._llm, "_complete_json", mock)
    cands = _precompute(click_mod)
    assert [c.subject for c in cands] == ["castle"]
    assert mock.await_count == 2
    # the retry runs hotter than the first roll
    temps = [kw.kwargs["temperature"] for kw in mock.await_args_list]
    assert temps == [0.2, 0.5]
    # the scene clause that removes the model's "not an explainer → empty" out
    system = str(mock.await_args_list[0].kwargs["messages"][0])
    assert "a rich scene is never empty" in system


def test_precompute_nonempty_first_roll_calls_once(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    mock = AsyncMock(
        return_value={
            "candidates": [{"x_pct": 0.5, "y_pct": 0.5, "subject": "boat", "salience": 0.7}]
        }
    )
    monkeypatch.setattr(click_mod._llm, "_complete_json", mock)
    cands = _precompute(click_mod)
    assert len(cands) == 1
    assert mock.await_count == 1  # no double VLM spend on good rolls


def test_precompute_empty_retry_kill_switch(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    monkeypatch.setenv("PRECOMPUTE_EMPTY_RETRY", "false")
    mock = AsyncMock(return_value={"candidates": []})
    monkeypatch.setattr(click_mod._llm, "_complete_json", mock)
    cands = _precompute(click_mod)
    assert cands == []
    assert mock.await_count == 1


# ---------- mixed-scale coordinate salvage (live-caught: gemini returned
# ---------- {"x_pct": 0.55, "y_pct": 71.3} — fraction and percent in ONE
# ---------- entry — and the 0..1 validator dropped all 8 candidates) ------


def test_coerce_unit_rescales_percent_values() -> None:
    from providers.llm.click import _coerce_unit

    assert _coerce_unit(0.55, percent=True) == 0.55
    assert _coerce_unit(1.0, percent=True) == 1.0  # a fraction, NOT 1%
    assert _coerce_unit(71.3, percent=True) == pytest.approx(0.713)
    assert _coerce_unit(100, percent=True) == 1.0
    assert _coerce_unit("33.1", percent=True) == pytest.approx(0.331)
    # (1, 2] is an overshot fraction, not a percentage — keeps the historical
    # clamp reading (1.5 = right-edge overshoot, not 1.5% = left edge)
    assert _coerce_unit(1.5, percent=True) == 1.0
    # beyond percent range: clamp for points, drop for candidates
    assert _coerce_unit(672, percent=True) == 1.0
    assert _coerce_unit(672, percent=True, clamp=False) is None
    assert _coerce_unit(-0.2, percent=True) == 0.0
    assert _coerce_unit(-0.2, percent=True, clamp=False) is None
    # non-coordinate fields keep plain clamp semantics: a "5" confidence is
    # an off-scale score, not 5%
    assert _coerce_unit(5) == 1.0
    assert _coerce_unit("nope") is None
    assert _coerce_unit(float("nan")) is None


def test_precompute_salvages_mixed_scale_coordinates(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    mock = AsyncMock(
        return_value={
            "candidates": [
                {"x_pct": 0.55, "y_pct": 71.3, "subject": "boat fleet", "salience": 0.95},
                {"x_pct": 33.1, "y_pct": 30.5, "subject": "red cottage", "salience": 0.8},
                # pixel garbage must DROP, not clamp into an edge tap target
                {"x_pct": 672, "y_pct": 0.4, "subject": "ghost", "salience": 0.9},
            ]
        }
    )
    monkeypatch.setattr(click_mod._llm, "_complete_json", mock)
    cands = _precompute(click_mod)
    assert mock.await_count == 1  # salvage, not a second VLM spend
    by_subject = {c.subject: c for c in cands}
    assert set(by_subject) == {"boat fleet", "red cottage"}
    assert by_subject["boat fleet"].y_pct == pytest.approx(0.713)
    assert by_subject["red cottage"].x_pct == pytest.approx(0.331)


def test_precompute_retries_when_every_entry_fails_validation(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from providers.llm import click as click_mod

    replies = [
        {"candidates": [{"x_pct": 900, "y_pct": 1200, "subject": "junk", "salience": 1}]},
        {"candidates": [{"x_pct": 0.4, "y_pct": 0.6, "subject": "harbor", "salience": 0.7}]},
    ]
    mock = AsyncMock(side_effect=lambda **kw: replies[mock.await_count - 1])
    monkeypatch.setattr(click_mod._llm, "_complete_json", mock)
    cands = _precompute(click_mod)
    assert [c.subject for c in cands] == ["harbor"]
    assert mock.await_count == 2  # validated-empty counts as an empty roll
