"""VLM-draft a corpus description — the authoring workflow's first half.

    CORPUS_DRAFT_RUN=1 .venv/bin/python -m tests.map_corpus.draft <map-id|all>
or: make corpus-draft id=<map-id>

Per map (PAID, ~3 Gemini calls ≈ $0.015): one describe call (style, prose,
entities, relations), one detector pass (positions/footprints in the 100x60
frame), one segmenter pass (borders + the anchored height ladder). The output
lands in descriptions/<id>.json with review.status="vlm_draft" — a HUMAN (or
an agent with eyes on the image) then corrects labels/positions/heights and
prose, flips status to "verified", bumps rev. The recon bench consumes only
verified entries; the description sha is part of the cell key, so an edit
re-bills exactly that map's cells.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from tests.map_corpus import DESCRIPTIONS, FRAME_H, FRAME_W, image_path, load_manifest

_DESCRIBE_SYSTEM = (
    "You are a careful cartographic annotator. Given a map image, return ONE "
    "JSON object: {style: <art medium + palette, <=25 words>, scale_tier: one "
    'of ["region","city","district","place"], description: <a precise 120-200 '
    "word prose description of the WHOLE map a painter could redraw it from — "
    "name the major features, their relative positions (north/south/etc), "
    "relative sizes and heights>, entities: [6-10 of the most prominent named "
    "features: {ref: <kebab-slug>, kind: one of "
    '["place","item","creature","person"], label: <name as lettered or a '
    "plain name>, visual: <=12 words}], relations: [4-8 spatial relations "
    "between entity refs: {subject: <ref>, relation: one of "
    '["near","behind","in_front_of","left_of","right_of","inside","on_top_of",'
    '"facing"], object: <ref>}]}. Use only refs you declared.'
)


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


async def _describe(image_bytes: bytes) -> dict[str, Any]:
    from providers import llm

    b64 = base64.b64encode(image_bytes).decode("ascii")
    model = os.environ.get("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")
    client = llm._client()
    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _DESCRIBE_SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this map."},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{b64}",
                            "detail": "high",
                        },
                    },
                ],
            },
        ],
        temperature=0.0,
        max_tokens=1600,
        **llm._maybe_response_format(model),
    )
    raw = resp.choices[0].message.content or "{}"
    return json.loads(raw[raw.find("{") : raw.rfind("}") + 1])


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


async def draft_one(map_id: str) -> Path:
    from providers import heights
    from providers.detector import detect
    from providers.segmenter import segment

    genre = next(m["genre"] for m in load_manifest() if m["id"] == map_id)
    img = image_path(map_id)
    if not img.exists():
        raise SystemExit(f"{img} missing — run `make corpus-fetch` first")
    image_bytes = img.read_bytes()

    described = await _describe(image_bytes)
    raw_entities = [
        e for e in described.get("entities", [])
        if isinstance(e, dict) and str(e.get("label", "")).strip()
    ]
    labels = [str(e["label"]).strip() for e in raw_entities]

    detection_list = await detect(image_bytes, labels)
    detections = {d["label"].lower(): d for d in detection_list}
    segments = await segment(image_bytes, labels, boxes=detection_list)
    seg_by_label = {s["label"].lower(): s for s in segments}
    heights_m = heights.infer_heights_m(list(segments))

    entities = []
    for e in raw_entities:
        label = str(e["label"]).strip()
        det = detections.get(label.lower())
        if det is None:
            print(f"  drop {label!r}: detector found no box (prose keeps it)")
            continue
        seg = seg_by_label.get(label.lower())
        entities.append(
            {
                "ref": _slug(str(e.get("ref") or label)),
                "kind": str(e.get("kind") or "place"),
                "label": label,
                "visual": str(e.get("visual") or ""),
                "pos": {
                    "x": round(det["x_pct"] * FRAME_W, 1),
                    "y": round(det["y_pct"] * FRAME_H, 1),
                },
                "footprint": {
                    "w": round(max(det["w_pct"] * FRAME_W, 0.5), 1),
                    "d": round(max(det["h_pct"] * FRAME_H, 0.5), 1),
                },
                "height_rel": seg["rel_height"] if seg else 0.0,
                "height_m": round(heights_m.get(label, 0.0), 1) or None,
                "border": (
                    [
                        [round(x * FRAME_W, 1), round(y * FRAME_H, 1)]
                        for x, y in seg["polygon"]
                    ]
                    if seg
                    else None
                ),
            }
        )

    refs = {e["ref"] for e in entities}
    relations = [
        r for r in described.get("relations", [])
        if isinstance(r, dict)
        and _slug(str(r.get("subject", ""))) in refs
        and _slug(str(r.get("object", ""))) in refs
    ]
    relations = [
        {
            "subject": _slug(str(r["subject"])),
            "relation": str(r.get("relation", "near")),
            "object": _slug(str(r["object"])),
        }
        for r in relations
    ]

    desc = {
        "map_id": map_id,
        "rev": 1,
        "genre": genre,
        "style": str(described.get("style") or ""),
        "scale_tier": str(described.get("scale_tier") or "region"),
        "frame": {"w": FRAME_W, "h": FRAME_H},
        "description": str(described.get("description") or ""),
        "entities": entities,
        "relations": relations,
        "review": {"status": "vlm_draft", "by": "", "date": ""},
    }
    DESCRIPTIONS.mkdir(parents=True, exist_ok=True)
    out = DESCRIPTIONS / f"{map_id}.json"
    out.write_text(json.dumps(desc, indent=1) + "\n")
    print(f"  wrote {out.name}: {len(entities)} entities, {len(relations)} relations")
    return out


async def _run(target: str) -> int:
    ids = [m["id"] for m in load_manifest()] if target == "all" else [target]
    for map_id in ids:
        print(f"drafting {map_id} ...")
        await draft_one(map_id)
    return 0


def main() -> int:
    if os.environ.get("CORPUS_DRAFT_RUN") != "1":
        print("corpus-draft: PAID (~$0.015/map, Gemini). Set CORPUS_DRAFT_RUN=1 to run.")
        return 0
    _load_env()
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    return asyncio.run(_run(target))


if __name__ == "__main__":
    raise SystemExit(main())
