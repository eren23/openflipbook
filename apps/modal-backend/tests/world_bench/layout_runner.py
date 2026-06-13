"""Small P3 layout-fidelity A/B.

For each scene, generate it WITH and WITHOUT the geometry layout clause, VLM-judge
both against the expected layout, and report the per-scene fidelity + the mean
lift — i.e. does geometry steering actually help the model place things?

Run it (needs FAL_KEY + OPENROUTER_API_KEY — auto-loaded from apps/modal-backend/.env):
    cd apps/modal-backend && .venv/bin/python -m tests.world_bench.layout_runner
or:  make eval-layout
The judge defaults to Gemini (qwen 429s — see memory project_qwen_ratelimit).
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tests.world_bench._score import (
    LayoutFidelity,
    aggregate_layout_fidelity,
    judge_layout_fidelity,
)

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "layout" / "scenes.json"
_REPORTS = Path(__file__).resolve().parent / "reports"


def _load_env() -> None:
    """Best-effort: load apps/modal-backend/.env so the runner works standalone,
    and pin the judge to Gemini (not the .env's qwen VLM, which rate-limits)."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


@dataclass(frozen=True)
class ABResult:
    name: str
    without: LayoutFidelity
    with_clause: LayoutFidelity

    @property
    def lift(self) -> float:
        return self.with_clause.score - self.without.score


def load_scenes() -> tuple[str, list[dict[str, Any]]]:
    data = json.loads(_FIXTURE.read_text())
    return data.get("aspect_ratio", "16:9"), data["scenes"]


async def run_one(scene: dict[str, Any], aspect: str, tier: str = "fast") -> ABResult:
    from providers import geometry_prompt
    from providers import image as image_provider

    clause = geometry_prompt.layout_constraints(scene["expected"])
    base = scene["prompt"]
    without_img = await image_provider.generate_image(
        prompt=base, aspect_ratio=aspect, tier=tier
    )
    with_img = await image_provider.generate_image(
        prompt=f"{base}\n\n{clause}", aspect_ratio=aspect, tier=tier
    )
    without = aggregate_layout_fidelity(
        await judge_layout_fidelity(without_img.jpeg_bytes, scene["expected"])
    )
    with_clause = aggregate_layout_fidelity(
        await judge_layout_fidelity(with_img.jpeg_bytes, scene["expected"])
    )
    return ABResult(scene["name"], without, with_clause)


def summarize(results: list[ABResult]) -> dict[str, Any]:
    """Pure aggregation — unit-tested free via test_layout_fidelity_runner.py."""
    if not results:
        return {"n_cases": 0, "without_mean": 0.0, "with_clause_mean": 0.0, "mean_lift": 0.0}
    without_mean = round(statistics.mean(r.without.score for r in results), 4)
    with_mean = round(statistics.mean(r.with_clause.score for r in results), 4)
    return {
        "n_cases": len(results),
        "without_mean": without_mean,
        "with_clause_mean": with_mean,
        "mean_lift": round(with_mean - without_mean, 4),
    }


async def run_bench(tier: str = "fast") -> tuple[list[ABResult], dict[str, Any]]:
    aspect, scenes = load_scenes()
    results: list[ABResult] = []
    for sc in scenes:
        results.append(await run_one(sc, aspect, tier))
    print(f"\n{'scene':24} {'without':>8} {'with':>8} {'lift':>8}")
    print("-" * 52)
    for r in results:
        print(
            f"{r.name:24} {r.without.score:8.2f} {r.with_clause.score:8.2f} {r.lift:+8.2f}"
        )
    summary = summarize(results)
    print("-" * 52)
    print(
        f"mean with-clause fidelity: {summary['with_clause_mean']:.3f}    "
        f"mean lift (with - without): {summary['mean_lift']:+.3f}\n"
    )
    report = {
        "judge_model": os.environ.get("WORLD_BENCH_JUDGE_MODEL"),
        "tier": tier,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cases": [
            {
                "name": r.name,
                "without": r.without.score,
                "with_clause": r.with_clause.score,
                "lift": r.lift,
            }
            for r in results
        ],
        "summary": summary,
    }
    return results, report


async def run(tier: str = "fast") -> list[ABResult]:
    results, _ = await run_bench(tier)
    return results


def _cli() -> None:
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    _, report = asyncio.run(run_bench())
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "layout_latest.json").write_text(json.dumps(report, indent=2))
    summary = report["summary"]
    from tests._baseline import compare, load_baselines

    if "layout_fidelity" in load_baselines():
        verdict = compare("layout_fidelity", summary["mean_lift"], summary["n_cases"])
        print(f"baseline: {verdict.status} — {verdict.detail}")
        if verdict.status == "REGRESSION":
            raise SystemExit(f"LAYOUT REGRESSION: {verdict.detail}")


if __name__ == "__main__":
    _cli()
