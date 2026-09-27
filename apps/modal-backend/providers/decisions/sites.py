"""State builders: the text a site puts to the model.

Kept beside the registry so the two call sites of a site (the in-band tap
and the hover prefetch, for click.classify) send the same shape, and so the
decision's inputs are readable in one place next to its questions.
"""
from __future__ import annotations

from typing import Any


def click_state(resolution: Any, parent_title: str, parent_query: str,
                user_hint: str | None, world_mode: bool) -> dict[str, Any]:
    """What the classifier read at the tapped point. Its own confidence and
    groundability ride along: they are the incumbent's answer, and the model
    is being asked whether the reading holds up."""
    return {
        "parent_title": parent_title[:200],
        "parent_query": parent_query[:200],
        "user_hint": (user_hint or "")[:200] or None,
        "world_mode": world_mode,
        "subject": resolution.subject,
        "subject_context": resolution.subject_context,
        "surroundings": getattr(resolution, "surroundings", None),
        "style": resolution.style,
        "enter_as": resolution.enter_as,
        "place_form": resolution.place_form or None,
        "groundable": resolution.groundable,
        "confidence": resolution.confidence,
        "clarifiers": list(resolution.clarifiers or []),
        "scale": getattr(resolution, "scale", None),
    }


def click_incumbent(resolution: Any, autonomy: str) -> dict[str, str | None]:
    """What the product does today: never asks in band (autonomy is auto),
    generates unless the classifier said the point is not groundable, and
    takes the classifier's own framing."""
    asks = bool(resolution.clarifiers) and autonomy == "semi"
    return {
        "ask_user": "yes" if asks else "no",
        "worth_generating": "no" if resolution.groundable is False else "yes",
        "enter_as": resolution.enter_as if resolution.enter_as in ("scene", "submap", "explainer") else None,
    }
