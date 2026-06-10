"""Compatibility shim — the layout prompt builders moved to the prompt library.

The bodies live in providers/prompt_library/layout.py (one home for all prompt
text, see that package's docstring). generate.py and the existing tests import
from here; keep this re-export so the move is invisible to callers.
"""
from __future__ import annotations

from providers.prompt_library.layout import (
    _place_phrase,
    layout_constraints,
    repair_instruction,
)

__all__ = ["_place_phrase", "layout_constraints", "repair_instruction"]
