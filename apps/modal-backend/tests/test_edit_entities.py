"""P5 NL-edit core (free): structured geo edits + blast-radius are exact and
tolerant. The LLM call is mocked — only the pure parse/blast and the orchestration
(valid-id gating, garbage → no-op) are under test."""
from __future__ import annotations

from providers import llm
from providers.llm import compute_blast_radius, parse_entity_edits

VALID = {"geo_light", "geo_tower"}


def test_parse_move_set_height_appearance_remove() -> None:
    payload = {
        "edits": [
            {"op": "move", "target": "geo_light", "dx": 0, "dy": -10},
            {"op": "set_height", "target": "geo_tower", "height": 25},
            {"op": "set_appearance", "target": "geo_light", "visual": "red brick"},
            {"op": "remove", "target": "geo_tower"},
        ]
    }
    assert parse_entity_edits(payload, VALID) == [
        {"op": "move", "target": "geo_light", "dx": 0, "dy": -10},
        {"op": "set_height", "target": "geo_tower", "height": 25},
        {"op": "set_appearance", "target": "geo_light", "visual": "red brick"},
        {"op": "remove", "target": "geo_tower"},
    ]


def test_parse_add_with_optional_fields() -> None:
    out = parse_entity_edits(
        {"edits": [{"op": "add", "label": "Well", "pos": {"x": 2, "y": 4},
                    "height": 3, "footprint": {"w": 2, "d": 2}}]},
        VALID,
    )
    assert out == [{"op": "add", "label": "Well", "pos": {"x": 2.0, "y": 4.0},
                    "height": 3.0, "footprint": {"w": 2.0, "d": 2.0}}]


def test_parse_drops_garbage_never_raises() -> None:
    payload = {
        "edits": [
            {"op": "move", "target": "geo_ghost", "dx": 1, "dy": 1},  # id not valid
            {"op": "teleport", "target": "geo_light"},                # unknown op
            {"op": "move", "target": "geo_light"},                    # missing dx/dy
            {"op": "set_appearance", "target": "geo_light", "visual": "  "},  # blank
            {"op": "add", "label": "x"},                              # missing pos
            "not-a-dict",
            {"op": "remove", "target": "geo_tower"},                  # the one keeper
        ]
    }
    assert parse_entity_edits(payload, VALID) == [
        {"op": "remove", "target": "geo_tower"}
    ]


def test_parse_non_list_payload_is_empty() -> None:
    assert parse_entity_edits({"edits": "nope"}, VALID) == []
    assert parse_entity_edits(123, VALID) == []


def test_blast_radius_unions_sorts_dedupes() -> None:
    edits = [
        {"op": "move", "target": "geo_light", "dx": 1, "dy": 0},
        {"op": "set_height", "target": "geo_tower", "height": 5},
    ]
    refs = {"geo_light": ["n3", "n1"], "geo_tower": ["n1", "n2"]}
    assert compute_blast_radius(edits, refs) == ["n1", "n2", "n3"]


def test_blast_radius_add_and_unknown_contribute_nothing() -> None:
    assert compute_blast_radius([{"op": "add", "label": "x", "pos": {"x": 0, "y": 0}}], {}) == []
    assert compute_blast_radius([{"op": "remove", "target": "ghost"}], {"geo_light": ["n1"]}) == []


async def test_edit_entities_nl_drops_invalid_ids_and_computes_blast(
    monkeypatch,
) -> None:
    async def fake_complete_json(**kwargs):
        return {
            "edits": [
                {"op": "move", "target": "geo_light", "dx": 0, "dy": -12},
                {"op": "move", "target": "geo_ghost", "dx": 1, "dy": 1},  # invented id
            ]
        }

    monkeypatch.setattr(llm, "_complete_json", fake_complete_json)
    entities = [{"id": "geo_light", "label": "lighthouse", "pos": {"x": 40, "y": 10}, "height": 25}]
    plan = await llm.edit_entities_nl(
        "move the lighthouse north", entities, {"geo_light": ["n2", "n1"]}
    )
    assert plan.edits == [{"op": "move", "target": "geo_light", "dx": 0, "dy": -12}]
    assert plan.blast_radius == ["n1", "n2"]


async def test_edit_entities_nl_garbage_is_noop(monkeypatch) -> None:
    async def fake(**kwargs):
        return {"not_edits": 123}

    monkeypatch.setattr(llm, "_complete_json", fake)
    plan = await llm.edit_entities_nl("babble", [{"id": "geo_light"}], {})
    assert plan.edits == [] and plan.blast_radius == []
