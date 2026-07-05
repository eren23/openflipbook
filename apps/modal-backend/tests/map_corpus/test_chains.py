"""Descent-chain resolution gate (free): a child manifest row's parent_id +
parent_ref resolves to an anchor point in the parent map's description, so the
descent bench knows WHERE in the parent to enter."""
from __future__ import annotations

from tests.map_corpus.chains import descent_chains, parent_anchor


def _parent() -> dict:
    return {
        "map_id": "manor",
        "entities": [
            {"ref": "church", "label": "Church", "pos": {"x": 52.1, "y": 35.5}},
            {"ref": "mill", "label": "Mill", "pos": {"x": 57.4, "y": 40.3}},
        ],
    }


def test_parent_anchor_finds_entity_pos() -> None:
    a = parent_anchor(_parent(), "church")
    assert a == {"label": "Church", "pos": {"x": 52.1, "y": 35.5}}
    assert parent_anchor(_parent(), "missing") is None


def test_descent_chains_resolves_linked_rows_only() -> None:
    manifest = [
        {"id": "manor", "filename": "manor.jpg", "tier": "map"},
        {
            "id": "chester-nave", "filename": "chester-nave.jpg", "tier": "interior",
            "parent_id": "manor", "parent_ref": "church",
        },
        {"id": "lone-interior", "filename": "lone.jpg", "tier": "interior"},  # no link
        {
            "id": "dangling", "filename": "d.jpg", "tier": "interior",
            "parent_id": "manor", "parent_ref": "nonexistent",  # ref not in parent
        },
    ]
    chains = descent_chains(manifest, {"manor": _parent()})
    assert len(chains) == 1
    c = chains[0]
    assert c["child_id"] == "chester-nave" and c["parent_id"] == "manor"
    assert c["child_filename"] == "chester-nave.jpg"
    assert c["parent_filename"] == "manor.jpg"
    assert c["label"] == "Church"
    assert c["anchor"]["pos"] == {"x": 52.1, "y": 35.5}
    assert c["view"] == "interior"  # default when the row omits it


def test_descent_chains_honours_exterior_view() -> None:
    # A chain child can opt into a closer EXTERIOR view (place_lift measurable
    # for map-drawn distinctive buildings) via `view` on its row.
    manifest = [
        {"id": "manor", "filename": "manor.jpg", "tier": "map"},
        {
            "id": "mill-close", "filename": "mill.jpg", "tier": "closeup",
            "parent_id": "manor", "parent_ref": "mill", "view": "exterior",
        },
    ]
    chains = descent_chains(manifest, {"manor": _parent()})
    assert len(chains) == 1 and chains[0]["view"] == "exterior"
