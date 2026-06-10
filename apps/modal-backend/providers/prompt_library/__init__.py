"""The prompt library — every reusable piece of prompt/instruction text.

Composable, pure, deterministic builders for the language the image models
actually consume: camera/projection clauses (the view grammar), spatial layout
constraints, enter/zoom/outward instruction templates, and medium/style locks.
One home instead of fragments scattered across llm.py / image.py /
image_edit.py / generate.py — so wording is unit-tested, per-model-family
variants live next to each other, and research findings land as one-file diffs.

Modules:
  types        — ViewSpec TypedDict (mirror of the wire shape in generate.py)
  layout       — SCENE LAYOUT constraints + grounding repair instruction
  style        — medium-lock / anti-garble guard fragments
  camera       — camera_clause: the deliberate projection named in-prompt
  instructions — enter/zoom/outward templates (view- and family-aware)
  policy       — (place, scale, enter_as) → default ViewSpec
"""
from __future__ import annotations

from providers.prompt_library.camera import (
    camera_clause,
    gaze_to_compass,
    keep_view_clause,
    model_family,
)
from providers.prompt_library.instructions import (
    build_enter_instruction,
    build_zoom_instruction,
    outward_clause,
)
from providers.prompt_library.layout import layout_constraints, repair_instruction
from providers.prompt_library.policy import default_view, estimate_to_view_spec
from providers.prompt_library.style import medium_lock
from providers.prompt_library.types import ViewSpec

__all__ = [
    "ViewSpec",
    "build_enter_instruction",
    "build_zoom_instruction",
    "camera_clause",
    "default_view",
    "estimate_to_view_spec",
    "gaze_to_compass",
    "keep_view_clause",
    "layout_constraints",
    "medium_lock",
    "model_family",
    "outward_clause",
    "repair_instruction",
]
