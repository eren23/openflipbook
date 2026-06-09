"""FIX 1b — view/camera estimator parse is exact + tolerant (pure; no VLM)."""
from __future__ import annotations

from providers.view_estimator import DEFAULT_VIEW, parse_view


def test_parse_valid_oblique() -> None:
    # scale_tier absent in the reply → falls back off the level (map → city).
    assert parse_view(
        {"level": "map", "projection": "oblique", "pitch_deg": -45}
    ) == {"level": "map", "projection": "oblique", "pitch_deg": -45.0, "scale_tier": "city"}


def test_parse_unknown_values_fall_back() -> None:
    out = parse_view({"level": "satellite", "projection": "weird", "pitch_deg": "x"})
    assert out == {
        "level": "map",
        "projection": "top_down",
        "pitch_deg": -90.0,
        "scale_tier": "city",
    }


def test_parse_scale_tier_explicit_and_fallback() -> None:
    # An explicit valid rung passes through unchanged.
    assert parse_view(
        {"level": "map", "projection": "top_down", "pitch_deg": -90, "scale_tier": "region"}
    )["scale_tier"] == "region"
    # An unknown rung falls back deterministically off the level (eye → room).
    assert parse_view(
        {"level": "eye", "projection": "perspective", "pitch_deg": 0, "scale_tier": "bogus"}
    )["scale_tier"] == "room"
    # An absent rung also falls back off the level (building → place).
    assert parse_view(
        {"level": "building", "projection": "oblique", "pitch_deg": -30}
    )["scale_tier"] == "place"


def test_parse_clamps_pitch() -> None:
    assert parse_view({"level": "street", "projection": "perspective", "pitch_deg": 200})["pitch_deg"] == 90.0
    assert parse_view({"level": "eye", "projection": "perspective", "pitch_deg": -200})["pitch_deg"] == -90.0


def test_parse_non_dict_is_default_top_down() -> None:
    assert parse_view(None) == DEFAULT_VIEW
    assert parse_view("nope") == DEFAULT_VIEW
    assert parse_view([1, 2]) == DEFAULT_VIEW
