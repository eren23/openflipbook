"""Fetch the ground-truth map corpus to tests/map_corpus/images/ (gitignored).

    .venv/bin/python scripts/fetch_corpus.py          # verify pinned sha256s
    .venv/bin/python scripts/fetch_corpus.py --pin    # first fetch: record shas
or: make corpus-fetch

Free (a few MB of public-domain scans). A sha mismatch on a pinned entry means
the upstream rendition changed — re-pin deliberately, never silently.
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1] / "tests" / "map_corpus"
_MANIFEST = _ROOT / "manifest.json"
_IMAGES = _ROOT / "images"


def _fetch(url: str) -> bytes:
    """Polite fetch: Commons 429s burst traffic — back off and retry."""
    req = urllib.request.Request(
        url, headers={"User-Agent": "openflipbook-corpus/1.0 (personal eval corpus)"}
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 3:
                raise
            wait = 20 * (attempt + 1)
            print(f"  429 — backing off {wait}s")
            time.sleep(wait)
    raise RuntimeError("unreachable")


def main() -> int:
    pin = "--pin" in sys.argv
    data = json.loads(_MANIFEST.read_text())
    _IMAGES.mkdir(parents=True, exist_ok=True)
    changed = False
    for m in data["maps"]:
        dest = _IMAGES / m["filename"]
        if not dest.exists():
            print(f"fetching {m['id']} ...")
            dest.write_bytes(_fetch(m["source_url"]))
            time.sleep(3)  # be polite between files
        sha = hashlib.sha256(dest.read_bytes()).hexdigest()
        if m["sha256"] is None:
            if pin:
                m["sha256"] = sha
                changed = True
                print(f"  pinned {m['id']}: {sha[:16]}…")
            else:
                print(f"  UNPINNED {m['id']}: {sha[:16]}… (run with --pin to record)")
        elif m["sha256"] != sha:
            print(f"  MISMATCH {m['id']}: expected {m['sha256'][:16]}…, got {sha[:16]}…")
            return 1
        else:
            print(f"  ok {m['id']}")
    if changed:
        _MANIFEST.write_text(json.dumps(data, indent=2) + "\n")
        print("manifest updated — commit it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
