"""P3 model-router gate (free). The op decision must match today's behaviour
(the regression lock) and slugs resolve env-override > default."""
from __future__ import annotations

import pytest

from providers import model_router


def test_select_operation_submap_with_region_continues() -> None:
    assert model_router.select_operation("place_submap", True) == "zoom_continue"


def test_select_operation_submap_without_region_is_fresh() -> None:
    assert model_router.select_operation("place_submap", False) == "fresh"


@pytest.mark.parametrize("rm", ["place_scene", "explainer", None])
def test_select_operation_non_submap_is_fresh(rm) -> None:
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
