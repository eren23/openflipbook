"""Smithsonian Open Access adapter gate (free): the pure record -> manifest-row
mapping that keeps only CC0 image records and stamps license + attribution.
Smithsonian's strength is CC0 object photography, so it defaults to the closeup
tier (complementing the Met adapter with natural-history / technology breadth)."""
from __future__ import annotations

from typing import Any

from tests.map_corpus.sources.smithsonian import smithsonian_record_to_row

_IMG = "https://ids.si.edu/ids/deliveryService?id=NMAH-AHB2019q012345"


def _record(
    *,
    media_access: str | None = "CC0",
    meta_access: str | None = "CC0",
    content: str | None = _IMG,
    ids_id: str | None = "NMAH-AHB2019q012345",
    media_type: str = "Images",
    with_media: bool = True,
    object_type: tuple[str, ...] = ("Watches",),
    title: str = "Pocket Watch",
) -> dict[str, Any]:
    media: list[dict[str, Any]] = []
    if with_media:
        m: dict[str, Any] = {"type": media_type, "thumbnail": _IMG + "&max=150"}
        if content is not None:
            m["content"] = content
        if ids_id is not None:
            m["idsId"] = ids_id
        if media_access is not None:
            m["usage"] = {"access": media_access}
        media = [m]
    dnr: dict[str, Any] = {
        "title": {"label": "Title", "content": title},
        "unit_code": "NMAH",
        "record_link": "https://americanhistory.si.edu/collections/object/nmah_1234567",
        "online_media": {"mediaCount": len(media), "media": media},
    }
    if meta_access is not None:
        dnr["metadata_usage"] = {"access": meta_access}
    return {
        "id": "edanmdm-nmah_1234567",
        "title": title,
        "unitCode": "NMAH",
        "content": {
            "descriptiveNonRepeating": dnr,
            "indexedStructured": {"object_type": list(object_type)},
        },
    }


def test_smithsonian_record_to_row_emits_a_cc0_closeup_row() -> None:
    row = smithsonian_record_to_row(_record())
    assert row is not None
    assert row["id"].startswith("si-")
    assert row["tier"] == "closeup"
    assert row["genre"] == "watches"  # from indexedStructured.object_type
    assert row["source_url"] == _IMG
    assert row["filename"] == row["id"] + ".jpg"  # corpus invariant: filename starts with id
    assert "CC0" in row["license_note"] and "Smithsonian" in row["license_note"]
    assert "Pocket Watch" in row["attribution"] and "NMAH" in row["attribution"]
    assert row["sha256"] is None  # pinned by make corpus-fetch on first download


def test_smithsonian_record_to_row_drops_non_cc0_or_imageless() -> None:
    # neither the media nor the metadata grants CC0
    assert smithsonian_record_to_row(_record(media_access="Not CC0", meta_access=None)) is None
    # no media at all
    assert smithsonian_record_to_row(_record(with_media=False)) is None
    # the only media is not an image
    assert smithsonian_record_to_row(_record(media_type="Documents")) is None
    # no resolvable image URL (no content, no idsId)
    assert smithsonian_record_to_row(_record(content=None, ids_id=None)) is None


def test_smithsonian_record_to_row_cc0_via_metadata_when_media_usage_absent() -> None:
    # many records carry CC0 only at the metadata level, not per-media
    row = smithsonian_record_to_row(_record(media_access=None, meta_access="CC0"))
    assert row is not None and "CC0" in row["license_note"]


def test_smithsonian_record_to_row_builds_iiif_url_from_idsid_when_no_content() -> None:
    row = smithsonian_record_to_row(_record(content=None, ids_id="NMAH-XYZ-9"))
    assert row is not None
    assert "ids.si.edu" in row["source_url"] and "NMAH-XYZ-9" in row["source_url"]


def test_smithsonian_record_to_row_tier_override_and_genre_fallback() -> None:
    # explicit genre wins; explicit tier overrides
    row = smithsonian_record_to_row(_record(object_type=()), tier="interior", genre="period room")
    assert row is not None
    assert row["tier"] == "interior"
    assert row["genre"] == "period-room"
    # with no object_type and no explicit genre, falls back to a generic label
    bare = smithsonian_record_to_row(_record(object_type=()))
    assert bare is not None and bare["genre"] == "object"
