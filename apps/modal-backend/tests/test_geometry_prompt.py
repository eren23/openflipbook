"""P3 layout-clause gate (free): the placement clause is deterministic."""
from __future__ import annotations

from providers import geometry_prompt


def test_empty_layout_is_blank() -> None:
    assert geometry_prompt.layout_constraints([]) == ""


def test_layout_clause_is_deterministic() -> None:
    expected = [
        {"id": "a", "label": "Lighthouse", "size": "large", "h_pos": "center", "v_pos": "top"},
        {"id": "b", "label": "Figure", "size": "small", "h_pos": "far-left", "v_pos": "bottom"},
    ]
    assert geometry_prompt.layout_constraints(expected) == (
        "SCENE LAYOUT (place these exactly where stated — nearest listed first, "
        "keep their relative positions, sizes and front-to-back order): "
        "Lighthouse — large, center top; Figure — small, far-left bottom."
    )


def test_layout_falls_back_to_id_when_no_label() -> None:
    clause = geometry_prompt.layout_constraints(
        [{"id": "x", "size": "tiny", "h_pos": "right", "v_pos": "mid"}]
    )
    assert "x — tiny, right mid" in clause


# --- repair_instruction (P4 grounding loop) ---------------------------------

_EXPECTED = [
    {"label": "lighthouse", "size": "large", "h_pos": "center", "v_pos": "top"},
    {"label": "fishing boat", "size": "small", "h_pos": "far-left", "v_pos": "bottom"},
]


def test_repair_instruction_empty_when_nothing_actionable() -> None:
    assert geometry_prompt.repair_instruction(_EXPECTED, [], []) == ""


def test_repair_instruction_adds_missing_and_moves_misplaced() -> None:
    out = geometry_prompt.repair_instruction(
        _EXPECTED, missing=["fishing boat"], misplaced=["lighthouse"]
    )
    assert "add a fishing boat (small, far-left bottom)" in out
    assert "move the lighthouse to center top" in out
    assert out.startswith("Keep everything else exactly as it is")


def test_repair_instruction_ignores_labels_not_in_expected() -> None:
    # A label with no expected entry can't be placed → silently skipped.
    assert geometry_prompt.repair_instruction(_EXPECTED, ["dragon"], []) == ""
