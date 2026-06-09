"""Free tests for the place-description parser (parse_scene_graph).

The paid part is the LLM call (plan_world_from_description); these cover the
tolerant coercer: malformed members dropped, never raises, clarifiers capped,
and — the audit's ROOT-2 guard — x/y can never leak in through the parse.
"""
from __future__ import annotations

from providers.llm import parse_scene_graph


def test_valid_graph_parses() -> None:
    g = parse_scene_graph({
        "place_label": "bar",
        "entities": [
            {"ref": "counter", "kind": "item", "label": "bar", "visual": "an oak bar"},
            {"ref": "stool", "kind": "item", "label": "stool", "visual": "a stool", "count": 3},
        ],
        "relations": [{"subject": "stool", "relation": "near", "object": "counter"}],
        "empty_regions": [{"ref": "floor", "note": "open dance floor"}],
    })
    assert g.place_label == "bar"
    assert {e.ref for e in g.entities} == {"counter", "stool"}
    assert len(g.relations) == 1
    assert g.empty_regions[0].ref == "floor"


def test_malformed_entities_dropped() -> None:
    g = parse_scene_graph({
        "place_label": "x",
        "entities": [
            {"ref": "ok", "kind": "item", "label": "ok", "visual": "fine"},
            {"ref": "novisual", "kind": "item", "label": "bad"},               # no visual
            {"ref": "badkind", "kind": "vehicle", "label": "b", "visual": "v"},  # bad kind
            {"label": "noref", "kind": "item", "visual": "v"},                  # no ref
        ],
    })
    assert {e.ref for e in g.entities} == {"ok"}


def test_relation_to_unknown_dropped_but_wall_kept() -> None:
    g = parse_scene_graph({
        "place_label": "x",
        "entities": [{"ref": "door", "kind": "item", "label": "door", "visual": "a door"}],
        "relations": [
            {"subject": "door", "relation": "on_wall", "object": "left_wall"},  # wall -> kept
            {"subject": "door", "relation": "near", "object": "ghost"},         # unknown obj
            {"subject": "ghost", "relation": "near", "object": "door"},         # unknown subj
            {"subject": "door", "relation": "teleport", "object": "door"},      # bad relation
        ],
    })
    assert len(g.relations) == 1
    assert g.relations[0].relation == "on_wall"


def test_clarifiers_capped_and_kind_defaults() -> None:
    g = parse_scene_graph({
        "place_label": "x",
        "place_kind": "nonsense",
        "entities": [{"ref": "a", "kind": "item", "label": "a", "visual": "a"}],
        "clarifiers": ["q1", "q2", "q3", "q4"],
    })
    assert g.place_kind == "place"
    assert len(g.clarifiers) == 2


def test_never_raises_on_garbage() -> None:
    for junk in (None, [], "nope", 42, {"entities": "notalist"}, {"entities": [None, 1, "x"]}):
        assert parse_scene_graph(junk).entities == []


def test_no_xy_leaks_in() -> None:
    # Even if the model wrongly emits coordinates, the PlannedEntity has no x/y
    # field — the ROOT-2 guard enforced at the parse boundary.
    g = parse_scene_graph({
        "place_label": "x",
        "entities": [{"ref": "a", "kind": "item", "label": "a", "visual": "a", "x": 5, "y": 9}],
    })
    e = g.entities[0]
    assert not hasattr(e, "x") and not hasattr(e, "y")
