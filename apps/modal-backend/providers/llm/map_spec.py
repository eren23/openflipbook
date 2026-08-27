"""DETAILED_MAP: expand a short query into a full cartographer's spec.

The planner compresses every query into a <=120-word image prompt, so a
one-line query can never yield a dense map (live receipt, 2026-08-24: the
hand-written Ankh-Morpork spec rendered VERBATIM produced a map in a
different league from the planner path). This module makes that recipe a
mode: one text-LLM call turns the query into a structured spec — global
style, frame furniture, a spine feature, positioned districts and
landmarks on a 100x100 grid, label tiers, detail density, negative
constraints — and the caller renders the spec DIRECTLY.

Fail-open by design: any error returns None and the caller falls back to
the ordinary plan_page path, so the flag can never break a generation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from providers import llm as _llm

from .client import _system_message, _text_model

SPEC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "page_title": {"type": "string"},
        "spec": {"type": "string"},
    },
    "required": ["page_title", "spec"],
}

_SYSTEM = (
    "You are a master fantasy cartographer writing a COMPLETE rendering "
    "specification for a single, extremely detailed 2D top-down map, to be "
    "given verbatim to a text-capable image model. Return JSON with keys: "
    'page_title (<=8 words, the place\'s name) and spec (the full spec text). '
    "The spec MUST contain these sections, in order:\n"
    "1. One opening sentence: what the map depicts, 16:9 landscape, the art "
    "medium (match the requested style; default to an antique hand-inked "
    "cartographer's chart with muted watercolor washes).\n"
    "2. COORDINATE CONVENTION: a 100x100 grid, x left-to-right, y "
    "top-to-bottom; positions below given as (x, y); everything fully inside "
    "the canvas with a 2% margin.\n"
    "3. GLOBAL STYLE: base material, ink color, 3-5 named wash colors with "
    "roles, what gold/accent is reserved for, and 'no pure black, no "
    "saturated colors, flat 2D plan view, no perspective, no isometric'.\n"
    "4. FRAME FURNITURE: a title cartouche with the place name, a compass "
    "rose, a legend box with 4-6 symbol rows, a scale bar — each at fixed "
    "(x, y) positions.\n"
    "5. A SPINE FEATURE (river, chasm, grand avenue, coastline...) with 5-8 "
    "(x, y) control points and how it divides or organizes the map.\n"
    "6. DISTRICTS: 5-8 named districts, each with an (x, y) extent, one "
    "sentence of character, and 2-4 named landmarks at (x, y) positions "
    "with one visual detail each. Invent evocative, internally consistent "
    "names that fit the query's world.\n"
    "7. ROADS/CONNECTIONS: 3-5 named routes with start/end positions.\n"
    "8. TYPOGRAPHY RULES: three label tiers (district / landmark / "
    "street-and-jokes), 'every label crisply legible and correctly "
    "spelled; fewer, larger, correct labels beat many mangled ones; no "
    "label overlaps another'.\n"
    "9. DETAIL DENSITY: 40-80 individual building footprints per district "
    "block, oriented to streets, plus 3-5 tiny life details (smoke wisps, "
    "boats, animals, laundry lines).\n"
    "10. NEGATIVE CONSTRAINTS: no modern objects, no photorealism, no 3D, "
    "no watermark, no empty dead areas — every part of the map contains "
    "streets/terrain detail.\n"
    "Write the spec as compact section blocks. Do not include any text "
    "outside the JSON."
)


@dataclass
class MapSpec:
    page_title: str
    spec: str


async def expand_map_spec(
    query: str,
    *,
    style_anchor: str | None = None,
    output_locale: str | None = None,
    label_free: bool = False,
) -> MapSpec | None:
    """One LLM call: query -> full cartographer spec. None on any failure."""
    from obs import log, span

    user = f"Query: {query.strip()}"
    if style_anchor:
        user += f"\n\nArt style to match exactly: {style_anchor}"
    if output_locale and output_locale.lower() not in ("en", "auto"):
        user += (
            f"\n\nAll in-map lettering and names in locale: {output_locale}"
        )
    if label_free:
        user += (
            "\n\nIMPORTANT: the image must contain NO lettering at all — "
            "replace the typography section with 'no text anywhere; the "
            "interface overlays names separately'. Keep positions and density."
        )
    try:
        text_model = _text_model(online=False)
        async with span("planner.map_spec", model=text_model) as ctx:
            parsed = await _llm._complete_json(
                model=text_model,
                messages=[
                    _system_message(_SYSTEM),
                    {"role": "user", "content": user},
                ],
                schema=SPEC_SCHEMA,
                schema_name="map_spec",
                temperature=0.8,
                # The whole point is length — a full spec runs 1.5-2.5k
                # tokens. Cap well above it (cap, not purchase).
                max_tokens=3600,
                span_ctx=ctx,
            )
        title = " ".join(str(parsed.get("page_title", "")).split())
        spec = str(parsed.get("spec", "")).strip()
        # A spec shorter than a planner prompt defeats the mode — fall back.
        if not title or len(spec) < 600:
            log("warn", "map_spec.thin", spec_chars=len(spec))
            return None
        return MapSpec(page_title=title[:80], spec=spec)
    except Exception as exc:
        log("warn", "map_spec.failed", error=f"{type(exc).__name__}: {exc}")
        return None
