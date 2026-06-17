"""The Metropolitan Museum of Art Open Access adapter — CC0 object photography,
ideal for the `closeup` tier. Keyless REST API (collectionapi.metmuseum.org):
search?q=<query> -> objectIDs, objects/<id> -> the object (isPublicDomain +
primaryImage + title + classification). The pure object->row mapping is gated by
test_sources_met.py; the live search is a free (no-key, no-spend) CLI.

    .venv/bin/python -m tests.map_corpus.sources.met "ceramic vase" --limit 8
    .venv/bin/python -m tests.map_corpus.sources.met "ceramic vase" --append   # add to manifest

Rows are added WITHOUT a sha256; `make corpus-fetch` pins them on first download.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from typing import Any

from tests.map_corpus import MANIFEST

_BASE = "https://collectionapi.metmuseum.org/public/collection/v1"


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-") or "x"


def met_object_to_row(obj: dict[str, Any], tier: str = "closeup") -> dict[str, Any] | None:
    """Map a Met object to a corpus manifest row, or None if it isn't CC0 / has
    no image. genre falls back classification -> department -> "object"."""
    if not obj.get("isPublicDomain"):
        return None
    image = str(obj.get("primaryImage") or "").strip()
    if not image:
        return None
    oid = obj.get("objectID")
    title = str(obj.get("title") or "untitled").strip()
    genre = _slug(str(obj.get("classification") or obj.get("department") or "object"))
    return {
        "id": f"met-{oid}-{_slug(title)}"[:60],
        "tier": tier,
        "genre": genre,
        "source_url": image,
        "license_note": "CC0 (The Met Open Access)",
        "attribution": f'"{title}", The Metropolitan Museum of Art, CC0',
        "filename": f"met-{oid}.jpg",
    }


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "openflipbook-corpus/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_rows(query: str, limit: int = 8, tier: str = "closeup") -> list[dict[str, Any]]:
    """Live (free) search: walk Met search results until `limit` CC0 rows are
    collected. Network — only the CLI calls this."""
    search = _get_json(f"{_BASE}/search?hasImages=true&q={urllib.parse.quote(query)}")
    ids = search.get("objectIDs") or []
    rows: list[dict[str, Any]] = []
    for oid in ids:
        if len(rows) >= limit:
            break
        try:
            row = met_object_to_row(_get_json(f"{_BASE}/objects/{oid}"), tier=tier)
        except Exception:
            continue
        if row:
            rows.append(row)
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
        print('usage: python -m tests.map_corpus.sources.met "<query>" [--limit N] [--tier T] [--append]')
        return 1
    append = "--append" in args
    tier = "closeup"
    limit = 8
    if "--tier" in args:
        tier = args[args.index("--tier") + 1]
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    query = next(a for a in args if not a.startswith("--") and not a.isdigit())
    rows = find_rows(query, limit=limit, tier=tier)
    print(json.dumps(rows, indent=2))
    print(f"\n{len(rows)} CC0 candidate(s) for {query!r} (tier={tier})")
    if append:
        n = _append_to_manifest(rows)
        print(f"appended {n} new row(s) to manifest.json — run `make corpus-fetch` to pin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
