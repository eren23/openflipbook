"""Ensemble corpus annotation — the evolvable upgrade to draft.py.

draft.py asks ONE VLM to describe a map, then a human verifies it. This module
fans the describe call out over N VLMs (CORPUS_ANNOTATE_MODELS, e.g. a Claude
slug + Gemini + a Qwen-VL — all through the one OpenRouter client), then
RECONCILES their entity lists into a single consensus deterministically (no
extra paid arbiter call — the merge is pure code, cacheable and testable). An
annotation-quality judge scores the consensus against the image; a low score
triggers one targeted re-describe (the judge's rationale fed back). When the
judge AND the ensemble agreement both clear their thresholds the description is
auto-promoted to review.status="verified"; otherwise it lands as "needs_human"
with the disagreements attached, so a person reviews the exception, not every map.

Non-destructive by default: a committed human-`verified` description is never
silently overwritten — a fresh annotation lands in `descriptions/candidates/<id>.json`
(invisible to recon) for review, unless CORPUS_ANNOTATE_FORCE=1.

The reconcile / agreement / promote core is pure and gated by test_annotate.py;
the paid fan-out + judge loop is the thin async wrapper at the bottom.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from tests.map_corpus import (
    DESCRIPTIONS,
    FRAME_H,
    FRAME_W,
    image_path,
    load_manifest,
)

_ARTICLE_RE = re.compile(r"^(the|a|an)\s+")
_EDGE_PUNCT_RE = re.compile(r"^[^a-z0-9]+|[^a-z0-9]+$")
_WS_RE = re.compile(r"\s+")


def norm_label(s: str) -> str:
    """Canonical key for cross-model entity matching: lowercase, collapse
    internal whitespace, strip edge punctuation, drop a single leading article
    so "The Tower" matches "Tower"."""
    t = _WS_RE.sub(" ", str(s).strip().lower())
    t = _EDGE_PUNCT_RE.sub("", t)
    t = _ARTICLE_RE.sub("", t)
    return t.strip()


def slug(s: str) -> str:
    """Kebab-case ref slug (same convention as draft._slug)."""
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-") or "x"


def _mode_first_seen(items: list[str]) -> str:
    """Most common item; ties broken by first appearance (deterministic)."""
    if not items:
        return ""
    counts = Counter(items)
    best = max(counts.values())
    for it in items:
        if counts[it] == best:
            return it
    return items[0]


def merge_entities(
    drafts: list[list[dict[str, Any]]], *, min_votes: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Reconcile N per-model entity lists into one consensus. Entities are
    matched across models by norm_label; an entity reaching >= min_votes
    DISTINCT models (a model naming it twice is one vote) is consensus, the
    rest are minority (disagreements). Per consensus entity: canonical label =
    most-frequent surface form (tie -> first-seen), kind = majority vote, visual
    = the richest (longest) non-empty description, votes = distinct model count."""
    order: list[str] = []
    info: dict[str, dict[str, Any]] = {}
    for di, draft in enumerate(drafts):
        if not isinstance(draft, list):
            continue
        for e in draft:
            if not isinstance(e, dict):
                continue
            label = str(e.get("label", "")).strip()
            if not label:
                continue
            key = norm_label(label)
            if not key:
                continue
            if key not in info:
                info[key] = {"voters": set(), "labels": [], "kinds": [], "visuals": []}
                order.append(key)
            rec = info[key]
            rec["voters"].add(di)
            rec["labels"].append(label)
            rec["kinds"].append(str(e.get("kind", "")).strip() or "place")
            visual = str(e.get("visual", "")).strip()
            if visual:
                rec["visuals"].append(visual)

    consensus: list[dict[str, Any]] = []
    minority: list[dict[str, Any]] = []
    for key in order:
        rec = info[key]
        votes = len(rec["voters"])
        label = _mode_first_seen(rec["labels"])
        ent = {
            "ref": slug(label),
            "kind": _mode_first_seen(rec["kinds"]) or "place",
            "label": label,
            "visual": max(rec["visuals"], key=len) if rec["visuals"] else "",
            "votes": votes,
        }
        (consensus if votes >= min_votes else minority).append(ent)
    return consensus, minority


def merge_relations(
    relation_lists: list[list[dict[str, Any]]],
    label_to_ref: dict[str, str],
    allowed: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Reconcile per-model relation lists. Endpoints are entity LABELS (the
    describe prompt asks for labels, not slugs); each is normalised and resolved
    against label_to_ref (norm_label -> consensus ref). A relation survives only
    when BOTH endpoints resolve to distinct consensus entities AND its type is in
    `allowed` (when given — keeps a model's invented relation like "attached_to"
    out of the corpus vocabulary). Deduped, first-seen order preserved."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for rels in relation_lists:
        if not isinstance(rels, list):
            continue
        for r in rels:
            if not isinstance(r, dict):
                continue
            subj = label_to_ref.get(norm_label(str(r.get("subject", ""))))
            obj = label_to_ref.get(norm_label(str(r.get("object", ""))))
            rel = str(r.get("relation", "")).strip() or "near"
            if not subj or not obj or subj == obj:
                continue
            if allowed is not None and rel not in allowed:
                continue
            key = (subj, rel, obj)
            if key in seen:
                continue
            seen.add(key)
            out.append({"subject": subj, "relation": rel, "object": obj})
    return out


def attach_geometry(
    consensus: list[dict[str, Any]],
    detections: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    heights_m: dict[str, float],
) -> list[dict[str, Any]]:
    """Bridge consensus labels to positioned corpus entities (ported from
    draft.py): detector box -> pos + footprint in the 100x60 frame, segmenter
    polygon -> border + rel_height, anchored heights -> height_m. An entity the
    detector did NOT box is dropped (its prose mention stays in the description).
    Label matching is case-insensitive (the VLM often lowercases labels)."""
    det_by = {str(d["label"]).lower(): d for d in detections}
    seg_by = {str(s["label"]).lower(): s for s in segments}
    h_by = {str(k).lower(): v for k, v in heights_m.items()}

    out: list[dict[str, Any]] = []
    for e in consensus:
        label = str(e["label"]).strip()
        det = det_by.get(label.lower())
        if det is None:
            continue
        seg = seg_by.get(label.lower())
        h = h_by.get(label.lower())
        out.append(
            {
                "ref": e["ref"],
                "kind": e.get("kind", "place"),
                "label": label,
                "visual": e.get("visual", ""),
                "votes": e.get("votes", 0),
                "pos": {
                    "x": round(det["x_pct"] * FRAME_W, 1),
                    "y": round(det["y_pct"] * FRAME_H, 1),
                },
                "footprint": {
                    "w": round(max(det["w_pct"] * FRAME_W, 0.5), 1),
                    "d": round(max(det["h_pct"] * FRAME_H, 0.5), 1),
                },
                "height_rel": seg["rel_height"] if seg else 0.0,
                "height_m": (round(h, 1) or None) if h else None,
                "border": (
                    [[round(x * FRAME_W, 1), round(y * FRAME_H, 1)] for x, y in seg["polygon"]]
                    if seg
                    else None
                ),
            }
        )
    return out


def parse_arbiter_consensus(
    payload: Any, n_models: int
) -> list[dict[str, Any]]:
    """Coerce an LLM arbiter's reconciled reply into consensus entities. The
    arbiter has already MERGED synonyms across the model drafts and counted how
    many models referred to each (counting synonyms as one) — we just validate:
    drop blanks, clamp votes to 1..n_models, slug the ref, dedup by norm_label
    (first wins). Tolerant: junk -> []."""
    if isinstance(payload, dict):
        payload = payload.get("entities") or payload.get("added") or []
    if not isinstance(payload, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e in payload:
        if not isinstance(e, dict):
            continue
        label = str(e.get("label", "")).strip()
        key = norm_label(label)
        if not key or key in seen:
            continue
        seen.add(key)
        try:
            votes = int(e.get("votes", 1))
        except (TypeError, ValueError):
            votes = 1
        out.append(
            {
                "ref": slug(label),
                "kind": str(e.get("kind", "")).strip() or "place",
                "label": label,
                "visual": str(e.get("visual", "")).strip(),
                "votes": max(1, min(votes, max(1, n_models))),
            }
        )
    return out


def vote(values: list[Any], *, default: Any = None) -> Any:
    """Majority vote over scalar values (scale_tier, kind …); ties broken by
    first-seen, empty -> default."""
    vals = [v for v in values if v is not None]
    if not vals:
        return default
    return _mode_first_seen(vals)


def agreement_score(consensus: list[dict[str, Any]], n_models: int) -> float:
    """Ensemble agreement: mean vote-fraction (votes / n_models) over the
    consensus entities. 1.0 = every kept entity was unanimous. 0.0 if there are
    no consensus entities or no models."""
    if not consensus or n_models <= 0:
        return 0.0
    return sum(min(int(e["votes"]), n_models) / n_models for e in consensus) / len(consensus)


def decide_status(
    judge_score: float,
    agreement: float,
    *,
    judge_threshold: float,
    agreement_threshold: float,
) -> str:
    """Auto-promote gate: "verified" iff the annotation-quality judge AND the
    ensemble agreement both clear their thresholds (inclusive), else
    "needs_human"."""
    if judge_score >= judge_threshold and agreement >= agreement_threshold:
        return "verified"
    return "needs_human"


def output_name(
    map_id: str, existing_status: str | None, status: str, *, force: bool
) -> str:
    """Where to write the annotation (relative to DESCRIPTIONS), non-destructive
    by default. A fresh annotation lands as `candidates/<id>.json` (a subdir
    invisible to load_descriptions / recon / the integrity gate) when either: the
    run did NOT auto-verify (a `needs_human` verdict is not reviewed ground
    truth), or a committed human-`verified` description already exists (never
    silently clobbered). An auto-`verified` result with nothing to protect is
    promoted to `<id>.json`. force=True (CORPUS_ANNOTATE_FORCE) overrides the
    clobber guard."""
    if status != "verified":
        return f"candidates/{map_id}.json"
    if existing_status == "verified" and not force:
        return f"candidates/{map_id}.json"
    return f"{map_id}.json"


def assemble_description(
    *,
    map_id: str,
    genre: str,
    style: str,
    scale_tier: str,
    description: str,
    frame: dict[str, float],
    entities: list[dict[str, Any]],
    relations: list[dict[str, Any]],
    rev: int,
    annotation: dict[str, Any],
    status: str,
    by: str = "",
    date: str = "",
) -> dict[str, Any]:
    """Build the canonical corpus description artifact. Ensemble provenance lands
    in an `annotation` block; the per-entity `votes` count is dropped so the
    `entities` records stay the exact shape recon_bench consumes. Inputs are not
    mutated (a fresh dict per entity)."""
    clean_entities = [{k: v for k, v in e.items() if k != "votes"} for e in entities]
    return {
        "map_id": map_id,
        "rev": rev,
        "genre": genre,
        "style": style,
        "scale_tier": scale_tier,
        "frame": dict(frame),
        "description": description,
        "entities": clean_entities,
        "relations": list(relations),
        "annotation": dict(annotation),
        "review": {"status": status, "by": by, "date": date},
    }


# --- paid pipeline: the async fan-out + judge->refine loop --------------------
#
# Everything above is pure and gated by test_annotate.py. Below is the thin glue
# that actually spends tokens: fan a describe call over the ensemble, reconcile
# (pure), ground positions with the detector + segmenter, judge the result, and
# refine once on a low score. Verified by dry-run, not unit tests (same split as
# draft.py / recon_bench).

# The describe prompt is tier-specific (a map is annotated cartographically; an
# interior as a scene; a closeup as an object) but the RETURN SHAPE is identical
# across tiers — same style/scale_tier/description/entities/relations — so the
# reconcile, geometry and recon machinery is unchanged. describe_system(tier)
# picks the variant; an unknown tier falls back to the map prompt.
_ENTITY_TAIL = (
    "entities: [6-10 of the most prominent {what}: {{ref: <kebab-slug>, kind: "
    'one of ["place","item","creature","person"], label: <its name>, visual: '
    "<=12 words}}], relations: [4-8 spatial relations between entity LABELS (use "
    "the exact label strings, not slugs): {{subject: <label>, relation: one of "
    '["near","behind","in_front_of","left_of","right_of","inside","on_top_of",'
    '"facing"], object: <label>}}]}}.'
)

_DESCRIBE_SYSTEM = (
    "You are a careful cartographic annotator. Given a map image, return ONE "
    "JSON object: {style: <art medium + palette, <=25 words>, scale_tier: one "
    'of ["region","city","district","place"], description: <a precise 120-200 '
    "word prose description of the WHOLE map a painter could redraw it from — "
    "name the major features, their relative positions (north/south/etc), "
    "relative sizes and heights>, " + _ENTITY_TAIL.format(what="named features")
)

_INTERIOR_SYSTEM = (
    "You are a careful interior-scene annotator. Given a photo of the INSIDE of "
    "a place (a room, hall, or building interior), return ONE JSON object: "
    "{style: <medium + palette / photo look, <=25 words>, scale_tier: one of "
    '["place","room"], description: <a precise 120-200 word description of the '
    "space a set designer could rebuild it from — the layout, major furniture "
    "and fixtures, where each sits (left/right/back/foreground), the lighting>, "
    + _ENTITY_TAIL.format(what="objects and fixtures in the room")
)

_CLOSEUP_SYSTEM = (
    "You are a careful object annotator. Given a CLOSEUP photo of a single "
    "object or artifact, return ONE JSON object: {style: <medium + palette / "
    'photo look, <=25 words>, scale_tier: one of ["room","object"], '
    "description: <a precise 120-200 word description a sculptor/maker could "
    "reproduce it from — its overall form, materials, parts and their "
    "arrangement, surface detail>, "
    + _ENTITY_TAIL.format(what="distinct parts or details of the object")
)


def describe_system(tier: str) -> str:
    """The describe-prompt for a corpus tier (map | interior | closeup); an
    unknown tier falls back to the cartographic (map) prompt."""
    if tier == "interior":
        return _INTERIOR_SYSTEM
    if tier == "closeup":
        return _CLOSEUP_SYSTEM
    return _DESCRIBE_SYSTEM

_ANNOTATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "style": {"type": "string"},
        "scale_tier": {"type": "string"},
        "description": {"type": "string"},
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string"},
                    "kind": {"type": "string"},
                    "label": {"type": "string"},
                    "visual": {"type": "string"},
                },
            },
        },
        "relations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "relation": {"type": "string"},
                    "object": {"type": "string"},
                },
            },
        },
    },
    "required": ["entities"],
}


def _ensemble_models() -> list[str]:
    """The describe ensemble (comma-separated CORPUS_ANNOTATE_MODELS, e.g. a
    Claude slug + Gemini + a Qwen-VL). Falls back to the single shared VLM so an
    unconfigured run behaves like draft.py."""
    raw = os.environ.get("CORPUS_ANNOTATE_MODELS", "").strip()
    models = [m.strip() for m in raw.split(",") if m.strip()]
    if models:
        return models
    from providers import llm

    return [llm._vlm_model()]


def default_min_votes(n_effective: int, override: int | None) -> int:
    """How many DISTINCT models must name an entity for it to reach consensus.
    Default 1 (union — recall-first; corroboration is expressed by the agreement
    score + the detector/judge/human gates, not by dropping singletons). An
    explicit CORPUS_MIN_VOTES is honoured but CLAMPED to the models that actually
    contributed, so a strict policy + a dropped model can never force-empty the
    consensus (the 0-entity collapse this guard exists to prevent)."""
    if override is not None:
        return max(1, min(override, max(1, n_effective)))
    return 1


def _min_votes_override() -> int | None:
    raw = os.environ.get("CORPUS_MIN_VOTES", "").strip()
    return int(raw) if raw else None


def _arbiter_model() -> str | None:
    """Optional LLM (text) arbiter that reconciles the model drafts SEMANTICALLY —
    merging synonymous part/fixture names the deterministic exact-label merge
    keeps apart (the non-map thinness fix). Unset -> deterministic merge. A strong
    cheap reasoner like deepseek/deepseek-v4-pro fits (text-only, no image)."""
    return os.environ.get("CORPUS_ARBITER_MODEL", "").strip() or None


_ARBITER_SYSTEM = (
    "You reconcile entity lists from several annotators of the SAME image into ONE "
    "consensus list. The annotators each listed the prominent features/parts but "
    "often use DIFFERENT WORDS for the same thing (e.g. 'rete' vs 'openwork star "
    "disc'; 'pew' vs 'bench'). MERGE synonyms into a single entity. For each "
    "consensus entity return: label (the clearest canonical name), kind (one of "
    "place|item|creature|person), visual (the richest <=12-word description), votes "
    "(how many of the N annotators referred to it, counting synonyms as the same — "
    'an integer from 1 to N). Return JSON exactly: {"entities":[{"label":..,'
    '"kind":..,"visual":..,"votes":..}]}.'
)


def _judge_threshold() -> float:
    return float(os.environ.get("CORPUS_JUDGE_THRESHOLD", "7.0"))


def _agreement_threshold() -> float:
    return float(os.environ.get("CORPUS_AGREEMENT_THRESHOLD", "0.6"))


def _max_iters() -> int:
    return max(1, int(os.environ.get("CORPUS_ANNOTATE_MAX_ITERS", "2")))


def _plan_relations() -> set[str]:
    """The corpus relation vocabulary (the same set the integrity gate enforces)."""
    from providers.llm import _PLAN_RELATIONS

    return set(_PLAN_RELATIONS)


def _longest(strings: list[str]) -> str:
    """The richest (longest) non-empty string — used to pick the consensus style
    and prose from the ensemble's drafts."""
    cleaned = [s.strip() for s in strings if isinstance(s, str) and s.strip()]
    return max(cleaned, key=len) if cleaned else ""


def _force_overwrite() -> bool:
    return os.environ.get("CORPUS_ANNOTATE_FORCE", "").strip().lower() in {"1", "true", "yes"}


def _existing_status(map_id: str) -> str | None:
    """review.status of the committed description for this map, or None if there
    is no canonical file yet."""
    path = DESCRIPTIONS / f"{map_id}.json"
    if not path.exists():
        return None
    try:
        return str(json.loads(path.read_text()).get("review", {}).get("status")) or None
    except Exception:
        return None


def _next_rev(map_id: str) -> int:
    """One past the committed description's rev (so a re-annotate re-bills its
    recon cells), or 1 for a new map."""
    path = DESCRIPTIONS / f"{map_id}.json"
    if path.exists():
        try:
            return int(json.loads(path.read_text()).get("rev", 0)) + 1
        except Exception:
            return 1
    return 1


async def _describe(
    model: str, image_bytes: bytes, system: str, feedback: str = ""
) -> dict[str, Any]:
    """One VLM's structured annotation under the tier-specific `system` prompt.
    `feedback` (a judge rationale) is fed back on a refine pass."""
    from providers import llm

    b64 = base64.b64encode(image_bytes).decode("ascii")
    user_text = "Describe this image precisely." + (
        f"\n\nA reviewer flagged the previous annotation: {feedback} Re-describe "
        "carefully — fix those issues and name any prominent feature that was missed."
        if feedback
        else ""
    )
    return await llm._complete_json(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"},
                    },
                ],
            },
        ],
        schema=_ANNOTATION_SCHEMA,
        schema_name="corpus_annotation",
        temperature=0.0,
        max_tokens=1600,
    )


async def arbiter_reconcile(
    drafts: list[dict[str, Any]], *, model: str, min_votes: int, n_models: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Semantic reconcile via a text LLM: feed the annotators' entity lists, get
    back one synonym-merged consensus with vote counts. Returns (consensus,
    minority) split on min_votes, same shape as merge_entities. Falls back to the
    deterministic merge if the arbiter returns nothing usable."""
    from providers import llm

    blocks = []
    for i, d in enumerate(drafts):
        ents = d.get("entities", []) or []
        lines = "; ".join(
            f"{str(e.get('label', '')).strip()} ({str(e.get('visual', '')).strip()})"
            for e in ents
            if isinstance(e, dict) and str(e.get("label", "")).strip()
        )
        blocks.append(f"Annotator {i + 1}: {lines}")
    user_text = (
        f"There are N={n_models} annotators. Merge their entity lists into one "
        "consensus (synonyms = one entity, with a votes count 1..N):\n\n"
        + "\n".join(blocks)
    )
    parsed = await llm._complete_json(
        model=model,
        messages=[
            {"role": "system", "content": _ARBITER_SYSTEM},
            {"role": "user", "content": user_text},
        ],
        schema=None,
        schema_name="arbiter_consensus",
        temperature=0.0,
        max_tokens=1200,
    )
    entities = parse_arbiter_consensus(parsed, n_models)
    if not entities:  # arbiter failed -> deterministic fallback (never lose the run)
        return merge_entities([d.get("entities", []) for d in drafts], min_votes=min_votes)
    consensus = [e for e in entities if e["votes"] >= min_votes]
    minority = [e for e in entities if e["votes"] < min_votes]
    return consensus, minority


async def annotate_one(map_id: str) -> Path:
    """Ensemble-annotate one corpus map: fan out -> reconcile -> ground -> judge
    -> refine, then write descriptions/<id>.json with provenance + an auto-
    promote verdict (verified | needs_human)."""
    from providers import heights as heights_lib
    from providers import judge
    from providers.detector import detect
    from providers.segmenter import segment

    row = next((m for m in load_manifest() if m["id"] == map_id), {})
    genre = str(row.get("genre", ""))
    tier = str(row.get("tier", "map"))
    system = describe_system(tier)
    img = image_path(map_id)
    if not img.exists():
        raise SystemExit(f"{img} missing — run `make corpus-fetch` first")
    image_bytes = img.read_bytes()

    models = _ensemble_models()
    n = len(models)

    feedback = ""
    best: dict[str, Any] | None = None
    for attempt in range(_max_iters()):
        results = await asyncio.gather(
            *[_describe(m, image_bytes, system, feedback) for m in models],
            return_exceptions=True,
        )
        # Instrument the fan-out boundary: a dropped/failed model must be visible,
        # never silently swallowed (that masked a degraded ensemble as "disagreement").
        draft_dicts: list[dict[str, Any]] = []
        for model, r in zip(models, results, strict=True):
            if isinstance(r, Exception):
                print(f"    {model}: ERROR {type(r).__name__}: {str(r)[:140]}")
            elif isinstance(r, dict) and r.get("entities"):
                print(f"    {model}: {len(r['entities'])} entities")
                draft_dicts.append(r)
            else:
                print(f"    {model}: no entities returned")
        if not draft_dicts:
            raise SystemExit(f"{map_id}: every ensemble describe call failed/empty")

        min_votes = default_min_votes(len(draft_dicts), _min_votes_override())
        arbiter = _arbiter_model()
        if arbiter:
            consensus, minority = await arbiter_reconcile(
                draft_dicts, model=arbiter, min_votes=min_votes, n_models=len(draft_dicts)
            )
        else:
            consensus, minority = merge_entities(
                [d.get("entities", []) for d in draft_dicts], min_votes=min_votes
            )
        labels = [e["label"] for e in consensus]
        detections = await detect(image_bytes, labels)
        segments = await segment(image_bytes, labels, boxes=detections)
        heights_m = heights_lib.infer_heights_m(list(segments))
        geo_entities = attach_geometry(consensus, detections, segments, heights_m)

        scale_tier = vote([d.get("scale_tier") for d in draft_dicts], default="region")
        style = _longest([str(d.get("style", "")) for d in draft_dicts])
        description = _longest([str(d.get("description", "")) for d in draft_dicts])
        label_to_ref = {norm_label(e["label"]): e["ref"] for e in geo_entities}
        relations = merge_relations(
            [d.get("relations", []) for d in draft_dicts],
            label_to_ref,
            allowed=set(_plan_relations()),
        )
        agreement = agreement_score(geo_entities, n)

        jr = await judge.score_annotation(image_bytes, description, labels)
        status = decide_status(
            jr.score,
            agreement,
            judge_threshold=_judge_threshold(),
            agreement_threshold=_agreement_threshold(),
        )
        cand = {
            "geo_entities": geo_entities,
            "minority": minority,
            "scale_tier": scale_tier,
            "style": style,
            "description": description,
            "relations": relations,
            "agreement": agreement,
            "judge_score": jr.score,
            "rationale": jr.rationale,
            "status": status,
            "iters": attempt + 1,
            "contributors": len(draft_dicts),
            "min_votes": min_votes,
            "reconcile": arbiter or "deterministic-merge",
        }
        if best is None or cand["judge_score"] > best["judge_score"]:
            best = cand
        if status == "verified":
            break
        feedback = jr.rationale

    assert best is not None
    annotation = {
        "ensemble": models,
        "contributors": best["contributors"],
        "reconcile": best["reconcile"],
        "min_votes": best["min_votes"],
        "iters": best["iters"],
        "judge_score": round(float(best["judge_score"]), 2),
        "agreement": round(float(best["agreement"]), 3),
        "minority": [m["label"] for m in best["minority"]],
        "judge_rationale": best["rationale"],
    }
    desc = assemble_description(
        map_id=map_id,
        genre=genre,
        style=best["style"],
        scale_tier=best["scale_tier"],
        description=best["description"],
        frame={"w": FRAME_W, "h": FRAME_H},
        entities=best["geo_entities"],
        relations=best["relations"],
        rev=_next_rev(map_id),
        annotation=annotation,
        status=best["status"],
        by="ensemble-annotate",
        date=time.strftime("%Y-%m-%d", time.gmtime()),
    )
    rel = output_name(
        map_id, _existing_status(map_id), best["status"], force=_force_overwrite()
    )
    out = DESCRIPTIONS / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(desc, indent=1) + "\n")
    print(
        f"  {map_id}: {best['status']} "
        f"(judge {annotation['judge_score']}, agreement {annotation['agreement']}, "
        f"{len(best['geo_entities'])} entities, {best['iters']} iter) -> {rel}"
    )
    if rel.startswith("candidates/"):
        why = (
            "verdict is needs_human"
            if best["status"] != "verified"
            else "a verified original is preserved"
        )
        print(
            f"  (wrote a CANDIDATE — {why}; review it, then move it into descriptions/ "
            "to promote)"
        )
    return out


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


async def _run(target: str) -> int:
    ids = [m["id"] for m in load_manifest()] if target == "all" else [target]
    for map_id in ids:
        print(f"annotating {map_id} ...")
        await annotate_one(map_id)
    return 0


def main() -> int:
    if os.environ.get("CORPUS_ANNOTATE_RUN") != "1":
        models = _ensemble_models()
        print(
            "corpus-annotate: PAID (ensemble describe + detector + segmenter + "
            "judge per map, ~$0.03-0.10/map depending on ensemble size). "
            "Set CORPUS_ANNOTATE_RUN=1 to run."
        )
        print(f"  ensemble ({len(models)}): {', '.join(models)}")
        print(
            f"  gates: judge>={_judge_threshold()} AND agreement>="
            f"{_agreement_threshold()} -> auto-verified, else needs_human"
        )
        print(
            "  non-destructive: a verified description is preserved; output lands in "
            "descriptions/candidates/ unless CORPUS_ANNOTATE_FORCE=1"
        )
        return 0
    _load_env()
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    return asyncio.run(_run(target))


if __name__ == "__main__":
    raise SystemExit(main())
