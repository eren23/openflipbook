"""Ground-truth map corpus: real public-domain maps across genres + detailed,
human-checkable descriptions (entities with positions, footprints, heights in
meters, borders, relations). The reconstruction bench (tests/recon_bench)
regenerates each map from its description and scores the result against this
ground truth. Images are fetched (never committed); descriptions are text and
live in git."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "manifest.json"
IMAGES = ROOT / "images"
DESCRIPTIONS = ROOT / "descriptions"

FRAME_W = 100.0
FRAME_H = 60.0


def load_manifest() -> list[dict[str, Any]]:
    return json.loads(MANIFEST.read_text())["maps"]


def image_path(map_id: str) -> Path:
    for m in load_manifest():
        if m["id"] == map_id:
            return IMAGES / m["filename"]
    raise KeyError(f"unknown corpus map id: {map_id}")


def load_descriptions(status: str | None = "verified") -> list[dict[str, Any]]:
    """All committed descriptions, optionally filtered by review status.
    The recon bench consumes only verified ones (status='verified');
    status=None returns drafts too (the authoring workflow)."""
    out = []
    for p in sorted(DESCRIPTIONS.glob("*.json")):
        d = json.loads(p.read_text())
        if status is None or d.get("review", {}).get("status") == status:
            out.append(d)
    return out


def description_sha(desc: dict[str, Any]) -> str:
    """Digest of a description's CONTENT (review block excluded — verifying a
    draft shouldn't re-bill its cells unless the ground truth itself changed)."""
    body = {k: v for k, v in desc.items() if k != "review"}
    blob = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:12]
