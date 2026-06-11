"""W2 label-click routing, server half (free): a resolved subject that names
a mapped PLACE upgrades the framing instead of falling through to the fresh
path. Twin of the client's entity-label-match.test.ts."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

# generate.py imports `modal` at module level (deploy-only, not a test dep).
sys.modules.setdefault("modal", MagicMock())

from generate import WorldContextEntity, _match_world_entity  # noqa: E402


def _entity(name: str, kind: str = "place", aliases: list[str] | None = None) -> WorldContextEntity:
    return WorldContextEntity(
        id=name.lower().replace(" ", "-"),
        kind=kind,
        name=name,
        aliases=aliases or [],
        appearance="",
    )


CITY = [
    _entity("Patrician's Palace"),
    _entity("The River Ankh"),
    _entity("Unseen University", aliases=["UU"]),
]


def test_exact_match_case_and_punctuation_insensitive() -> None:
    hit = _match_world_entity(CITY, "patricians palace")
    assert hit is not None and hit["name"] == "Patrician's Palace"


def test_subject_containing_the_label_matches() -> None:
    hit = _match_world_entity(CITY, "The Patrician's Palace and its gardens")
    assert hit is not None and hit["name"] == "Patrician's Palace"


def test_clipped_subject_contained_by_label_matches() -> None:
    hit = _match_world_entity(CITY, "the river")
    assert hit is not None and hit["name"] == "The River Ankh"


def test_alias_matches() -> None:
    hit = _match_world_entity(CITY, "UU")
    assert hit is not None and hit["name"] == "Unseen University"


def test_places_only() -> None:
    people = [_entity("The Librarian", kind="person")]
    assert _match_world_entity(people, "the librarian") is None


def test_no_match_and_empty_subject_return_none() -> None:
    assert _match_world_entity(CITY, "a mysterious stranger") is None
    assert _match_world_entity(CITY, "") is None
    assert _match_world_entity(CITY, None) is None
    assert _match_world_entity(CITY, "the of and") is None  # stop-words only
