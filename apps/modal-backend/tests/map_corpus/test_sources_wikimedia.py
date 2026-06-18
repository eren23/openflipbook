"""Wikimedia Commons source-adapter gate (free): the pure page -> manifest-row
mapping that keeps only free-licensed raster images, builds a stable
Special:FilePath URL, and stamps attribution + license."""
from __future__ import annotations

from tests.map_corpus.sources.wikimedia import commons_page_to_row


def _page(**over: object) -> dict[str, object]:
    p: dict[str, object] = {
        "title": "File:Trinity College Library Dublin.jpg",
        "imageinfo": [
            {
                "url": "https://upload.wikimedia.org/wikipedia/commons/x/xx/Trinity.jpg",
                "mime": "image/jpeg",
                "extmetadata": {
                    "License": {"value": "cc-by-sa-4.0"},
                    "LicenseShortName": {"value": "CC BY-SA 4.0"},
                    "Artist": {"value": "<a href='/wiki/User:Foo'>Jane Doe</a>"},
                },
            }
        ],
    }
    p.update(over)
    return p


def test_commons_page_to_row_free_license() -> None:
    row = commons_page_to_row(_page(), genre="library")
    assert row is not None
    assert row["tier"] == "interior"
    assert row["genre"] == "library"
    assert row["id"].startswith("wm-")
    assert "Special:FilePath" in row["source_url"] and "width=1600" in row["source_url"]
    assert "Trinity%20College%20Library%20Dublin.jpg" in row["source_url"]
    assert row["filename"].endswith(".jpg") and row["sha256"] is None
    # attribution has the (HTML-stripped) artist + the license short name
    assert "Jane Doe" in row["attribution"] and "CC BY-SA 4.0" in row["attribution"]


def test_commons_page_to_row_accepts_cc0_and_public_domain() -> None:
    for code, short in [("cc0", "CC0"), ("pd", "Public domain")]:
        p = _page()
        p["imageinfo"][0]["extmetadata"] = {  # type: ignore[index]
            "License": {"value": code},
            "LicenseShortName": {"value": short},
        }
        assert commons_page_to_row(p) is not None


def test_commons_page_to_row_rejects_nonfree_and_nonraster() -> None:
    nonfree = _page()
    nonfree["imageinfo"][0]["extmetadata"] = {  # type: ignore[index]
        "License": {"value": "fair use"},
        "LicenseShortName": {"value": "Fair use"},
    }
    assert commons_page_to_row(nonfree) is None

    pdf = _page()
    pdf["imageinfo"][0]["mime"] = "application/pdf"  # type: ignore[index]
    assert commons_page_to_row(pdf) is None

    assert commons_page_to_row({"title": "File:x.jpg"}) is None
