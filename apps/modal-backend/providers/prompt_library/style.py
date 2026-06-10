"""Medium-lock and anti-garble guard fragments — the style invariants.

The medium guard is the load-bearing line against photoreal/3D-render drift
(worst on "isometric"-register prompts and on Kontext, which takes no style
ref image — the text IS its style channel). The lettering guard stops models
baiting themselves into rendering captions as garble. One canonical source;
composers append these rather than re-typing them.
"""
from __future__ import annotations

MEDIUM_GUARD = "NOT a photograph, no photorealism"
LETTERING_GUARD = "Keep any lettering sparse and legible — no garbled text."


def medium_lock(style_anchor: str | None, *, ref_name: str = "the reference") -> str:
    """The keep-this-exact-medium sentence, with or without a named anchor.

    Mirrors the phrasing build_enter_instruction shipped with (and the enter
    eval validated at 9.33/10 medium-faithfulness): name the anchor when the
    session has one, otherwise lean on the reference image's medium. The
    default ref_name keeps the legacy string byte-identical; view-aware
    instructions pass "Image 2" when the style exemplar is a named ref."""
    text = f"Keep the exact art medium of {ref_name}"
    if style_anchor and style_anchor.strip():
        text += f" — {style_anchor.strip()} —"
    text += f" same palette and line work; {MEDIUM_GUARD}. {LETTERING_GUARD}"
    return text
