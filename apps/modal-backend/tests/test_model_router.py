"""P3 model-router gate (free). The op decision must match today's behaviour
(the regression lock) and slugs resolve env-override > default."""
from __future__ import annotations

import pytest

from providers import model_router


def test_submap_with_region_zoom_continues() -> None:
    # A sub-map is a faithful closer MAP of the crop — same viewpoint, same
    # walls/style — so it strict-zoom-continues (Kontext).
    assert model_router.select_operation("place_submap", True) == "zoom_continue"


def test_scene_enters_via_edit_op() -> None:
    # Stepping INSIDE a place is a view CHANGE (overhead -> ground level) that
    # must stay VISUALLY conditioned on the tapped region. Text-to-image ignores
    # refs (research/01), so the scene routes through the edit endpoint — with or
    # without a region crop (the call site falls back to the parent image).
    assert model_router.select_operation("place_scene", True) == "enter_scene"
    assert model_router.select_operation("place_scene", False) == "enter_scene"


def test_submap_without_region_falls_back_to_fresh() -> None:
    # No region crop to continue from → a fresh generation.
    assert model_router.select_operation("place_submap", False) == "fresh"


@pytest.mark.parametrize("rm", ["explainer", None])
def test_select_operation_non_enter_is_fresh(rm) -> None:
    assert model_router.select_operation(rm, True) == "fresh"


def test_resolve_model_defaults() -> None:
    assert "kontext" in (model_router.resolve_model("zoom_continue") or "")
    assert "bria" in (model_router.resolve_model("outpaint") or "")
    assert "fill" in (model_router.resolve_model("inpaint") or "")
    # The enter op must resolve to an EDIT endpoint — refs are a no-op anywhere else.
    assert "/edit" in (model_router.resolve_model("enter_scene") or "")
    assert model_router.resolve_model("fresh") is None
    assert model_router.resolve_model("unknown") is None


def test_resolve_model_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_CONTINUE_MODEL", "fal-ai/custom/kontext2")
    assert model_router.resolve_model("zoom_continue") == "fal-ai/custom/kontext2"
    monkeypatch.setenv("FAL_OUTPAINT_MODEL", "fal-ai/custom/expand2")
    assert model_router.resolve_model("outpaint") == "fal-ai/custom/expand2"
    monkeypatch.setenv("FAL_ENTER_MODEL", "fal-ai/flux-pro/kontext")
    assert model_router.resolve_model("enter_scene") == "fal-ai/flux-pro/kontext"


# ── B2 OUTWARD op selection (pure, by tier delta) ────────────────────────────
@pytest.mark.parametrize(
    "from_tier,to_tier",
    [
        ("city", "region"),  # same-plane surface hop
        ("place", "district"),
        ("region", "world"),
        ("world", "planet"),  # still surface (planet is the surface, not orbital)
    ],
)
def test_select_outward_op_surface_hop_is_outpaint(from_tier, to_tier) -> None:
    # The source's pixels survive as the central sub-region → centered BRIA outpaint.
    assert model_router.select_outward_op(from_tier, to_tier) == "outpaint_zoomout"


@pytest.mark.parametrize(
    "from_tier,to_tier",
    [
        ("planet", "star_system"),  # surface -> orbital: a new framing
        ("star_system", "galaxy"),
        ("galaxy", "universe"),
    ],
)
def test_select_outward_op_medium_flip_is_fresh(from_tier, to_tier) -> None:
    assert model_router.select_outward_op(from_tier, to_tier) == "scale_parent_fresh"


def test_select_outward_op_unknown_tier_defaults_to_outpaint() -> None:
    # An unknown rung is treated as same-plane — the safe, style-conserving path.
    assert model_router.select_outward_op("city", "bogus") == "outpaint_zoomout"


def test_resolve_model_outward_slots() -> None:
    # outpaint_zoomout reuses the BRIA slot; the medium-flip fresh op is tier-based.
    assert "bria" in (model_router.resolve_model("outpaint_zoomout") or "")
    assert model_router.resolve_model("scale_parent_fresh") is None


def test_coarser_tier_steps_outward() -> None:
    assert model_router.coarser_tier("city") == "region"
    assert model_router.coarser_tier("region") == "world"
    assert model_router.coarser_tier("place") == "district"
    assert model_router.coarser_tier("universe") is None  # already the coarsest
    assert model_router.coarser_tier("bogus") is None  # unknown rung
