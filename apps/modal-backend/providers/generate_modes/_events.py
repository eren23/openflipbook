"""Python twins of the SSE final-event wire shapes the generate modes emit.

Hand-mirrored from packages/config/src/index.ts (the TS side is the source
of truth). tests/test_geo_schema.py pins the field names in lockstep — the
drift class that let `scene_description` ride the wire untyped. The twins
gate the FIELD SET; nested payloads stay loose dicts on purpose.
"""
from __future__ import annotations

from typing import Any, TypedDict


class EditVerdict(TypedDict):
    """Mirror of TS ``EditVerdict`` — the judged inpaint verdict on `final`."""

    alignment: float | None
    medium: float | None
    outside_change: float | None
    attempts: int
    accepted: bool


class ViewVerdict(TypedDict):
    """Mirror of TS ``ViewVerdict`` — what the render-loop / zoom critics saw
    on the KEPT attempt. Absent axes are None (that judge was not wired for
    the path), never fabricated zeros."""

    same_place: float | None
    conformance: float | None
    medium: float | None
    detail: float | None
    interior: float | None
    attempts: int
    accepted: bool


class GenerateFinalEvent(TypedDict, total=False):
    """Mirror of TS ``GenerateFinalEvent``. total=False: the additive tail
    is per-path; every build site sets the core fields in its literal."""

    type: str
    image_data_url: str
    page_title: str
    image_model: str
    prompt_author_model: str
    session_id: str
    final_prompt: str
    sources: list[dict[str, Any]]
    image_op: str
    grounding: dict[str, Any]
    edit_verdict: EditVerdict
    view_verdict: ViewVerdict
    render_unjudged: bool
    layout_suppressed: bool
    scene_view: dict[str, Any]
    session_spend_estimate: float
    trace_id: str


class GenerateAscendReadyEvent(TypedDict, total=False):
    """Mirror of TS ``GenerateAscendReadyEvent`` (OUTWARD container ready)."""

    type: str
    page_title: str
    image_data_url: str
    image_model: str
    prompt_author_model: str
    final_prompt: str
    scale_tier: str
    from_tier: str
    session_id: str
    render_unjudged: bool
    trace_id: str
