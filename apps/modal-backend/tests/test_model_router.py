"""P3 model-router gate (free). The op decision must match today's behaviour
(the regression lock) and slugs resolve env-override > default."""
from __future__ import annotations

import pytest

from providers import model_router


def test_submap_with_region_zoom_continues() -> None:
    # A sub-map is a faithful closer MAP of the crop — same viewpoint, same
    # walls/style — so it strict-zoom-continues (Kontext).
    assert model_router.select_operation("place_submap", True) == "zoom_continue"


def test_scene_is_fresh_conditioned_not_a_zoom() -> None:
    # Stepping INSIDE a place is a view CHANGE (exterior -> interior), not a strict
    # zoom of the crop — Kontext can only zoom it ("just a zoom"). So a scene is a
    # fresh, reference-conditioned gen that keeps the place's architecture/style
    # from the crop while actually going within.
    assert model_router.select_operation("place_scene", True) == "fresh"


def test_no_region_falls_back_to_fresh() -> None:
    # No region crop to continue from → a fresh generation.
    assert model_router.select_operation("place_submap", False) == "fresh"
    assert model_router.select_operation("place_scene", False) == "fresh"


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
