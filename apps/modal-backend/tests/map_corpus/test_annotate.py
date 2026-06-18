"""Ensemble-annotation gate (free): the deterministic reconcile + promote core.

The paid pipeline (tests/map_corpus/annotate.py) fans a describe call out over N
VLMs, then reconciles their entity lists into one consensus WITHOUT another paid
call — that reconcile, the agreement metric and the auto-promote decision are
pure functions and live or die here.
"""
from __future__ import annotations

import pytest

from tests.map_corpus import load_manifest
from tests.map_corpus.annotate import (
    agreement_score,
    assemble_description,
    attach_geometry,
    decide_status,
    default_min_votes,
    describe_system,
    merge_entities,
    merge_relations,
    norm_label,
    output_name,
    parse_arbiter_consensus,
    slug,
    vote,
)

# --- label normalisation -----------------------------------------------------


def test_norm_label_canonicalises_for_matching() -> None:
    assert norm_label("Spyglass Hill") == norm_label("spyglass  hill")
    # a single leading article is dropped so "The Tower" matches "Tower"
    assert norm_label("The Tower") == norm_label("Tower")
    # surrounding punctuation/whitespace stripped, internal kept
    assert norm_label("  Skeleton Island! ") == "skeleton island"


def test_slug_is_kebab() -> None:
    assert slug("Ben Gunn's cave") == "ben-gunn-s-cave"
    assert slug("") == "x"


# --- entity reconcile (the arbiter) ------------------------------------------


def _drafts() -> list[list[dict]]:
    return [
        [
            {"ref": "spyglass", "kind": "place", "label": "Spyglass Hill", "visual": "a peak"},
            {"ref": "skeleton", "kind": "place", "label": "Skeleton Island", "visual": ""},
            # same model names spyglass twice — must still count as ONE vote
            {"ref": "spyglass2", "kind": "place", "label": "spyglass hill", "visual": ""},
        ],
        [
            {"ref": "sg", "kind": "place", "label": "The Spyglass Hill", "visual": "tall snowy mountain peak"},
            {"ref": "sk", "kind": "item", "label": "Skeleton Island", "visual": "rocky islet"},
        ],
        [
            {"ref": "sg", "kind": "place", "label": "Spyglass Hill", "visual": ""},
            {"ref": "rr", "kind": "place", "label": "Random Rock", "visual": "a lone boulder"},
        ],
    ]


def test_merge_keeps_majority_and_flags_minority() -> None:
    consensus, minority = merge_entities(_drafts(), min_votes=2)
    by = {e["ref"]: e for e in consensus}

    # Spyglass Hill: named by all 3 models (the dup in model 0 is ONE vote)
    assert by["spyglass-hill"]["votes"] == 3
    # canonical label = most-frequent surface form, tie broken by first-seen
    assert by["spyglass-hill"]["label"] == "Spyglass Hill"
    # richest (longest) visual wins
    assert by["spyglass-hill"]["visual"] == "tall snowy mountain peak"

    # Skeleton Island: 2 votes, kind tie (place vs item) -> first-seen "place"
    assert by["skeleton-island"]["votes"] == 2
    assert by["skeleton-island"]["kind"] == "place"

    # Random Rock: only 1 model -> minority, not consensus
    assert "random-rock" not in by
    assert [m["label"] for m in minority] == ["Random Rock"]


def test_parse_arbiter_consensus_merges_synonyms_clamps_votes_dedups() -> None:
    # the LLM arbiter returns one consensus list with synonym-corrected votes
    payload = {
        "entities": [
            {"label": "Rete", "kind": "item", "visual": "openwork star disc", "votes": 3},
            {"label": "rete", "kind": "item", "visual": "", "votes": 1},  # dup norm -> dropped
            {"label": "Mater", "kind": "item", "visual": "base plate", "votes": 9},  # clamp to n
            {"label": "  ", "votes": 2},  # blank -> dropped
        ]
    }
    out = parse_arbiter_consensus(payload, n_models=3)
    by = {e["ref"]: e for e in out}
    assert set(by) == {"rete", "mater"}
    assert by["rete"]["votes"] == 3 and by["rete"]["kind"] == "item"
    assert by["rete"]["label"] == "Rete" and by["rete"]["visual"] == "openwork star disc"
    assert by["mater"]["votes"] == 3  # 9 clamped to n_models
    # tolerant: junk shapes yield []
    assert parse_arbiter_consensus(None, 3) == []
    assert parse_arbiter_consensus({"nope": 1}, 3) == []


def test_merge_min_votes_one_keeps_everything() -> None:
    consensus, minority = merge_entities(_drafts(), min_votes=1)
    assert minority == []
    assert {e["ref"] for e in consensus} == {"spyglass-hill", "skeleton-island", "random-rock"}


# --- scalar vote -------------------------------------------------------------


def test_vote_majority_and_tiebreak_and_default() -> None:
    assert vote(["place", "place", "item"]) == "place"
    assert vote(["region", "city"]) == "region"  # tie -> first-seen
    assert vote([], default="region") == "region"


# --- agreement metric --------------------------------------------------------


def test_load_manifest_defaults_tier_to_map_and_filters() -> None:
    rows = load_manifest()
    assert all(r.get("tier") in {"map", "interior", "closeup"} for r in rows)
    maps = load_manifest(tier="map")
    assert maps and all(r["tier"] == "map" for r in maps)
    # the hand-seeded maps carry no explicit tier -> default to "map"
    assert any(r["id"] == "fantasy-treasure-island" for r in maps)
    # tier filtering partitions the manifest
    parts = sum(len(load_manifest(tier=t)) for t in ("map", "interior", "closeup"))
    assert parts == len(rows)


def test_describe_system_is_tier_specific() -> None:
    m = describe_system("map").lower()
    i = describe_system("interior").lower()
    c = describe_system("closeup").lower()
    assert "cartograph" in m
    assert "interior" in i or "room" in i
    assert "object" in c or "close" in c
    assert describe_system("unknown") == describe_system("map")  # safe default


def test_default_min_votes_is_lenient_and_clamped_to_contributors() -> None:
    # regression: a 2-model ensemble must NOT require unanimity (the bug that
    # dropped every entity to minority and produced a 0-entity annotation)
    assert default_min_votes(2, None) == 1
    assert default_min_votes(1, None) == 1
    # an explicit majority policy is honoured...
    assert default_min_votes(3, 2) == 2
    # ...but never exceeds the models that actually contributed, so a strict
    # policy + a dropped model can never force-empty the consensus
    assert default_min_votes(2, 3) == 2
    assert default_min_votes(1, 2) == 1
    assert default_min_votes(5, 0) == 1  # floor of 1


def test_agreement_is_mean_vote_fraction() -> None:
    consensus = [{"votes": 3}, {"votes": 2}]
    assert agreement_score(consensus, n_models=3) == pytest.approx((1.0 + 2 / 3) / 2)
    assert agreement_score([], n_models=3) == 0.0
    assert agreement_score(consensus, n_models=0) == 0.0


# --- auto-promote decision ---------------------------------------------------


def test_decide_status_requires_both_gates() -> None:
    ok = dict(judge_threshold=7.0, agreement_threshold=0.6)
    assert decide_status(9.0, 0.9, **ok) == "verified"
    assert decide_status(7.0, 0.6, **ok) == "verified"  # boundary inclusive
    assert decide_status(5.0, 0.9, **ok) == "needs_human"  # judge too low
    assert decide_status(9.0, 0.4, **ok) == "needs_human"  # agreement too low


# --- non-destructive output routing ------------------------------------------


def test_output_name_routes_by_verdict_and_protects_verified() -> None:
    # an auto-VERIFIED result with nothing to clobber is promoted canonically
    assert output_name("m", None, "verified", force=False) == "m.json"
    # a prior draft may be overwritten by an auto-verified result
    assert output_name("m", "vlm_draft", "verified", force=False) == "m.json"
    # a NON-verified verdict is never written to the reviewed-ground-truth dir —
    # it lands as a candidate (subdir invisible to recon + the integrity gate)
    assert output_name("m", None, "needs_human", force=False) == "candidates/m.json"
    # a committed human-verified description is never silently clobbered...
    assert output_name("m", "verified", "verified", force=False) == "candidates/m.json"
    # ...unless the operator forces it
    assert output_name("m", "verified", "verified", force=True) == "m.json"


# --- relation reconcile ------------------------------------------------------


def test_merge_relations_keeps_consensus_endpoints_and_dedupes() -> None:
    label_to_ref = {"spyglass hill": "spyglass-hill", "skeleton island": "skeleton-island"}
    lists = [
        [
            {"subject": "Spyglass Hill", "relation": "near", "object": "Skeleton Island"},
            {"subject": "Spyglass Hill", "relation": "near", "object": "Random Rock"},  # endpoint not consensus
        ],
        [
            {"subject": "The Spyglass Hill", "relation": "near", "object": "Skeleton Island"},  # dup after norm
            {"subject": "Skeleton Island", "relation": "near", "object": "Skeleton Island"},  # self -> drop
        ],
    ]
    rels = merge_relations(lists, label_to_ref)
    assert rels == [{"subject": "spyglass-hill", "relation": "near", "object": "skeleton-island"}]


def test_merge_relations_enforces_allowed_vocabulary() -> None:
    label_to_ref = {"a": "a", "b": "b"}
    lists = [
        [
            {"subject": "a", "relation": "near", "object": "b"},
            {"subject": "a", "relation": "attached_to", "object": "b"},  # not in vocab
        ]
    ]
    rels = merge_relations(lists, label_to_ref, allowed={"near", "inside"})
    assert rels == [{"subject": "a", "relation": "near", "object": "b"}]
    # no allowed set -> keep all (back-compat)
    assert len(merge_relations(lists, label_to_ref)) == 2


# --- artifact assembly + provenance ------------------------------------------


def test_assemble_strips_votes_and_wires_provenance() -> None:
    entities = [
        {
            "ref": "a", "kind": "place", "label": "A", "visual": "",
            "pos": {"x": 1.0, "y": 2.0}, "footprint": {"w": 1.0, "d": 1.0},
            "height_rel": 0.0, "height_m": None, "border": None, "votes": 3,
        }
    ]
    annotation = {
        "ensemble": ["anthropic/claude", "google/gemini"], "iters": 2,
        "judge_score": 8.0, "agreement": 0.9, "minority": ["Random Rock"],
    }
    d = assemble_description(
        map_id="m", genre="fantasy", style="ink", scale_tier="region",
        description="a place", frame={"w": 100.0, "h": 60.0},
        entities=entities, relations=[], rev=2, annotation=annotation, status="verified",
    )
    assert d["map_id"] == "m" and d["rev"] == 2
    assert d["review"]["status"] == "verified"
    # the corpus entity schema stays clean — votes live in provenance, not the entity
    assert "votes" not in d["entities"][0]
    assert d["annotation"]["judge_score"] == 8.0
    assert d["annotation"]["minority"] == ["Random Rock"]
    # the input list isn't mutated as a side effect
    assert "votes" in entities[0]


# --- geometry bridge (consensus labels -> positioned entities) ---------------


def test_attach_geometry_scales_to_frame_and_drops_undetected() -> None:
    consensus = [
        {"ref": "tower", "kind": "place", "label": "The Tower", "visual": "v", "votes": 3},
        {"ref": "ghost", "kind": "place", "label": "Ghost", "visual": "", "votes": 2},
    ]
    detections = [
        {"label": "the tower", "x_pct": 0.5, "y_pct": 0.2, "w_pct": 0.1, "h_pct": 0.05, "score": 1.0},
    ]
    segments = [
        {"label": "the tower", "polygon": [[0.4, 0.1], [0.6, 0.1], [0.5, 0.3]],
         "rel_height": 0.8, "est_height_m": 30.0, "score": 1.0},
    ]
    heights_m = {"the tower": 30.0}  # segmenter labels come back lowercased

    out = attach_geometry(consensus, detections, segments, heights_m)

    # "Ghost" had no detection box -> dropped (matches draft.py's contract)
    assert [e["ref"] for e in out] == ["tower"]
    e = out[0]
    assert e["label"] == "The Tower" and e["kind"] == "place" and e["votes"] == 3
    assert e["pos"] == {"x": 50.0, "y": 12.0}  # 0.5*100, 0.2*60
    assert e["footprint"] == {"w": 10.0, "d": 3.0}
    assert e["height_rel"] == 0.8
    assert e["height_m"] == 30.0
    assert e["border"] == [[40.0, 6.0], [60.0, 6.0], [50.0, 18.0]]
