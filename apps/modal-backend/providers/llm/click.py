"""Click/stroke resolution: tap -> subject + style, plus the hover-prefetch
click-candidate precompute. Moved verbatim from the old providers/llm.py.

`_complete_json` is called through the package namespace (`_llm.*`) so tests
that monkeypatch `providers.llm._client` / `_complete_json` still intercept.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from providers import llm as _llm

from .client import _coerce_scale, _system_message, _vlm_model


@dataclass
class ClickResolution:
    subject: str
    style: str
    # One-sentence definition of `subject` *as it appears in the parent
    # illustration*. The VLM is the only call site that actually sees the
    # parent image, so it's the right place to disambiguate ambiguous
    # phrases ("Memory Bank" in a SAM 2 diagram vs in a Cursor agent doc).
    # Threaded into plan_page as ground truth so the planner can't drift
    # domains even when web search surfaces a more popular meaning.
    subject_context: str = ""
    # Groundability: did the VLM actually see something meaningful under the
    # crosshair, or is it confabulating? GroundingME (arXiv:2512.17495)
    # reports ~0% rejection rate on current VLMs, so we ask explicitly.
    # ``confidence`` is 0..1; the client can render a "tap something
    # specific?" hint when low. Default True/1.0 keeps the field backward-
    # compatible when older callers / models omit it.
    groundable: bool = True
    confidence: float = 1.0
    # VLM's own best-estimate centroid + bounding box of the resolved
    # subject (0..1 normalised in the image's own frame). Powers the
    # "we think you tapped this — yes/try again" overlay UX. Both optional
    # because not every VLM emits them; older payloads default to None.
    point: tuple[float, float] | None = None
    bbox: tuple[float, float, float, float] | None = None
    # Scale of `subject` relative to the parent's focal subject: "component"
    # (a part of it / smaller), "peer" (beside it / similar), or "container"
    # (it is part of this / bigger). Powers the scale-space map + zoom
    # level-of-detail. Default "peer" keeps older payloads valid.
    scale: str = "peer"
    # World Mode: the VLM's read of what the tapped thing is — "scene" (a place
    # to step INTO), "submap" (a sub-area to map closer), or "explainer" (an
    # object/concept to diagram). Drives the planner's render framing. Default
    # "explainer" keeps classic tap=learn behaviour for non-world callers.
    enter_as: str = "explainer"
    # World Mode: the tapped place's FORM ("interior" | "complex" | "landscape"
    # | "generic"), judged from the IMAGE so it is locale-proof — the view
    # policy's strongest scene signal (beats the English word tables). Empty
    # for classic callers / older payloads.
    place_form: str = ""
    # Semi-autonomy: up to two short clarifying questions to ask before entering
    # (e.g. "Day or night?"). Empty in auto mode and in classic (non-world) mode.
    clarifiers: list[str] = field(default_factory=list)
    # World Mode spatial anchor: what is adjacent to the tapped spot and in which
    # direction, so the entered place keeps its neighbours where the parent map
    # had them. Empty in classic mode.
    surroundings: str = ""


@dataclass
class ClickCandidate:
    """One pre-resolved tappable region for a freshly rendered page.

    Coordinates are 0..1 normalised in the parent image's own frame. Used to
    warm the hover-prefetch cache so a click that lands inside a candidate
    bucket skips the VLM round-trip entirely.
    """

    x_pct: float
    y_pct: float
    subject: str
    style: str
    salience: float
    # scene | submap | explainer — same classification as ClickResolution, so a
    # warm tap on a precomputed bucket can route to the faithful zoom without a
    # second resolve (TAP_ZOOM_CONTINUE).
    enter_as: str = "explainer"


# JSON Schemas for the structured-output ladder. Used as the `tool` rung's
# function parameters and as a shape hint for the `prompt` rung. They are an
# upstream nudge only — the `_build_*` / `_parse_*` coercers below remain the
# source of truth, which is why a weak model degrades to "thinner but valid".
CLICK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "style": {"type": "string"},
        "subject_context": {"type": "string"},
        "groundable": {"type": "boolean"},
        "confidence": {"type": "number"},
        "point": {
            "type": "object",
            "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
        },
        "bbox": {
            "type": "object",
            "properties": {
                "x": {"type": "number"},
                "y": {"type": "number"},
                "w": {"type": "number"},
                "h": {"type": "number"},
            },
        },
        "scale": {"type": "string", "enum": ["component", "peer", "container"]},
        "enter_as": {"type": "string", "enum": ["scene", "submap", "explainer"]},
        "place_form": {
            "type": "string",
            "enum": ["interior", "complex", "landscape", "generic"],
        },
        "clarifiers": {"type": "array", "items": {"type": "string"}},
        "surroundings": {"type": "string"},
    },
    "required": ["subject"],
}


CANDIDATES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "x_pct": {"type": "number"},
                    "y_pct": {"type": "number"},
                    "subject": {"type": "string"},
                    "style": {"type": "string"},
                    "salience": {"type": "number"},
                    "enter_as": {
                        "type": "string",
                        "enum": ["scene", "submap", "explainer"],
                    },
                },
                "required": ["x_pct", "y_pct", "subject"],
            },
        }
    },
    "required": ["candidates"],
}


async def click_to_subject(
    image_data_url: str,
    x_pct: float,
    y_pct: float,
    parent_title: str,
    parent_query: str,
    output_locale: str | None = None,
    user_hint: str | None = None,
    prior_rejected_subject: str | None = None,
    world_mode: bool = False,
    autonomy: str = "auto",
) -> ClickResolution:
    """Resolve the click region to a subject phrase AND a style descriptor.

    The image has a red crosshair at the click point (see
    `apps/web/lib/image-click.ts:annotateClickPoint`); numeric coords are a
    fallback. We also ask the VLM to summarise the illustration's visual
    style so the next page can match it — cheapest way to keep aesthetic
    continuity across hops without a second VLM round-trip.

    Also asks the VLM to self-report ``groundable`` + ``confidence`` and
    its best-estimate ``point``/``bbox`` of the resolved subject. The
    client uses these for the "we think you tapped this — yes/try again"
    UX and to suppress page-generation on empty-region taps.

    ``prior_rejected_subject`` lets the caller signal that the user just
    rejected a previous resolution near this tap, which gives the VLM a
    multi-turn conversational refer signal ("you said X — what else
    could this be?"). Inspired by SAMA / MM-Conv dialog grounding.
    """
    locale_clause = (
        f" The `subject` MUST be written in language code '{output_locale}' — "
        "the next page is being generated in that language and the subject "
        "phrase will be the page title."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    # World Mode adds a classification field so the caller can decide whether a
    # tap ENTERS a place (scene / closer sub-map) or explains a concept, and —
    # in semi autonomy — proposes a couple of short questions to ask first.
    world_clause = ""
    if world_mode:
        world_clause = (
            " (9) `enter_as` — one of \"scene\", \"submap\", or \"explainer\": "
            "\"scene\" when the crosshair is on a PLACE the user would step INTO "
            "(a building, street, district, room, landscape, ship/vehicle "
            "interior); \"submap\" when it is a sub-region of a map or area best "
            "shown as a CLOSER MAP; \"explainer\" when it is an object, "
            "mechanism, or concept best shown as a labelled diagram."
            " (10) `surroundings` — a short phrase (<=30 words) naming what sits "
            "immediately AROUND the crosshair and in which direction, read from "
            "the parent image's own layout (e.g. \"the river runs along the "
            "south, a row of timbered houses to the west, a market square to the "
            "north-east\"). This anchors the entered place so its neighbours "
            "stay where they are. Empty string if nothing is discernible."
            " (12) `place_form` — the tapped place's FORM, judged from the image "
            "(not from the words, which may be in any language): \"interior\" = "
            "a single enclosed volume you'd stand inside (a room, hall, tavern, "
            "shop, workshop); \"complex\" = a multi-structure compound or "
            "walkable outdoor area (a castle, campus, harbor, market square, "
            "village); \"landscape\" = open terrain (a valley, coastline, "
            "forest); \"generic\" = none of these / unclear. This picks the "
            "entered view's camera (interior -> eye level; complex/landscape -> "
            "a high establishing shot)."
        )
        if autonomy == "semi":
            world_clause += (
                " (11) `clarifiers` — an array of AT MOST 2 very short questions "
                "(<=8 words each) whose answers would change how this place is "
                "drawn (e.g. \"Day or night?\", \"Bustling or abandoned?\"). "
                "Return an empty array when you are confident or when `enter_as` "
                "is \"explainer\"."
            )
    else:
        # Classic mode classifies too (TAP_ZOOM_CONTINUE): a tap on a concrete
        # place/thing zoom-continues the tapped pixels instead of fresh-generating
        # a lookalike; abstract concepts keep the fresh labelled explainer.
        world_clause = (
            " (9) `enter_as` — one of \"scene\", \"submap\", or \"explainer\": "
            "\"scene\" when the crosshair is on a concrete place or physical "
            "thing the user would move CLOSER to (a building, landmark, room, "
            "vehicle, creature, terrain feature); \"submap\" when the parent "
            "image reads as a map or plan and the target is a sub-area best "
            "shown as a closer map; \"explainer\" when it is an abstract "
            "concept, mechanism, process, or diagram element best served by a "
            "fresh labelled diagram."
        )
    system = (
        "You examine a generated illustration of the page titled "
        f"'{parent_title}' (user query: '{parent_query}'). A red crosshair with "
        "a white halo has been drawn on the image to mark where the user "
        "clicked. Return ONE JSON object with these fields: "
        "(1) `subject` — a 2-8 word noun phrase naming the specific thing "
        "under the crosshair (ignore the crosshair itself); should make a "
        "good next query for a visual explainer. "
        "(2) `style` — a single sentence (<=30 words) describing the "
        "illustration's visual style: art medium (e.g. flat infographic, "
        "watercolor, technical line drawing, photoreal, anime, blueprint), "
        "dominant palette, line work, level of detail, perspective. "
        "(3) `subject_context` — a single sentence (<=35 words) defining what "
        "the subject IS in this specific illustration's domain. Be concrete: "
        "name the parent system, what role the subject plays inside it, and "
        "why it's there. This is the disambiguation. If `subject` is "
        "\"Memory Bank\" inside a video-segmentation architecture, the context "
        "is \"per-object memory store the tracker uses to keep object "
        "identity across frames\" — NOT a generic definition. "
        "(4) `groundable` — boolean. Decide this FIRST, before you name a "
        "subject. Return false whenever the crosshair sits on empty or "
        "non-meaningful pixels: open sky, plain water/sea, blank "
        "paper/parchment or a flat background fill, a solid colour area, the "
        "empty GAP or margin BETWEEN depicted objects, or a decorative "
        "border/frame. Return true only when a concrete depicted object, "
        "place, or labelled feature is actually under the crosshair. Empty "
        "taps are common and expected — false is the correct, useful answer, "
        "NOT a failure or a fallback. Still fill in a best-guess subject, but "
        "never let the urge to name something flip an honest false to true. "
        "(5) `confidence` — number in [0,1]; how sure you are that the "
        "subject you named is what the user intended to tap. "
        "(6) `point` — your best-estimate centroid of the resolved "
        "subject as {\"x\": <0-1>, \"y\": <0-1>} in the image's own frame "
        "(0,0 top-left). Use the crosshair location as a strong prior. "
        "(7) `bbox` — optional axis-aligned bounding box around the "
        "subject as {\"x\": <0-1>, \"y\": <0-1>, \"w\": <0-1>, \"h\": <0-1>}. "
        "Omit if you cannot give a tight box. "
        "(8) `scale` — the subject's size relative to the page's overall focal "
        "subject: \"component\" (a part of it / smaller), \"peer\" (a separate "
        "thing of similar size), or \"container\" (a larger thing the focal "
        "subject is part of). Default to \"peer\" when unsure."
        + world_clause
        + locale_clause
    )
    hint_clause = ""
    if user_hint:
        hint_clause = (
            "\n\nUser's note for this click (treat as guidance for what they "
            f"want from the subject phrase): \"{user_hint}\". "
            "Let it shape the angle/framing of the subject if relevant, but "
            "keep the subject concrete and grounded in what's actually under "
            "the crosshair."
        )
    refer_clause = ""
    if prior_rejected_subject:
        refer_clause = (
            "\n\nMulti-turn refer: the user just rejected the previous "
            f"resolution \"{prior_rejected_subject}\" near this tap. Pick a "
            "DIFFERENT plausible subject under the crosshair — favour a "
            "neighbouring element, a sibling label, or a part-of-X if the "
            "previous reading was an X. Do NOT return the same subject again."
        )
    user_text = (
        "Look at the red crosshair marker on the image and tell me the "
        "specific subject beneath it. Also describe the visual style of "
        "the illustration so the next page can be drawn in the SAME style. "
        "If the crosshair is not visible for any reason, fall back to the "
        f"numeric position x={x_pct:.3f}, y={y_pct:.3f} "
        "(0-1 normalized, origin top-left)."
        + hint_clause
        + refer_clause
    )
    from obs import span

    async with span("vlm.click_to_subject", model=_vlm_model()) as ctx:
        parsed = await _llm._complete_json(
            model=_vlm_model(),
            messages=[
                _system_message(system),
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            schema=CLICK_SCHEMA,
            schema_name="click_resolution",
            temperature=0.2,
            max_tokens=400,
            span_ctx=ctx,
        )
    return _build_click_resolution(parsed, x_pct=x_pct, y_pct=y_pct, fallback_subject=parent_title)


def _coerce_unit(value: Any) -> float | None:
    """Coerce a JSON value to a clamped [0,1] float, or None if non-numeric."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def _parse_point(raw: Any) -> tuple[float, float] | None:
    """Accept {"x": .., "y": ..} or [x, y] or null. Out-of-range → clamped."""
    if isinstance(raw, dict):
        x = _coerce_unit(raw.get("x"))
        y = _coerce_unit(raw.get("y"))
    elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
        x = _coerce_unit(raw[0])
        y = _coerce_unit(raw[1])
    else:
        return None
    if x is None or y is None:
        return None
    return (x, y)


def _parse_bbox(raw: Any) -> tuple[float, float, float, float] | None:
    """Accept {x,y,w,h} or [x,y,w,h]. Returns None if any component invalid."""
    if isinstance(raw, dict):
        x = _coerce_unit(raw.get("x"))
        y = _coerce_unit(raw.get("y"))
        w = _coerce_unit(raw.get("w") or raw.get("width"))
        h = _coerce_unit(raw.get("h") or raw.get("height"))
    elif isinstance(raw, (list, tuple)) and len(raw) >= 4:
        x = _coerce_unit(raw[0])
        y = _coerce_unit(raw[1])
        w = _coerce_unit(raw[2])
        h = _coerce_unit(raw[3])
    else:
        return None
    if x is None or y is None or w is None or h is None:
        return None
    if w == 0.0 or h == 0.0:
        return None
    return (x, y, w, h)


def _build_click_resolution(
    parsed: dict[str, Any],
    *,
    x_pct: float,
    y_pct: float,
    fallback_subject: str,
) -> ClickResolution:
    """Map the VLM's JSON payload onto a ClickResolution with safe defaults.

    Older models / out-of-distribution prompts may omit the groundability /
    point / bbox fields entirely. We fill them in with conservative
    defaults (groundable=True, confidence=1.0, point=crosshair) so the
    upstream UX never breaks; downstream code can still inspect for
    explicit ``False`` to render the low-confidence warning.
    """
    subject = str(parsed.get("subject", "")).strip()
    style = str(parsed.get("style", "")).strip()
    subject_context = str(parsed.get("subject_context", "")).strip()

    groundable_raw = parsed.get("groundable")
    if isinstance(groundable_raw, bool):
        groundable = groundable_raw
    elif isinstance(groundable_raw, str):
        groundable = groundable_raw.lower() not in ("false", "no", "0")
    else:
        groundable = True

    confidence = _coerce_unit(parsed.get("confidence"))
    if confidence is None:
        confidence = 1.0

    point = _parse_point(parsed.get("point"))
    if point is None:
        # Crosshair location is the strongest fallback — that's where the
        # user actually tapped, even if the VLM didn't echo it back.
        point = (
            _coerce_unit(x_pct) or 0.0,
            _coerce_unit(y_pct) or 0.0,
        )
    bbox = _parse_bbox(parsed.get("bbox"))
    scale = _coerce_scale(parsed.get("scale"))

    # World Mode fields — absent on classic payloads, so default to the
    # explainer framing with no questions (keeps tap=learn behaviour intact).
    enter_as = str(parsed.get("enter_as", "")).strip().lower()
    if enter_as not in ("scene", "submap", "explainer"):
        enter_as = "explainer"
    place_form = str(parsed.get("place_form", "")).strip().lower()
    if place_form not in ("interior", "complex", "landscape", "generic"):
        place_form = ""
    clarifiers_raw = parsed.get("clarifiers")
    clarifiers = (
        [c.strip() for c in clarifiers_raw if isinstance(c, str) and c.strip()][:2]
        if isinstance(clarifiers_raw, list)
        else []
    )
    surroundings = str(parsed.get("surroundings", "")).strip()

    return ClickResolution(
        subject=subject or fallback_subject,
        style=style,
        subject_context=subject_context,
        groundable=groundable,
        confidence=confidence,
        point=point,
        bbox=bbox,
        scale=scale,
        enter_as=enter_as,
        place_form=place_form,
        clarifiers=clarifiers,
        surroundings=surroundings,
    )


async def precompute_click_candidates(
    image_data_url: str,
    parent_title: str,
    parent_query: str,
    output_locale: str | None = None,
    max_candidates: int = 4,
) -> list[ClickCandidate]:
    """Ask the VLM for the most click-worthy regions on a fresh page.

    Returns `max_candidates` items at most, ordered by salience descending.
    Coordinates are 0..1 in the image's frame. Falls back to an empty list on
    parse failure — the click handler still works via on-demand resolution.
    """
    locale_clause = (
        f" Each `subject` MUST be written in language code '{output_locale}'."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    system = (
        "You examine an illustrated explainer page titled "
        f"'{parent_title}' (user query: '{parent_query}'). Identify the "
        f"{max_candidates} MOST clickable subjects on this page — discrete, "
        "named objects or annotated regions a curious reader would tap to "
        "drill into. Avoid background filler, overlapping picks, and the "
        "centre of empty regions. Return JSON: "
        "{\"candidates\": [{\"x_pct\": 0..1, \"y_pct\": 0..1, "
        "\"subject\": \"2-8 word noun phrase\", "
        "\"style\": \"<=30 word visual style sentence — same for every "
        "candidate, describing this illustration's medium/palette/line-work\", "
        "\"salience\": 0..1, "
        "\"enter_as\": \"scene|submap|explainer\"}, ...]}. `enter_as`: "
        "\"scene\" = a concrete place or physical thing the reader would move "
        "CLOSER to; \"submap\" = the page reads as a map/plan and this is a "
        "sub-area best shown as a closer map; \"explainer\" = an abstract "
        "concept, mechanism, or diagram element best served by a fresh "
        "labelled diagram. If the page is a scenic illustration or a map "
        "rather than an annotated diagram, treat its distinct objects, "
        "buildings, creatures, and landmarks as the clickable subjects — a "
        "rich scene is never empty. Coordinates are 0..1 with origin at the "
        "top-left of the image. Sort by salience descending."
        + locale_clause
    )
    user_text = (
        "List the most click-worthy regions on this illustration. Return "
        f"at most {max_candidates}; fewer is fine if the page is sparse."
    )
    from _env import env_flag
    from obs import span

    # gemini-flash occasionally reads a scenic (non-diagram) page as having no
    # "annotated subjects" and returns a well-formed empty list — which
    # silently starves candidate warmup and stops Wander runs mid-flight. One
    # hotter retry flips almost all of those empty rolls; a genuinely sparse
    # page just comes back empty twice.
    attempts = 2 if env_flag("PRECOMPUTE_EMPTY_RETRY", "true") else 1
    items: Any = []
    for attempt in range(attempts):
        async with span("vlm.precompute_candidates", model=_vlm_model()) as ctx:
            parsed = await _llm._complete_json(
                model=_vlm_model(),
                messages=[
                    _system_message(system),
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_text},
                            {
                                "type": "image_url",
                                "image_url": {"url": image_data_url, "detail": "high"},
                            },
                        ],
                    },
                ],
                schema=CANDIDATES_SCHEMA,
                schema_name="click_candidates",
                temperature=0.2 if attempt == 0 else 0.5,
                max_tokens=900,
                span_ctx=ctx,
            )
        items = parsed.get("candidates", [])
        if isinstance(items, list) and items:
            break
        if attempt + 1 < attempts:
            _llm._safe_log("warn", "vlm.precompute_candidates.empty_retry")
    out: list[ClickCandidate] = []
    if not isinstance(items, list):
        return out
    for entry in items:
        if not isinstance(entry, dict):
            continue
        try:
            x = float(entry.get("x_pct", -1))
            y = float(entry.get("y_pct", -1))
            sal = float(entry.get("salience", 0.5))
        except (TypeError, ValueError):
            continue
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            continue
        subject = str(entry.get("subject", "")).strip()
        style = str(entry.get("style", "")).strip()
        if not subject:
            continue
        enter_as_raw = str(entry.get("enter_as", "")).strip().lower()
        out.append(
            ClickCandidate(
                x_pct=x,
                y_pct=y,
                subject=subject,
                style=style,
                salience=max(0.0, min(1.0, sal)),
                enter_as=(
                    enter_as_raw
                    if enter_as_raw in ("scene", "submap", "explainer")
                    else "explainer"
                ),
            )
        )
        if len(out) >= max_candidates:
            break
    out.sort(key=lambda c: c.salience, reverse=True)
    return out
