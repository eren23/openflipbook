"""Load a recorded session from disk for scoring.

Session-on-disk layout (simplest path)::

    sessions/<session_id>/
      manifest.json              # ordered list of page entries
      images/page-0.jpg
      images/page-1.jpg
      ...

manifest.json schema::

    {
      "session_id": "...",
      "started_at": "...",
      "pages": [
        {
          "page_id": "...",
          "page_title": "...",
          "image_path": "images/page-0.jpg",
          "prompt": "...",              # the prompt the image-gen received
          "subject": "...",
          "parent_page_id": null,
          "entities": [
            {"entity_id": "boiler", "name": "Boiler",
             "appearance": "iron, soot-streaked, rivets visible"}
          ]
        }
      ]
    }

Capture-from-Mongo is intentionally left out of v1; that adapter belongs
in a separate module so the bench stays decoupled from Mongo schema.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class EntityRef:
    entity_id: str
    name: str
    appearance: str = ""


@dataclass(frozen=True)
class PageRecord:
    page_id: str
    page_title: str
    image_path: Path
    prompt: str
    subject: str
    parent_page_id: str | None = None
    entities: list[EntityRef] = field(default_factory=list)


@dataclass(frozen=True)
class SessionRecord:
    session_id: str
    pages: list[PageRecord]


def load_session(manifest_path: Path) -> SessionRecord:
    """Load a session record from a manifest.json on disk."""
    raw = json.loads(manifest_path.read_text())
    base = manifest_path.parent

    pages: list[PageRecord] = []
    for entry in raw.get("pages", []):
        entities = [
            EntityRef(
                entity_id=e["entity_id"],
                name=e["name"],
                appearance=e.get("appearance", ""),
            )
            for e in entry.get("entities", [])
        ]
        page = PageRecord(
            page_id=entry["page_id"],
            page_title=entry["page_title"],
            image_path=base / entry["image_path"],
            prompt=entry["prompt"],
            subject=entry.get("subject", ""),
            parent_page_id=entry.get("parent_page_id"),
            entities=entities,
        )
        pages.append(page)

    return SessionRecord(session_id=raw["session_id"], pages=pages)
