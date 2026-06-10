"""The retry feedback clause — a critic's rationale becomes instruction text.

The render loop's voice: when a steep view transform fails its judge, the
NEXT attempt's instruction gains this clause — the judge's own diagnosis plus
the projection's register re-asserted (the prototype that proved the loop:
attempt 1 = 3.0 conformance, this clause folded in, attempt 2 = 10.0).
Pure + deterministic; both rationales None -> "".
"""
from __future__ import annotations

from providers.prompt_library.camera import register_reminder

_MAX_RATIONALE = 300  # _parse_judgement caps here already; defend anyway


def _clean(rationale: str | None) -> str:
    return (rationale or "").strip()[:_MAX_RATIONALE]


def retry_feedback_clause(
    projection: str,
    *,
    conformance_rationale: str | None = None,
    same_place_rationale: str | None = None,
    detail_rationale: str | None = None,
    family: str | None = None,
) -> str:
    conf = _clean(conformance_rationale)
    same = _clean(same_place_rationale)
    det = _clean(detail_rationale)
    parts: list[str] = []
    if conf:
        reminder = register_reminder(projection, family)
        text = (
            "IMPORTANT — your previous attempt failed the projection check. "
            f"The judge saw: {conf}"
        )
        if not text.endswith("."):
            text += "."
        if reminder:
            text += f" Correct exactly that: {reminder}"
        parts.append(text)
    if same:
        text = (
            "It also drifted from the source place — the judge saw: "
            f"{same}"
        )
        if not text.endswith("."):
            text += "."
        text += (
            " It must remain recognisably the SAME place as the reference; "
            "only the camera changes."
        )
        parts.append(text)
    if det:
        text = (
            "It also lost interior richness — the judge saw: "
            f"{det}"
        )
        if not text.endswith("."):
            text += "."
        text += (
            " Keep the place's internal structure fully articulated: open "
            "courtyards stay open with their inner buildings drawn; do not "
            "simplify or seal the compound."
        )
        parts.append(text)
    return " ".join(parts)


def edit_retry_feedback_clause(
    *,
    alignment_rationale: str | None = None,
    medium_rationale: str | None = None,
    outside_exceeded: bool = False,
) -> str:
    """The edit loop's voice (the mask-scoped sibling of the clause above):
    a failed inpaint attempt folds its critics' diagnoses into the next
    attempt's fill description. Pure + deterministic; all-None/False -> ""."""
    parts: list[str] = []
    align = _clean(alignment_rationale)
    medium = _clean(medium_rationale)
    if align:
        text = (
            "IMPORTANT — your previous attempt did not show the requested "
            f"content. The judge saw: {align}"
        )
        if not text.endswith("."):
            text += "."
        text += " Render exactly what is described, clearly visible in the region."
        parts.append(text)
    if medium:
        text = (
            "It also drifted from the surrounding artwork's medium — the "
            f"judge saw: {medium}"
        )
        if not text.endswith("."):
            text += "."
        text += (
            " Match the surrounding artwork's medium, palette and linework "
            "exactly; the repainted region must blend in seamlessly."
        )
        parts.append(text)
    if outside_exceeded:
        parts.append(
            "It also changed pixels beyond the selected region. Confine the "
            "edit STRICTLY to the masked area; everything outside it must "
            "remain untouched."
        )
    return " ".join(parts)
