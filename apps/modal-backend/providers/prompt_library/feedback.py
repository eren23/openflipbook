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
    family: str | None = None,
) -> str:
    conf = _clean(conformance_rationale)
    same = _clean(same_place_rationale)
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
    return " ".join(parts)
