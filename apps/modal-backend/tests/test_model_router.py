"""P3 model-router gate (free). The op decision must match today's behaviour
(the regression lock) and slugs resolve env-override > default."""
from __future__ import annotations

import pytest

from providers import model_router


@pytest.mark.parametrize("rm", ["place_submap", "place_scene"])
def test_entering_a_place_or_submap_with_region_zoom_continues(rm) -> None:
    # Both ENTERING a place and cropping a sub-map are a faithful Kontext zoom of
    # the map crop (same walls/buildings/style), not a fresh reinvention.
    assert model_router.select_operation(rm, True) == "zoom_continue"


@pytest.mark.parametrize("rm", ["place_submap", "place_scene"])
def test_no_region_falls_back_to_fresh(rm) -> None:
    # No region crop to continue from → a fresh generation.
    assert model_router.select_operation(rm, False) == "fresh"


@pytest.mark.parametrize("rm", ["explainer", None])
def test_select_operation_non_enter_is_fresh(rm) -> None:
    assert model_router.select_operation(rm, True) == "fresh"


def test_resolve_model_defaults() -> None:
    assert "kontext" in (model_router.resolve_model("zoom_continue") or "")
    assert "bria" in (model_router.resolve_model("outpaint") or "")
    assert "fill" in (model_router.resolve_model("inpaint") or "")
    assert model_router.resolve_model("fresh") is None
    assert model_router.resolve_model("unknown") is None


def test_resolve_model_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_CONTINUE_MODEL", "fal-ai/custom/kontext2")
    assert model_router.resolve_model("zoom_continue") == "fal-ai/custom/kontext2"
    monkeypatch.setenv("FAL_OUTPAINT_MODEL", "fal-ai/custom/expand2")
    assert model_router.resolve_model("outpaint") == "fal-ai/custom/expand2"
