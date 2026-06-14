"""Small P4 grounding-verify run: generate a scene from its layout clause, then
DETECT the expected entities and DIFF against the intended layout — the grounded
confirmation signal (which entities are really there, which are missing/extra).

Run it (needs FAL_KEY + OPENROUTER_API_KEY, auto-loaded from .env):
    cd apps/modal-backend && GROUNDING_BENCH_RUN=1 \
      .venv/bin/python -m tests.world_bench.grounding_runner
or:  make eval-grounding
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from tests.world_bench.layout_runner import _FIXTURE, _load_env

_REPORTS = Path(__file__).resolve().parent / "reports"

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


@dataclass(frozen=True)
class GroundingCaseResult:
    name: str
    score: float
    matched: int
    missing: list[str]
    extra: list[str]


async def run_one(scene: dict[str, Any], aspect: str) -> GroundingCaseResult:
    from providers import detector, geometry_prompt, grounding
    from providers import image as image_provider

    clause = geometry_prompt.layout_constraints(scene["expected"])
    img = await image_provider.generate_image(
        prompt=f"{scene['prompt']}\n\n{clause}", aspect_ratio=aspect, tier="fast"
    )
    labels = [e["label"] for e in scene["expected"]]
    detected = await detector.detect(img.jpeg_bytes, labels)
    expected_boxes = [bins_to_box(e) for e in scene["expected"]]
    r = grounding.diff(expected_boxes, detected, iou_thresh=0.1)
    return GroundingCaseResult(
        name=scene["name"],
        score=r.score,
        matched=len(r.matched),
        missing=list(r.missing),
        extra=list(r.extra),
    )


def summarize(results: list[GroundingCaseResult]) -> dict[str, Any]:
    """Pure aggregation — unit-tested free."""
    if not results:
        return {"n_cases": 0, "grounding_mean": 0.0, "matched_mean": 0.0}
    return {
        "n_cases": len(results),
        "grounding_mean": round(statistics.mean(r.score for r in results), 4),
        "matched_mean": round(statistics.mean(r.matched for r in results), 4),
    }


async def run_bench() -> dict[str, Any]:
    _load_env()
    data = json.loads(_FIXTURE.read_text())
    aspect = data.get("aspect_ratio", "16:9")
    results = [await run_one(sc, aspect) for sc in data["scenes"]]
    print(f"\n{'scene':22} {'grounding':>9} {'matched':>8} {'missing':>22} {'extra':>14}")
    print("-" * 78)
    for r in results:
        print(
            f"{r.name:22} {r.score:9.2f} {r.matched:>8} "
            f"{(','.join(r.missing) or '-'):>22} {(','.join(r.extra) or '-'):>14}"
        )
    print()
    summary = summarize(results)
    return {
        "judge_model": os.environ.get("WORLD_BENCH_JUDGE_MODEL"),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cases": [asdict(r) for r in results],
        "summary": summary,
    }


def _cli() -> None:
    if not os.environ.get("GROUNDING_BENCH_RUN"):
        raise SystemExit("set GROUNDING_BENCH_RUN=1 to spend on the paid grounding bench")
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    report = asyncio.run(run_bench())
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "grounding_latest.json").write_text(json.dumps(report, indent=2))
    summary = report["summary"]
    from tests._baseline import compare, load_baselines

    if "grounding" in load_baselines():
        verdict = compare("grounding", summary["grounding_mean"], summary["n_cases"])
        print(f"baseline: {verdict.status} — {verdict.detail}")
        if verdict.status == "REGRESSION":
            raise SystemExit(f"GROUNDING REGRESSION: {verdict.detail}")


if __name__ == "__main__":
    _cli()
