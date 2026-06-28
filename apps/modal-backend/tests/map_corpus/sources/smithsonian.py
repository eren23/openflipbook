"""Smithsonian Open Access adapter — CC0 object photography (and some interiors /
maps) across 19 units, ideal for the `closeup` tier alongside the Met. The v1.0
Open Access API (api.si.edu) needs an api.data.gov key; the pure record->row
mapping is gated by test_sources_smithsonian.py, the live search is a free CLI.

    export SMITHSONIAN_API_KEY=...        # from https://api.data.gov/signup/ (DEMO_KEY works, low limits)
    .venv/bin/python -m tests.map_corpus.sources.smithsonian "pocket watch" --limit 8
    .venv/bin/python -m tests.map_corpus.sources.smithsonian "telescope" --append   # add to manifest

Rows are added WITHOUT a sha256; `make corpus-fetch` pins them on first download.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from tests.map_corpus import MANIFEST

_BASE = "https://api.si.edu/openaccess/api/v1.0"


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-") or "x"


def _is_cc0(media_item: dict[str, Any], dnr: dict[str, Any]) -> bool:
    """CC0 can be stamped per-media (usage.access) or only at the record level
    (metadata_usage.access). Prefer the media's own grant, fall back to the
    record's."""
    media_access = (media_item.get("usage") or {}).get("access")
    if media_access:
        return str(media_access).upper() == "CC0"
    return str((dnr.get("metadata_usage") or {}).get("access") or "").upper() == "CC0"


def _image_url(media_item: dict[str, Any]) -> str | None:
    """The canonical full image: the media's `content` URL when it's an http link,
    else a IIIF/deliveryService URL built from its `idsId`."""
    content = str(media_item.get("content") or "").strip()
    if content.startswith("http"):
        return content
    ids = str(media_item.get("idsId") or "").strip()
    if ids:
        return f"https://ids.si.edu/ids/deliveryService?id={urllib.parse.quote(ids)}&max=1600"
    return None


def smithsonian_record_to_row(
    record: dict[str, Any], tier: str = "closeup", genre: str | None = None
) -> dict[str, Any] | None:
    """Map a Smithsonian Open Access record to a corpus manifest row, or None if
    it has no CC0 image. genre: explicit arg > indexedStructured.object_type >
    "object"."""
    content = record.get("content") or {}
    dnr = content.get("descriptiveNonRepeating") or {}
    media_list = ((dnr.get("online_media") or {}).get("media")) or []

    image: str | None = None
    for m in media_list:
        if str(m.get("type", "")).lower() != "images":
            continue
        url = _image_url(m)
        if url and _is_cc0(m, dnr):
            image = url
            break
    if not image:
        return None

    title = str((dnr.get("title") or {}).get("content") or record.get("title") or "untitled").strip()
    unit = str(dnr.get("unit_code") or record.get("unitCode") or "Smithsonian").strip()
    object_type = (content.get("indexedStructured") or {}).get("object_type") or []
    genre_label = genre or (object_type[0] if object_type else None) or "object"
    row_id = f"si-{_slug(record.get('id') or title)}"[:60]
    record_link = str(dnr.get("record_link") or "").strip()
    attribution = f'"{title}", {unit}, Smithsonian Open Access, CC0'
    if record_link:
        attribution += f" — {record_link}"
    return {
        "id": row_id,
        "tier": tier,
        "genre": _slug(genre_label),
        "source_url": image,
        "license_note": "CC0 (Smithsonian Open Access)",
        "attribution": attribution,
        "sha256": None,  # pinned by scripts/fetch_corpus.py on first fetch
        "filename": f"{row_id}.jpg",  # corpus invariant: filename starts with id
    }


def _api_key() -> str:
    return (
        os.environ.get("SMITHSONIAN_API_KEY")
        or os.environ.get("DATA_GOV_API_KEY")
        or "DEMO_KEY"
    )


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "openflipbook-corpus/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_rows(query: str, limit: int = 8, tier: str = "closeup") -> list[dict[str, Any]]:
    """Live (free) Open Access search narrowed to image records; CC0 is enforced
    in the mapping, so we over-fetch and filter. Network — only the CLI calls
    this."""
    params = {
        "api_key": _api_key(),
        "q": f'{query} AND online_media_type:"Images"',
        "rows": str(min(max(limit * 4, 10), 100)),  # over-fetch (CC0 yield is low), API caps at 100
    }
    try:
        data = _get_json(f"{_BASE}/search?{urllib.parse.urlencode(params)}")
    except urllib.error.HTTPError as e:
        if e.code == 429:
            hint = " — set SMITHSONIAN_API_KEY (DEMO_KEY is heavily rate-limited)"
        elif e.code in (401, 403):
            hint = " — check that SMITHSONIAN_API_KEY is valid"
        else:
            hint = ""
        print(f"smithsonian: HTTP {e.code} {e.reason}{hint}", file=sys.stderr)
        return []
    records = ((data.get("response") or {}).get("rows")) or []
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rec in records:
        if len(rows) >= limit:
            break
        try:
            row = smithsonian_record_to_row(rec, tier=tier)
        except Exception as e:  # malformed record — surface it, don't silently shrink the result
            print(f"smithsonian: skipping record {rec.get('id', '?')}: {e!r}", file=sys.stderr)
            continue
        if row and row["id"] not in seen:
            seen.add(row["id"])
            rows.append(row)
    if len(rows) < limit:
        print(f"smithsonian: only {len(rows)}/{limit} CC0 rows for {query!r} "
              "(API cap or low CC0 yield — try a more image-rich subject)", file=sys.stderr)
    return rows


def _append_to_manifest(rows: list[dict[str, Any]]) -> int:
    data = json.loads(MANIFEST.read_text())
    have = {m["id"] for m in data["maps"]}
    added = [r for r in rows if r["id"] not in have]
    data["maps"].extend(added)
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n")
    return len(added)


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print('usage: python -m tests.map_corpus.sources.smithsonian "<query>" [--limit N] [--tier T] [--append]')
        return 1
    append = "--append" in args
    tier = args[args.index("--tier") + 1] if "--tier" in args else "closeup"
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else 8
    query = next(a for a in args if not a.startswith("--") and not a.isdigit())
    if _api_key() == "DEMO_KEY":
        print("note: using DEMO_KEY (low rate limit) — set SMITHSONIAN_API_KEY for real runs.")
    rows = find_rows(query, limit=limit, tier=tier)
    print(json.dumps(rows, indent=2))
    print(f"\n{len(rows)} CC0 candidate(s) for {query!r} (tier={tier})")
    if append:
        print(f"appended {_append_to_manifest(rows)} new row(s) — run `make corpus-fetch` to pin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
