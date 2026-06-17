"""Wikimedia Commons adapter — PD / CC0 / CC-BY raster photos, ideal for the
`interior` tier ("inside places"). Keyless MediaWiki API: a generator=search over
the File namespace returns pages with imageinfo + extmetadata (license + artist).
The pure page->row mapping is gated by test_sources_wikimedia.py; the live search
is a free (no-key, no-spend) CLI. source_url uses the same stable Special:FilePath
?width=1600 form as the hand-seeded maps.

    .venv/bin/python -m tests.map_corpus.sources.wikimedia "cathedral interior" --limit 6
    .venv/bin/python -m tests.map_corpus.sources.wikimedia "library reading room" --append

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

_API = "https://commons.wikimedia.org/w/api.php"
_RASTER = {"image/jpeg", "image/png"}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-") or "x"


def _strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", str(s))).strip()


def _is_free(code: str, short: str) -> bool:
    code = code.lower().strip()
    return (
        code in {"cc0", "pd"}
        or code.startswith("cc-by")
        or "public domain" in short.lower()
    )


def commons_page_to_row(
    page: dict[str, Any], tier: str = "interior", genre: str = "interior"
) -> dict[str, Any] | None:
    """Map a Commons API page to a corpus manifest row, or None if it isn't a
    free-licensed raster image."""
    infos = page.get("imageinfo") or []
    if not infos:
        return None
    ii = infos[0]
    if str(ii.get("mime", "")).lower() not in _RASTER:
        return None
    ext = ii.get("extmetadata") or {}
    code = str((ext.get("License") or {}).get("value") or "")
    short = str((ext.get("LicenseShortName") or {}).get("value") or "")
    if not _is_free(code, short):
        return None

    title = str(page.get("title", "")).split(":", 1)[-1].strip()  # drop "File:"
    if not title:
        return None
    stem, _, ext_name = title.rpartition(".")
    suffix = ext_name.lower() if ext_name.lower() in {"jpg", "jpeg", "png"} else "jpg"
    slug = _slug(stem or title)[:48]
    artist = _strip_html(str((ext.get("Artist") or {}).get("value") or "")) or "Wikimedia Commons"
    return {
        "id": f"wm-{slug}"[:60],
        "tier": tier,
        "genre": _slug(genre),
        "source_url": (
            f"https://commons.wikimedia.org/wiki/Special:FilePath/"
            f"{urllib.parse.quote(title)}?width=1600"
        ),
        "license_note": f"{short or code} (via Wikimedia Commons)",
        "attribution": f"{artist}, via Wikimedia Commons, {short or code}",
        "sha256": None,
        "filename": f"wm-{slug}.{suffix}",
    }


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "openflipbook-corpus/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_rows(query: str, limit: int = 6, tier: str = "interior") -> list[dict[str, Any]]:
    """Live (free) Commons search over the File namespace -> free-licensed rows."""
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": query,
        "gsrnamespace": "6",  # File:
        "gsrlimit": str(max(limit * 3, limit)),  # over-fetch; many will be non-free
        "prop": "imageinfo",
        "iiprop": "url|mime|extmetadata",
    }
    data = _get_json(f"{_API}?{urllib.parse.urlencode(params)}")
    pages = ((data.get("query") or {}).get("pages") or {}).values()
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in pages:
        if len(rows) >= limit:
            break
        row = commons_page_to_row(page, tier=tier, genre=_slug(query))
        if row and row["id"] not in seen:
            seen.add(row["id"])
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
        print('usage: python -m tests.map_corpus.sources.wikimedia "<query>" [--limit N] [--tier T] [--append]')
        return 1
    append = "--append" in args
    tier = args[args.index("--tier") + 1] if "--tier" in args else "interior"
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else 6
    query = next(a for a in args if not a.startswith("--") and not a.isdigit())
    rows = find_rows(query, limit=limit, tier=tier)
    print(json.dumps(rows, indent=2))
    print(f"\n{len(rows)} free-licensed candidate(s) for {query!r} (tier={tier})")
    if append:
        print(f"appended {_append_to_manifest(rows)} new row(s) — run `make corpus-fetch` to pin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
