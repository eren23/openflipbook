"""STYLE — medium-consistency A/B for the edit path (guards the medium-lock fix).

The bug this guards: an edit used to drop the source style entirely, so a
drift-prone instruction ("add a clockwork dragon") came back photoreal/3D even
when the source was a hand-drawn engraving. For each (styled source, drift-prone
edit) we edit the source twice:
  - WITHOUT: a bare instruction, no style ref  (the pre-fix edit path).
  - WITH:    the instruction + a medium-lock clause + the source as a style ref
             (the fixed edit path — what generate.py's edit branch now sends).
`score_style_pair(source, result)` judges how well each edit keeps the source's
art MEDIUM (palette/linework/stylisation, subject ignored). We report the per-case
scores + mean lift, and ASSERT the WITH arm stays above a threshold so a future
change can't silently let edits drift back to photoreal.

Paid (fal edits + Gemini judge). Self-contained — no session / web needed:
    cd apps/modal-backend && STYLE_BENCH_RUN=1 \
      .venv/bin/python -m tests.continuity_bench.style_runner
or:  make eval-style
The judge + text model default to Gemini (qwen 429s — see memory
project_qwen_ratelimit); the balanced image model is forced to nano-banana-pro.
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

from ._score import score_style_pair

_REPORTS = Path(__file__).resolve().parent / "reports"
# Below this mean the medium lock has regressed (edits drifting off-medium).
_PASS_THRESHOLD = float(os.environ.get("STYLE_BENCH_THRESHOLD", "6.5"))


@dataclass(frozen=True)
class Case:
    name: str
    # The source is generated in this exact medium; the edit must keep it.
    source_prompt: str
    style: str
    # A deliberately drift-prone edit (tempts a glossy photoreal / 3D render).
    edit: str


_CASES: list[Case] = [
    Case(
        name="engraving_dragon",
        source_prompt=(
            "a hand-drawn antique engraving map of a small fantasy port city, "
            "sepia ink, dense cross-hatching, woodcut linework, aged paper"
        ),
        style="hand-drawn antique engraving, sepia ink, dense cross-hatching, woodcut linework",
        edit="add a colossal clockwork dragon with brass gears coiled around the central tower",
    ),
    Case(
        name="watercolor_robot",
        source_prompt=(
            "a soft watercolour botanical illustration of a walled garden, loose "
            "washes, pale pastel palette, visible paper texture"
        ),
        style="soft watercolour, loose washes, pale pastel palette, visible paper texture",
        edit="add a giant glowing chrome robot standing in the centre of the garden",
    ),
]


@dataclass(frozen=True)
class CaseResult:
    name: str
    without_score: float
    with_score: float
    without_rationale: str
    with_rationale: str

    @property
    def lift(self) -> float:
        return round(self.with_score - self.without_score, 4)


async def _run_case(case: Case, aspect: str, model: str) -> CaseResult:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider

    # 1. Generate the styled source.
    src = await image_provider.generate_image(
        prompt=case.source_prompt, aspect_ratio=aspect, tier="balanced", model_override=model
    )
    src_url = image_provider.encode_data_url(src.jpeg_bytes)

    # 2a. WITHOUT — the pre-fix edit path: bare instruction, no style handling.
    without = await image_edit_provider.edit_image(
        image_data_url=src_url, instruction=case.edit, tier="balanced"
    )
    # 2b. WITH — the fixed edit path: medium-lock clause (exactly what
    #     polish_edit_instruction appends) + the source as a style ref.
    locked = f"{case.edit}. Keep the existing art medium: {case.style}."
    with_arm = await image_edit_provider.edit_image(
        image_data_url=src_url, instruction=locked, tier="balanced", style_ref_url=src_url
    )

    # 3. Judge how well each edit kept the SOURCE's medium.
    without_j = await score_style_pair(src.jpeg_bytes, without.jpeg_bytes)
    with_j = await score_style_pair(src.jpeg_bytes, with_arm.jpeg_bytes)

    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / f"style_{case.name}_source.jpg").write_bytes(src.jpeg_bytes)
    (_REPORTS / f"style_{case.name}_without.jpg").write_bytes(without.jpeg_bytes)
    (_REPORTS / f"style_{case.name}_with.jpg").write_bytes(with_arm.jpeg_bytes)

    return CaseResult(
        name=case.name,
        without_score=without_j.score,
        with_score=with_j.score,
        without_rationale=without_j.rationale,
        with_rationale=with_j.rationale,
    )


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    """Aggregate the per-case scores + the regression pass/fail. Pure, so the
    pass logic (the guard's brain) is unit-tested without spending."""
    without_mean = round(statistics.mean(r.without_score for r in results), 4)
    with_mean = round(statistics.mean(r.with_score for r in results), 4)
    return {
        "n_cases": len(results),
        "without_medium_lock_mean": without_mean,
        "with_medium_lock_mean": with_mean,
        "mean_lift": round(with_mean - without_mean, 4),
        "pass": with_mean >= _PASS_THRESHOLD,
    }


async def run_bench(model: str) -> dict[str, Any]:
    results = [await _run_case(c, "16:9", model) for c in _CASES]
    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "image_model": model,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "threshold": _PASS_THRESHOLD,
        "cases": [asdict(r) | {"lift": r.lift} for r in results],
        "summary": summarize(results),
    }


def _load_env() -> None:
    """Load apps/modal-backend/.env, force nano-banana-pro for the balanced tier
    (the .env pins plain nano-banana — memory project_fal_model_pin) and pin the
    judge + text model to Gemini (the .env's qwen rate-limits)."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("CONTINUITY_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")
    os.environ.setdefault("FAL_IMAGE_MODEL_BALANCED", "fal-ai/nano-banana-pro")
    os.environ.setdefault("FAL_EDIT_MODEL_BALANCED", "fal-ai/nano-banana-pro")


def _cli() -> None:
    if not os.environ.get("STYLE_BENCH_RUN"):
        raise SystemExit("set STYLE_BENCH_RUN=1 to spend on the paid style A/B")
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    model = os.environ.get("STYLE_BENCH_MODEL", "fal-ai/nano-banana-pro")
    report = asyncio.run(run_bench(model))
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "style_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if not report["summary"]["pass"]:
        raise SystemExit(
            f"STYLE REGRESSION: with-medium-lock mean "
            f"{report['summary']['with_medium_lock_mean']} < {_PASS_THRESHOLD}"
        )


if __name__ == "__main__":
    _cli()
