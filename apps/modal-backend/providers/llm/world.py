"""World memory: neighbour proposal (expand outward), natural-language geo
edits, and describe-a-place world planning. Moved verbatim from the old
providers/llm.py.

`_complete_json` is called through the package namespace (`_llm.*`) so tests
that monkeypatch it (or `_client`) on `providers.llm` still intercept.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeGuard

from providers import llm as _llm

from .client import ENTITY_KINDS, _coerce_scale, _system_message, _text_model, _vlm_model

if TYPE_CHECKING:
    # Annotation-only. The SceneGraph dataclasses are imported lazily at runtime
    # inside parse_scene_graph (Modal cold-start), but the return/local
    # annotations on parse_scene_graph + plan_world_from_description need the
    # names at module scope.
    from ..layout_solver import EmptyRegion, PlannedEntity, PlannedRelation, SceneGraph


@dataclass
class Neighbor:
    """One proposed neighbouring subject for the expand-outward bloom.

    `scale` is relative to the page's focal subject (see SCALE_KINDS):
    "component" (smaller / a part), "peer" (similar), "container" (bigger).
    """

    subject: str
    scale: str = "peer"
    note: str = ""


NEIGHBORS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "neighbors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "scale": {
                        "type": "string",
                        "enum": ["component", "peer", "container"],
                    },
                    "note": {"type": "string"},
                },
                "required": ["subject"],
            },
        }
    },
    "required": ["neighbors"],
}


async def propose_neighbors(
    image_data_url: str,
    parent_title: str,
    parent_query: str,
    subject_context: str | None = None,
    output_locale: str | None = None,
    max_neighbors: int = 4,
    known_neighbors: list[str] | None = None,
    scale_tier: str | None = None,
) -> list[Neighbor]:
    """Survey the neighbourhood of a page's focal subject for "expand outward".

    Returns up to ``max_neighbors`` notable neighbouring subjects across scales
    (component / peer / container), each a good next page to bloom. Falls back
    to an empty list on parse failure — the caller just blooms nothing.

    B2 logical AROUND (SCALE_AROUND_LOGICAL): when ``scale_tier`` /
    ``known_neighbors`` are passed (the geometry the session already knows), the
    survey is CONSTRAINED to NEW peers at the SAME scale, excluding what's mapped —
    so the bloom is "more places like these", not an arbitrary cross-scale survey.
    Both empty → today's exact behaviour (back-compat).
    """
    locale_clause = (
        f" Each `subject` MUST be written in language code '{output_locale}'."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    context_clause = (
        f" The focal subject is: {subject_context.strip()}."
        if subject_context and subject_context.strip()
        else ""
    )
    if scale_tier:
        # Logical AROUND: same-scale peers only, excluding what's already mapped.
        known = [n.strip() for n in (known_neighbors or []) if n and n.strip()]
        known_clause = (
            " These peers are ALREADY known — do NOT repeat them: "
            + "; ".join(known[:12])
            + "."
            if known
            else ""
        )
        survey_clause = (
            f"Propose up to {max_neighbors} NEW subjects that are PEERS at the SAME "
            f"scale ('{scale_tier}') — beside the focal subject, not larger or "
            f"smaller — each a good next page to explore.{known_clause} Set every "
            "`scale` to \"peer\". Do NOT repeat the focal subject itself."
        )
    else:
        survey_clause = (
            f"Propose up to {max_neighbors} notable NEIGHBOURING subjects: things "
            "adjacent to it, larger things that contain it, and notable things it "
            "is composed of — each of which would make a good next page to explore. "
            "Favour variety across scales and do NOT repeat the focal subject "
            "itself."
        )
    system = (
        f"You examine an illustrated page titled '{parent_title}' (user query: "
        f"'{parent_query}'). The user wants to EXPAND OUTWARD — to see the "
        f"wider world this page's focal subject sits in.{context_clause} "
        + survey_clause
        + " Return JSON: {\"neighbors\": [{\"subject\": \"2-8 word noun "
        "phrase\", \"scale\": \"component|peer|container\", \"note\": \"<=15 "
        "word reason it neighbours the focal subject\"}]}. `scale` is the "
        "neighbour's size relative to the focal subject: \"component\" (a part "
        "of it / smaller), \"peer\" (beside it / similar size), \"container\" "
        "(a larger thing it is part of)."
        + locale_clause
    )
    user_text = (
        "List the most interesting neighbouring subjects to explore around "
        f"this page. Return at most {max_neighbors}; fewer is fine."
    )
    from obs import span

    async with span("vlm.propose_neighbors", model=_vlm_model()) as ctx:
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
            schema=NEIGHBORS_SCHEMA,
            schema_name="neighbors",
            temperature=0.4,
            max_tokens=1200,
            span_ctx=ctx,
        )
    return _build_neighbors(parsed, max_neighbors)


def _build_neighbors(parsed: dict[str, Any], max_neighbors: int) -> list[Neighbor]:
    """Coerce the planner's JSON into typed Neighbors. Drops empty/duplicate
    subjects, defaults bad scales to "peer", caps at ``max_neighbors``."""
    items = parsed.get("neighbors", [])
    out: list[Neighbor] = []
    if not isinstance(items, list):
        return out
    seen: set[str] = set()
    for entry in items:
        if not isinstance(entry, dict):
            continue
        subject = str(entry.get("subject", "")).strip()[:120]
        if not subject:
            continue
        key = subject.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(
            Neighbor(
                subject=subject,
                scale=_coerce_scale(entry.get("scale")),
                note=str(entry.get("note", "")).strip()[:200],
            )
        )
        if len(out) >= max_neighbors:
            break
    return out


# ── Natural-language editing of the geometric world map ───────────────────────
# Turn an instruction ("move the lighthouse north", "make the tower taller") into
# validated structured edits to WorldEntityGeo entities, plus the blast-radius
# (which saved scenes now reference an edited entity → re-stage candidates). The
# parse + blast are pure + tolerant (garbage drops, never raises); the LLM call is
# mocked in tests. Edit shapes mirror EntityGeoEdit in packages/config.

ENTITY_EDIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"edits": {"type": "array", "items": {"type": "object"}}},
    "required": ["edits"],
}

ENTITY_EDIT_SYSTEM = (
    "You translate a natural-language instruction into structured edits to a 2D "
    "world map. World coords: origin top-left, +x EAST, +y SOUTH (so NORTH is "
    "-y and WEST is -x). Distances are in world units — match the rough scale of "
    'the positions you are given. Output JSON {"edits":[...]} where each edit is '
    "exactly one of:\n"
    '- {"op":"move","target":<id>,"dx":<number>,"dy":<number>}  (relative shift)\n'
    '- {"op":"set_height","target":<id>,"height":<number>}\n'
    '- {"op":"set_appearance","target":<id>,"visual":<short visual phrase>}\n'
    '- {"op":"remove","target":<id>}\n'
    '- {"op":"add","label":<name>,"pos":{"x":<number>,"y":<number>},"height":<number?>}\n'
    "RULES: `target` MUST be one of the listed entity ids — never invent an id. "
    "Only emit edits the instruction actually asks for; if nothing applies, emit "
    'an empty list {"edits":[]}. No prose, no markdown.'
)


@dataclass(frozen=True)
class EditPlan:
    edits: list[dict[str, Any]]
    blast_radius: list[str]


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_vec2(v: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(v, dict) and _is_number(v.get("x")) and _is_number(v.get("y"))


def parse_entity_edits(payload: Any, valid_ids: set[str]) -> list[dict[str, Any]]:
    """Coerce an NL-edit reply into validated EntityGeoEdit dicts. Tolerant: an
    edit with an unknown op, a `target` not in `valid_ids`, or a missing/ill-typed
    field is dropped — never raises (mirrors detector.parse_detections)."""
    if isinstance(payload, dict):
        payload = payload.get("edits", [])
    if not isinstance(payload, list):
        return []
    out: list[dict[str, Any]] = []
    for d in payload:
        if not isinstance(d, dict):
            continue
        op = str(d.get("op", "")).strip()
        if op == "add":
            label = str(d.get("label", "")).strip()
            pos = d.get("pos")
            if not label or not _is_vec2(pos):
                continue
            edit: dict[str, Any] = {
                "op": "add",
                "label": label,
                "pos": {"x": float(pos["x"]), "y": float(pos["y"])},
            }
            if _is_number(d.get("height")):
                edit["height"] = float(d["height"])
            fp = d.get("footprint")
            if isinstance(fp, dict) and _is_number(fp.get("w")) and _is_number(fp.get("d")):
                edit["footprint"] = {"w": float(fp["w"]), "d": float(fp["d"])}
            out.append(edit)
            continue
        target = str(d.get("target", "")).strip()
        if op not in ("move", "set_height", "set_appearance", "remove"):
            continue
        if target not in valid_ids:
            continue
        if op == "move":
            if not (_is_number(d.get("dx")) and _is_number(d.get("dy"))):
                continue
            out.append({"op": "move", "target": target,
                        "dx": float(d["dx"]), "dy": float(d["dy"])})
        elif op == "set_height":
            if not _is_number(d.get("height")):
                continue
            out.append({"op": "set_height", "target": target, "height": float(d["height"])})
        elif op == "set_appearance":
            visual = str(d.get("visual", "")).strip()
            if not visual:
                continue
            out.append({"op": "set_appearance", "target": target, "visual": visual})
        else:  # remove
            out.append({"op": "remove", "target": target})
    return out


def compute_blast_radius(
    edits: list[dict[str, Any]], references: dict[str, list[str]]
) -> list[str]:
    """Node ids whose saved render references an edited entity → the re-stage
    candidates. Union of `references[target]` over edits that carry a target (an
    `add` introduces a new entity, so it stales nothing)."""
    nodes: set[str] = set()
    for e in edits:
        target = e.get("target")
        if isinstance(target, str):
            for n in references.get(target, []):
                if isinstance(n, str):
                    nodes.add(n)
    return sorted(nodes)


def _edit_roster(entities: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for e in entities[:60]:  # bound the prompt
        eid = str(e.get("id", "")).strip()
        if not eid:
            continue
        label = str(e.get("label", "")).strip() or eid
        pos = e.get("pos") or {}
        lines.append(
            f'- id="{eid}" label="{label}" at (x={pos.get("x")}, y={pos.get("y")}) '
            f'height={e.get("height")}'
        )
    return "\n".join(lines)


async def edit_entities_nl(
    instruction: str,
    entities: list[dict[str, Any]],
    references: dict[str, list[str]] | None = None,
    scene_view: dict[str, Any] | None = None,
) -> EditPlan:
    """Turn a natural-language instruction into validated structured geo edits +
    a blast-radius. The model only sees the entities it may target (id + label +
    current geo); ids it invents are dropped by parse_entity_edits, so a bad
    completion degrades to a thinner/empty plan rather than a wrong mutation."""
    from obs import span

    references = references or {}
    valid_ids = {str(e["id"]) for e in entities if e.get("id")}
    roster = _edit_roster(entities)
    user = f'Instruction: "{instruction.strip()}"\n\nEntities you may edit:\n{roster}'
    async with span("llm.edit_entities", model=_text_model(online=False)) as ctx:
        parsed = await _llm._complete_json(
            model=_text_model(online=False),
            messages=[
                _system_message(ENTITY_EDIT_SYSTEM),
                {"role": "user", "content": user},
            ],
            schema=ENTITY_EDIT_SCHEMA,
            schema_name="entity_edits",
            temperature=0.0,
            max_tokens=900,
            span_ctx=ctx,
        )
    edits = parse_entity_edits(parsed, valid_ids)
    return EditPlan(edits=edits, blast_radius=compute_blast_radius(edits, references))


# ── Describe a place → a logical object world (WORLD_FROM_DESCRIPTION) ─────────
# Parse a place description into a SceneGraph: STRUCTURE (entities + relations,
# never coordinates) the deterministic layout_solver turns into geometry. Same
# discipline as the NL-edit: one _complete_json call + a tolerant coercer that
# drops malformed members and never raises.

_PLAN_RELATIONS = {
    "near", "on_wall", "behind", "in_front_of", "left_of", "right_of",
    "inside", "on_top_of", "facing",
}
_WALL_WORDS = {
    "north", "south", "east", "west", "back", "front", "left", "right",
    "top", "bottom", "rear", "wall",
}

PLAN_WORLD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "place_label": {"type": "string"},
        "place_kind": {"type": "string", "enum": list(ENTITY_KINDS)},
        "bounds_hint": {"type": "object"},
        "entities": {"type": "array", "items": {"type": "object"}},
        "relations": {"type": "array", "items": {"type": "object"}},
        "empty_regions": {"type": "array", "items": {"type": "object"}},
        "clarifiers": {"type": "array", "items": {"type": "string"}},
        "contradictions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["place_label", "entities"],
}

PLAN_WORLD_SYSTEM = (
    "You read a description of a single PLACE and return its objects as STRUCTURE "
    "— a JSON scene graph the layout engine turns into a 2D map. You NEVER output "
    "coordinates. World sense: +x EAST, +y SOUTH (toward the viewer); 'behind' is "
    "away from the viewer.\n\n"
    'Return JSON exactly: {"place_label","place_kind","bounds_hint?",'
    '"entities":[...],"relations":[...],"empty_regions":[...],"clarifiers":[...],'
    '"contradictions":[...]}.\n'
    '- entity: {"ref":<slug>,"kind":person|place|item|creature,"label":<short '
    'name>,"visual":<ONE concrete sentence, <=25 words: materials, colour, form '
    '— injected verbatim into the image prompt>,"footprint?":{"w","d"},'
    '"height?":<n>,"count?":<n>}\n'
    '- relation: {"subject":<ref>,"relation":near|on_wall|behind|in_front_of|'
    'left_of|right_of|inside|on_top_of|facing,"object":<another ref OR a wall '
    'side like "back_wall">,"gap?":<n>}\n'
    '- empty_region: {"ref":<slug>,"note":<what is clear / reserved here>}\n\n'
    "RULES:\n"
    "1. RELEVANCE. Emit only objects the description NAMES or clearly IMPLIES by "
    "function (a bar implies stools + bottles behind the counter). Do NOT pad the "
    "place with generic scenery. Anything called empty / clear / open / reserved "
    "becomes an empty_region — and you place NOTHING there.\n"
    "2. PLACEMENT = RELATIONS ONLY. Express where each object is ONLY via "
    "`relations` between refs. Never output x/y, grid cells or pixels — you do "
    "not know the scale; the engine computes positions from your relations.\n"
    "3. CHECK LOGIC, THEN ASK. Before finalizing, look for (a) physical "
    "impossibilities (a window in a sealed underground vault; a door on a wall "
    "you also called solid rock), (b) an object whose only sensible placement "
    "needs a wall/anchor the description never gave, (c) more objects than the "
    "place can hold. For each, add a SHORT question (<=8 words) to `clarifiers` "
    "(AT MOST 2) and one line to `contradictions`. Do NOT invent a resolution to "
    "a hard contradiction — leave it for the user. A merely-vague gap the engine "
    "can default does NOT need a clarifier.\n"
    "4. No prose, no markdown — JSON only."
)


def parse_scene_graph(payload: Any) -> SceneGraph:
    """Coerce a planner reply into a SceneGraph. Tolerant: an entity missing
    ref/label/visual or with an unknown kind is dropped; a relation whose subject
    isn't a known entity ref, whose relation is unknown, or whose object resolves
    to neither a known ref, a wall side, nor an empty region is dropped; clarifiers
    capped at 2. Never raises — a weak completion degrades to a thinner graph."""
    from ..layout_solver import EmptyRegion, PlannedEntity, PlannedRelation, SceneGraph

    if isinstance(payload, list):
        # The same list-wrapping drift _safe_json tolerates — unwrap, don't discard.
        payload = next((p for p in payload if isinstance(p, dict)), None)
    if not isinstance(payload, dict):
        payload = {}
    kind = str(payload.get("place_kind", "place")).strip().lower()
    if kind not in ENTITY_KINDS:
        kind = "place"
    bounds = payload.get("bounds_hint")
    bounds_hint = None
    if isinstance(bounds, dict) and _is_number(bounds.get("w")) and _is_number(bounds.get("h")):
        bounds_hint = {"w": float(bounds["w"]), "h": float(bounds["h"])}

    raw_entities = payload.get("entities")
    entities: list[PlannedEntity] = []
    refs: set[str] = set()
    for e in raw_entities if isinstance(raw_entities, list) else []:
        if not isinstance(e, dict):
            continue
        ref = str(e.get("ref", "")).strip()
        label = str(e.get("label", "")).strip()
        visual = str(e.get("visual", "")).strip()
        ekind = str(e.get("kind", "item")).strip().lower()
        if not ref or not label or not visual or ekind not in ENTITY_KINDS or ref in refs:
            continue
        refs.add(ref)
        fp = e.get("footprint")
        footprint = None
        if isinstance(fp, dict) and _is_number(fp.get("w")) and _is_number(fp.get("d")):
            footprint = {"w": float(fp["w"]), "d": float(fp["d"])}
        height = float(e["height"]) if _is_number(e.get("height")) else None
        count = max(1, int(e["count"])) if _is_number(e.get("count")) else 1
        entities.append(PlannedEntity(ref=ref, kind=ekind, label=label, visual=visual,
                                      footprint=footprint, height=height, count=count))

    raw_regions = payload.get("empty_regions")
    empty_regions: list[EmptyRegion] = []
    region_refs: set[str] = set()
    for r in raw_regions if isinstance(raw_regions, list) else []:
        if not isinstance(r, dict):
            continue
        rref = str(r.get("ref", "")).strip()
        note = str(r.get("note", "")).strip()
        if not rref or not note:
            continue
        region_refs.add(rref)
        approx = r.get("approx")
        ap = None
        if isinstance(approx, dict) and all(_is_number(approx.get(k)) for k in ("x", "y", "w", "h")):
            ap = {k: float(approx[k]) for k in ("x", "y", "w", "h")}
        empty_regions.append(EmptyRegion(ref=rref, note=note, approx=ap))

    def _ok_object(o: str) -> bool:
        if o in refs or o in region_refs:
            return True
        toks = o.lower().replace("_", " ").replace("-", " ").split()
        return any(t in _WALL_WORDS for t in toks)

    raw_relations = payload.get("relations")
    relations: list[PlannedRelation] = []
    for rel in raw_relations if isinstance(raw_relations, list) else []:
        if not isinstance(rel, dict):
            continue
        subj = str(rel.get("subject", "")).strip()
        relation = str(rel.get("relation", "")).strip().lower()
        obj = str(rel.get("object", "")).strip()
        if subj not in refs or relation not in _PLAN_RELATIONS or not _ok_object(obj):
            continue
        gap = float(rel["gap"]) if _is_number(rel.get("gap")) else None
        relations.append(PlannedRelation(subject=subj, relation=relation, object=obj, gap=gap))

    def _strs(key: str, cap: int | None = None) -> list[str]:
        v = payload.get(key, [])
        out = [str(s).strip() for s in v if isinstance(s, str) and str(s).strip()] if isinstance(v, list) else []
        return out[:cap] if cap is not None else out

    return SceneGraph(
        place_label=str(payload.get("place_label", "")).strip() or "the place",
        place_kind=kind, bounds_hint=bounds_hint, entities=entities,
        relations=relations, empty_regions=empty_regions,
        clarifiers=_strs("clarifiers", 2), contradictions=_strs("contradictions"),
    )


async def plan_world_from_description(description: str, answers: list[str] | None = None) -> SceneGraph:
    """Parse a place description into a SceneGraph (one text-LLM call + tolerant
    parse). On a re-run, `answers` are appended so the planner resolves the prior
    round's clarifiers; a malformed completion degrades to a thinner graph."""
    from obs import span

    user = f"Place description:\n{description.strip()}"
    if answers:
        joined = "\n".join(f"- {a.strip()}" for a in answers if a.strip())
        if joined:
            user += (
                "\n\nThe user clarified (resolve these — they are no longer open "
                f"questions):\n{joined}"
            )
    async with span("llm.plan_world", model=_text_model(online=False)) as ctx:
        parsed = await _llm._complete_json(
            model=_text_model(online=False),
            messages=[
                _system_message(PLAN_WORLD_SYSTEM),
                {"role": "user", "content": user},
            ],
            schema=PLAN_WORLD_SCHEMA,
            schema_name="scene_graph",
            temperature=0.0,
            max_tokens=2600,
            span_ctx=ctx,
        )
    return parse_scene_graph(parsed)
