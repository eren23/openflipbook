"""Small P4 grounding-verify run: generate a scene from its layout clause, then
DETECT the expected entities and DIFF against the intended layout — the grounded
confirmation signal (which entities are really there, which are missing/extra).

Run it (needs FAL_KEY + OPENROUTER_API_KEY, auto-loaded from .env):
    cd apps/modal-backend && .venv/bin/python -m tests.world_bench.grounding_runner
or:  make eval-grounding
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from tests.world_bench.layout_runner import _FIXTURE, _load_env

# Approximate a layout bin → a centre-based box so grounding.diff has numbers.
_H = {"far-left": 0.1, "left": 0.3, "center": 0.5, "right": 0.7, "far-right": 0.9}
_V = {"top": 0.25, "mid": 0.5, "bottom": 0.8}
_S = {"tiny": 0.05, "small": 0.12, "medium": 0.25, "large": 0.45, "huge": 0.7}


def bins_to_box(e: dict[str, Any]) -> dict[str, Any]:
    s = _S.get(e["size"], 0.2)
    return {
        "label": e["label"],
        "x_pct": _H.get(e["h_pos"], 0.5),
        "y_pct": _V.get(e["v_pos"], 0.5),
        "w_pct": s,
        "h_pct": s,
    }


async def run_one(scene: dict[str, Any], aspect: str) -> tuple[str, Any]:
    from providers import detector, geometry_prompt, grounding
    from providers import image as image_provider

    clause = geometry_prompt.layout_constraints(scene["expected"])
    img = await image_provider.generate_image(
        prompt=f"{scene['prompt']}\n\n{clause}", aspect_ratio=aspect, tier="fast"
    )
    labels = [e["label"] for e in scene["expected"]]
    detected = await detector.detect(img.jpeg_bytes, labels)
    expected_boxes = [bins_to_box(e) for e in scene["expected"]]
    return scene["name"], grounding.diff(expected_boxes, detected, iou_thresh=0.1)


async def run() -> None:
    _load_env()
    data = json.loads(_FIXTURE.read_text())
    aspect = data.get("aspect_ratio", "16:9")
    print(f"\n{'scene':22} {'grounding':>9} {'matched':>8} {'missing':>22} {'extra':>14}")
    print("-" * 78)
    for sc in data["scenes"]:
        name, r = await run_one(sc, aspect)
        print(
            f"{name:22} {r.score:9.2f} {len(r.matched):>8} "
            f"{(','.join(r.missing) or '-'):>22} {(','.join(r.extra) or '-'):>14}"
        )
    print()


if __name__ == "__main__":
    asyncio.run(run())
