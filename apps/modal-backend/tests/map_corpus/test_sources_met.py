"""Met source-adapter gate (free): the pure Met-object -> manifest-row mapping
that keeps only CC0 objects with an image and stamps license + attribution."""
from __future__ import annotations

from tests.map_corpus.sources.met import met_object_to_row


def _obj(**over: object) -> dict[str, object]:
    o: dict[str, object] = {
        "objectID": 45734,
        "isPublicDomain": True,
        "primaryImage": "https://images.metmuseum.org/CRDImages/as/original/DP251139.jpg",
        "title": "Standing Vase",
        "classification": "Ceramics",
    }
    o.update(over)
    return o


def test_met_object_to_row_emits_a_cc0_closeup_row() -> None:
    row = met_object_to_row(_obj())
    assert row is not None
    assert row["id"].startswith("met-45734")
    assert row["tier"] == "closeup"
    assert row["genre"] == "ceramics"
    assert row["source_url"].endswith(".jpg")
    assert row["filename"] == "met-45734.jpg"
    assert "CC0" in row["license_note"]
    assert "Metropolitan" in row["attribution"] and "Standing Vase" in row["attribution"]


def test_met_object_to_row_drops_non_public_domain_or_imageless() -> None:
    assert met_object_to_row(_obj(isPublicDomain=False)) is None
    assert met_object_to_row(_obj(primaryImage="")) is None
    assert met_object_to_row({"objectID": 1}) is None


def test_met_object_to_row_tier_override_and_genre_fallback() -> None:
    row = met_object_to_row(_obj(classification="", department="European Paintings"), tier="interior")
    assert row is not None
    assert row["tier"] == "interior"
    assert row["genre"] == "european-paintings"
