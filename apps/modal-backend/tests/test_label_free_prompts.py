"""DOM-labels mode gate (free): label_free planner instructions ask for
text-free pages, the zoom instruction swaps the lettering guard for the full
no-text directive, and — critically — the DEFAULT (flag off) stays
byte-identical everywhere."""
from __future__ import annotations

from providers.llm import _render_base_instruction
from providers.prompt_library.instructions import build_zoom_instruction
from providers.prompt_library.style import LETTERING_GUARD, NO_LETTERING


def test_default_instructions_byte_identical() -> None:
    for mode in ("explainer", "place_submap", "place_scene", None):
        assert _render_base_instruction(mode) == _render_base_instruction(
            mode, label_free=False
        )
    assert build_zoom_instruction("T", ["f"]) == build_zoom_instruction(
        "T", ["f"], label_free=False
    )


def test_label_free_submap_asks_for_no_lettering() -> None:
    base = _render_base_instruction("place_submap")
    free = _render_base_instruction("place_submap", label_free=True)
    assert "laid out and named" in base
    assert "laid out and named" not in free
    assert "no lettering" in free.lower()


def test_label_free_explainer_swaps_labels_for_layout() -> None:
    base = _render_base_instruction("explainer")
    free = _render_base_instruction("explainer", label_free=True)
    assert "include labels" in base
    assert "NO text in the" in free
    assert "visible as labels" not in free


def test_label_free_scene_unchanged() -> None:
    # Scenes never carried labels — label_free must not perturb them.
    assert _render_base_instruction("place_scene") == _render_base_instruction(
        "place_scene", label_free=True
    )


def test_zoom_instruction_swaps_lettering_guard() -> None:
    base = build_zoom_instruction("The Palace", ["the maze garden"])
    free = build_zoom_instruction(
        "The Palace", ["the maze garden"], label_free=True
    )
    assert LETTERING_GUARD in base
    assert LETTERING_GUARD not in free
    assert NO_LETTERING in free
    # Everything else identical.
    assert base.replace(LETTERING_GUARD, NO_LETTERING) == free
