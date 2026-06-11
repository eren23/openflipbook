"""Corpus integrity gate (free): every committed description references a
manifest map, refs are unique, positions sit inside the frame, heights pass
the tier sanity band, relations use the solver vocabulary, and borders stay
inside the frame. Runs on drafts AND verified entries — a draft that fails
here isn't worth a human's review time."""
from __future__ import annotations

import json

import pytest

from providers.heights import tier_sanity_band
from providers.llm import _PLAN_RELATIONS
from tests.map_corpus import DESCRIPTIONS, load_manifest

_DESCRIPTIONS = sorted(DESCRIPTIONS.glob("*.json")) if DESCRIPTIONS.exists() else []


def test_manifest_ids_unique_and_filenames_match() -> None:
    maps = load_manifest()
    ids = [m["id"] for m in maps]
    assert len(ids) == len(set(ids))
    for m in maps:
        assert m["filename"].startswith(m["id"]), m["id"]
        assert m["source_url"].startswith("https://"), m["id"]
        assert m["license_note"], m["id"]


def test_corpus_covers_five_genres() -> None:
    genres = {m["genre"] for m in load_manifest()}
    assert len(genres) >= 5, f"corpus spans only {sorted(genres)}"


@pytest.mark.parametrize(
    "path", _DESCRIPTIONS, ids=[p.stem for p in _DESCRIPTIONS]
)
def test_description_integrity(path) -> None:
    desc = json.loads(path.read_text())
    manifest_ids = {m["id"] for m in load_manifest()}
    assert desc["map_id"] in manifest_ids
    assert desc["map_id"] == path.stem
    assert desc["review"]["status"] in {"vlm_draft", "verified"}
    assert desc["description"].strip()
    assert desc["style"].strip()

    frame = desc["frame"]
    refs = [e["ref"] for e in desc["entities"]]
    assert refs and len(refs) == len(set(refs)), "entity refs must be unique"
    lo, hi = tier_sanity_band(desc.get("scale_tier"))
    for e in desc["entities"]:
        assert 0 <= e["pos"]["x"] <= frame["w"], f"{e['ref']} x out of frame"
        assert 0 <= e["pos"]["y"] <= frame["h"], f"{e['ref']} y out of frame"
        assert e["footprint"]["w"] > 0 and e["footprint"]["d"] > 0
        if e.get("height_m"):
            assert lo <= e["height_m"] <= hi, (
                f"{e['ref']}: {e['height_m']} m outside the "
                f"{desc.get('scale_tier')} band {lo}-{hi}"
            )
        for vx, vy in e.get("border") or []:
            assert -1 <= vx <= frame["w"] + 1 and -1 <= vy <= frame["h"] + 1

    for r in desc["relations"]:
        assert r["relation"] in _PLAN_RELATIONS, r
        assert r["subject"] in refs and r["object"] in refs, r
