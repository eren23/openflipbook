"""Entity extraction: catalogue named / narratively significant entities on a
freshly generated page. Moved verbatim from the old providers/llm.py.

`_complete_json` is called through the package namespace (`_llm.*`) so tests
that monkeypatch it (or `_client`) on `providers.llm` still intercept.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from providers import llm as _llm

from .client import ENTITY_KINDS, _safe_json, _system_message, _vlm_model


@dataclass
class ExtractedEntity:
    kind: str
    name: str
    appearance: str
    aliases: list[str]
    facts: list[str]
    # Mirrors EntityState in packages/config: primitive-only key/value bag
    # (the builder below already drops non-primitives), not freeform JSON.
    state: dict[str, str | int | float | bool]
    confidence: float
    bbox: dict[str, float] | None = None
    # Per-node SAM3 border polygon (normalized 0..1 image space, 3..24 verts).
    # The VLM doesn't emit this; the extract endpoint's segmenter fills it behind
    # WORLD_SEGMENT_BORDERS so the overlay can draw a tight outline, not just a box.
    border: list[list[float]] | None = None


@dataclass
class EntityUpdate:
    match_name: str
    changes: dict[str, Any]
    confidence: float
    # Re-localized box on the current node. The VLM doesn't emit this; the
    # extract endpoint's detector fills it so recurring entities keep a
    # per-node bbox for geometry + the overlay.
    bbox: dict[str, float] | None = None
    border: list[list[float]] | None = None  # SAM3 polygon, same shape as above


@dataclass
class EntityExtractionResult:
    added: list[ExtractedEntity]
    updated: list[EntityUpdate]


EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "added": {"type": "array", "items": {"type": "object"}},
        "updated": {"type": "array", "items": {"type": "object"}},
    },
    "required": ["added", "updated"],
}


async def extract_entities(
    image_data_url: str,
    caption: str,
    scene_description: str | None = None,
    prior_entities: list[dict[str, Any]] | None = None,
) -> EntityExtractionResult:
    """Catalogue entities visible/named in a freshly-generated page.

    `prior_entities` is the web layer's pre-filtered slice of the world
    registry — typically the N most-recent + any whose name overlaps the
    caption. The VLM uses it to decide whether a depicted character is "the
    same Mira from earlier" (emit as `updated`) or someone new (`added`).
    Sending the full registry on every page would balloon prompt cost.

    The extractor is opinionated about what counts as an entity: only named
    or narratively significant figures/places/items/creatures. "Tree",
    "table", "wall" alone are not entities. A specific named "lighthouse"
    or "the obsidian dagger" is. This filtering happens in the prompt
    rather than post-hoc because the VLM has the whole scene in view.
    """
    prior_blob = ""
    if prior_entities:
        # Compact rendering — the VLM only needs name/kind/appearance to
        # decide identity. Aliases included to catch rename overlaps.
        lines: list[str] = []
        for e in prior_entities[:40]:  # hard cap to bound prompt length
            name = str(e.get("name", "")).strip()
            kind = str(e.get("kind", "")).strip()
            appearance = str(e.get("appearance", "")).strip()
            aliases_raw = e.get("aliases", [])
            aliases = (
                ", ".join(a for a in aliases_raw if isinstance(a, str))
                if isinstance(aliases_raw, list)
                else ""
            )
            if not name or kind not in ENTITY_KINDS:
                continue
            line = f"- [{kind}] {name}"
            if aliases:
                line += f" (aka: {aliases})"
            if appearance:
                line += f" — {appearance[:140]}"
            lines.append(line)
        if lines:
            prior_blob = (
                "\n\nPrior entities in this world (match against these "
                "before adding a new one — if the same character / place / "
                "item is depicted, emit an `updated` entry keyed on the "
                "name shown here):\n" + "\n".join(lines)
            )

    system = (
        "You catalogue the named or narratively significant entities in an "
        "illustrated explainer / story page. Categorize each as one of: "
        f"{', '.join(ENTITY_KINDS)}.\n\n"
        "STRICT RELEVANCE FILTER: only emit entities that are either (a) "
        "given a proper name in the caption, (b) the visual focal point of "
        "the page, or (c) carry obvious narrative weight (a quest item, a "
        "doorway leading somewhere new, a named location). Generic scenery "
        "— trees, tables, walls, generic crowds — must NOT be emitted. "
        "When in doubt, leave it out.\n\n"
        "For each emitted entity provide:\n"
        "- `name`: short proper noun phrase (\"Mira the Keeper\", \"Lantern "
        "Room\", \"Obsidian Dagger\"). Use the in-page name when given; "
        "otherwise a concrete descriptive label (\"the masked herald\").\n"
        "- `kind`: one of " + ", ".join(ENTITY_KINDS) + ".\n"
        "- `appearance`: ONE sentence (<=35 words) describing what the "
        "entity LOOKS LIKE — clothing, build, materials, colours, posture. "
        "This sentence will be injected verbatim into future image-gen "
        "prompts to keep continuity, so be concrete and visual.\n"
        "- `aliases`: list of alternate names mentioned in the caption "
        "(empty list if none).\n"
        "- `facts`: up to 3 short factual statements about the entity "
        "from this page's caption / labels. Empty list if nothing notable.\n"
        "- `state`: an OBJECT of key/value flags describing the entity's "
        "CURRENT state on THIS page (causality). Use these CANONICAL "
        "keys whenever they apply: open, closed, locked, broken, lit, "
        "extinguished, burning, wounded, defeated, asleep, awake, alive, "
        "dead, present, absent, hidden, posture, held_by, location, "
        "time, weather. Examples: {\"open\": true}, {\"lit\": true}, "
        "{\"wounded\": true}, {\"posture\": \"kneeling\"}, "
        "{\"held_by\": \"Mira\"}, {\"time\": \"night\"}. Non-canonical "
        "keys are silently dropped by the merge layer, so prefer the "
        "canonical set even when paraphrasing fits better. Causality "
        "cues to look for: doors opened/closed, sources lit/extinguished, "
        "items picked up / dropped or transferred between characters, "
        "creatures awake/asleep/defeated, a character changed posture, "
        "an entity exiting a space or moving to a new room, scene-wide "
        "environmental shifts (time of day, weather, lighting). ONLY "
        "include a key when the page makes the state visually explicit; "
        "do NOT speculate. Empty object if nothing changed and no "
        "explicit state is depicted — but this empty-state rule governs "
        "the `state` key ONLY: still emit the surrounding `updated` "
        "entry as a presence ping. The merge layer threads this state "
        "forward, so a value emitted here will be the starting condition "
        "for future pages until contradicted.\n"
        "- `confidence`: 0..1 self-rating. Use <0.5 for guesses.\n\n"
        "RETURN JSON of the shape: "
        "{\"added\": [<new entities>], "
        "\"updated\": [{\"match_name\": \"<name from prior list>\", "
        "\"changes\": {<any of: name, appearance, facts, state, aliases>}, "
        "\"confidence\": 0..1}]}. "
        "Use `updated` for EVERY prior entity that appears on THIS page — "
        "even if NOTHING new is observable about them this turn. In that "
        "case emit `\"changes\": {}` and a confidence reflecting how sure "
        "you are the same entity is depicted. Presence-pings are how the "
        "registry knows the entity is still around; without them the entity "
        "would silently fall off the recency window and get re-added as a "
        "duplicate next time. Only include changed fields when there is "
        "actually something new (new fact, new state, an updated alias). "
        "Use `added` only for entities not in the prior list. "
        "CRITICAL NEGATIVE: do NOT emit an `updated` entry for a prior "
        "entity that is NOT depicted on this page and NOT mentioned by "
        "name in the caption / scene description. Phantom pings inflate "
        "the registry's `appears_on` counts and cause downstream "
        "continuity to inject the wrong character into future prompts. "
        "If unsure whether a prior entity is depicted, omit it."
    )
    caption_clean = (caption or "").strip()[:800]
    scene_clean = (scene_description or "").strip()[:1400]
    user_parts = [
        "Catalogue the named / narratively significant entities visible in "
        "this illustration. Match against the prior-entity list (if any) "
        "when the same one reappears; emit empty-change presence pings for "
        "prior entities that appear but have nothing new to record."
    ]
    if caption_clean:
        user_parts.append(f"Page title: \"{caption_clean}\"")
    if scene_clean:
        # Planner's `final_prompt` — the full paragraph the image model
        # rendered from. Names, props, locations are most reliably picked
        # up from this text rather than the short title alone.
        user_parts.append(f"Scene description: {scene_clean}")
    # Prior entities go in the USER turn, not the system turn. The system
    # block carries `cache_control: ephemeral` so OpenRouter can serve a
    # cached prefix on repeated extractions; per-call data in the system
    # block would invalidate every cache. The user turn varies anyway.
    if prior_blob:
        user_parts.append(prior_blob.strip())
    user_text = "\n\n".join(user_parts)
    from obs import span

    async with span("vlm.extract_entities", model=_vlm_model()) as ctx:
        # max_tokens is generous: a busy scene with ~30 prior entities easily
        # crosses 1.5k tokens (appearance + facts + state + bbox each). A
        # tighter cap truncates mid-JSON and the parse collapses to empty.
        # `_complete_json` stamps finish_reason into the span and returns {}
        # on the empty-choices stub OpenRouter sometimes relays as HTTP 200,
        # so the merge layer just sees an empty diff and keeps moving.
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
            schema=EXTRACTION_SCHEMA,
            schema_name="entity_extraction",
            # Deterministic: extraction is treated as reproducible (and can
            # overwrite catalogued descriptions), so it must not drift run-to-run.
            temperature=0.0,
            max_tokens=2200,
            span_ctx=ctx,
        )
    return _build_extraction(parsed)


def _parse_extraction(raw: str) -> EntityExtractionResult:
    """Tolerantly parse the extraction VLM's raw JSON text into typed records."""
    return _build_extraction(_safe_json(raw))


def _build_extraction(parsed: dict[str, Any]) -> EntityExtractionResult:
    """Map an already-parsed extraction payload onto typed records.

    Garbage entries are dropped, not raised — the extractor is permitted to
    miss things; the worst case is a thinner codex this turn.
    """
    added_raw = parsed.get("added", [])
    updated_raw = parsed.get("updated", [])
    added: list[ExtractedEntity] = []
    if isinstance(added_raw, list):
        for entry in added_raw:
            entity = _coerce_extracted_entity(entry)
            if entity is not None:
                added.append(entity)
    updated: list[EntityUpdate] = []
    if isinstance(updated_raw, list):
        for entry in updated_raw:
            update = _coerce_entity_update(entry)
            if update is not None:
                updated.append(update)
    return EntityExtractionResult(added=added, updated=updated)


def _coerce_extracted_entity(entry: Any) -> ExtractedEntity | None:
    if not isinstance(entry, dict):
        return None
    kind = str(entry.get("kind", "")).strip().lower()
    name = str(entry.get("name", "")).strip()[:120]
    # `appearance` is the descriptor injected into image-gen prompts. Cap it
    # so a runaway VLM doesn't blow up the planner's ~120-word prompt budget
    # when multiple entities are stacked into the same composed_prompt.
    appearance = str(entry.get("appearance", "")).strip()[:280]
    if kind not in ENTITY_KINDS or not name or not appearance:
        return None
    aliases_raw = entry.get("aliases", []) or []
    aliases = (
        [str(a).strip() for a in aliases_raw if isinstance(a, str) and a.strip()]
        if isinstance(aliases_raw, list)
        else []
    )
    facts_raw = entry.get("facts", []) or []
    facts = (
        [str(f).strip() for f in facts_raw if isinstance(f, str) and f.strip()][:6]
        if isinstance(facts_raw, list)
        else []
    )
    state_raw = entry.get("state", {}) or {}
    state: dict[str, str | int | float | bool] = {}
    if isinstance(state_raw, dict):
        for k, v in state_raw.items():
            if not isinstance(k, str):
                continue
            if isinstance(v, (str, int, float, bool)):
                state[k] = v
    try:
        confidence = float(entry.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    bbox = _coerce_bbox(entry.get("bbox"))
    return ExtractedEntity(
        kind=kind,
        name=name,
        appearance=appearance,
        aliases=aliases,
        facts=facts,
        state=state,
        confidence=confidence,
        bbox=bbox,
    )


def _coerce_entity_update(entry: Any) -> EntityUpdate | None:
    """Parse an `updated` entry from the extraction VLM.

    Empty `changes` is INTENTIONALLY kept as a presence ping: when a prior
    entity reappears on a page without any new facts/state/appearance to
    record, the VLM is still asked to emit an `updated` entry so the
    merge layer can bump `last_seen_node_id`, append to `appears_on_node_ids`,
    and keep the entity inside the recency-based prior slice on the next
    extraction. Dropping these empty pings makes recurring entities fall off
    the slice and get re-added as duplicates.
    """
    if not isinstance(entry, dict):
        return None
    match_name = str(entry.get("match_name", "")).strip()
    if not match_name:
        return None
    changes_raw = entry.get("changes", {}) or {}
    if not isinstance(changes_raw, dict):
        changes_raw = {}
    # Only allow whitelisted keys so the VLM can't sneak fields the
    # downstream merge layer doesn't know how to apply.
    allowed = {"name", "appearance", "facts", "state", "aliases"}
    changes: dict[str, Any] = {}
    for k, v in changes_raw.items():
        if k not in allowed:
            continue
        if k == "name" and isinstance(v, str) and v.strip():
            changes[k] = v.strip()[:120]
        elif k == "appearance" and isinstance(v, str) and v.strip():
            changes[k] = v.strip()[:280]
        elif k == "facts" and isinstance(v, list):
            changes[k] = [
                str(f).strip() for f in v if isinstance(f, str) and f.strip()
            ][:6]
        elif k == "aliases" and isinstance(v, list):
            changes[k] = [
                str(a).strip() for a in v if isinstance(a, str) and a.strip()
            ]
        elif k == "state" and isinstance(v, dict):
            # EntityState sub-bag (primitive-only), mirroring packages/config.
            state: dict[str, str | int | float | bool] = {}
            for sk, sv in v.items():
                if isinstance(sk, str) and isinstance(sv, (str, int, float, bool)):
                    state[sk] = sv
            if state:
                changes[k] = state
    try:
        confidence = float(entry.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    return EntityUpdate(match_name=match_name, changes=changes, confidence=confidence)


def _coerce_bbox(raw: Any) -> dict[str, float] | None:
    if not isinstance(raw, dict):
        return None
    try:
        x = float(raw.get("x_pct", -1))
        y = float(raw.get("y_pct", -1))
        w = float(raw.get("w_pct", -1))
        h = float(raw.get("h_pct", -1))
    except (TypeError, ValueError):
        return None
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return None
    if not (0.0 < w <= 1.0 and 0.0 < h <= 1.0):
        return None
    # Clip box so it stays inside the frame.
    w = min(w, 1.0 - x)
    h = min(h, 1.0 - y)
    return {"x_pct": x, "y_pct": y, "w_pct": w, "h_pct": h}
