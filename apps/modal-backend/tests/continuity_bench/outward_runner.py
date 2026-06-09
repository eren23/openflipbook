"""OUTWARD-DRIFT — style A/B for the zoom-out container (the design's risk #1).

The default OUTWARD path is the centered BRIA outpaint, which keeps the source's
pixels as the central sub-region → ZERO style drift by construction. The riskier
medium-flip path (`SCALE_OUTWARD_RERENDER`) synthesizes the container FRESH,
conditioned on the source. This A/B quantifies that risk BEFORE the flag is
enabled: for each styled source we synthesize its container TWICE —
  - OUTPAINT: `expand_image_zoomout` (the default — the zero-drift baseline).
  - FRESH:    `generate_image(scale_parent clause + source as a reference)`
              (exactly what the `mode:"ascend"` SCALE_OUTWARD_RERENDER path sends).
`score_style_pair(source, container)` judges how faithfully each container keeps
the source's art MEDIUM (palette / linework / stylisation, subject ignored). The
DRIFT number = outpaint_mean - fresh_mean (how much the rerender path loses vs the
pixel-preserving outpaint). We ASSERT the FRESH arm clears a threshold before
trusting it — keep `SCALE_OUTWARD_RERENDER` off until it does, at N >= 10.

Paid (fal gens + Gemini judge). Self-contained — no session / web needed:
    cd apps/modal-backend && OUTWARD_BENCH_RUN=1 \
      .venv/bin/python -m tests.continuity_bench.outward_runner
or:  make eval-outward-drift
The judge + text model default to Gemini (qwen 429s — memory
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
# Below this mean the FRESH (rerender) container drifts too far off the source's
# medium to trust — keep SCALE_OUTWARD_RERENDER off until it clears this.
_PASS_THRESHOLD = float(os.environ.get("OUTWARD_BENCH_THRESHOLD", "6.5"))


@dataclass(frozen=True)
class Case:
    name: str
    # The source map/scene is generated in this exact medium; the container must
    # keep it across the OUTWARD hop.
    source_prompt: str
    style: str
    # The source's rung; the container is one step coarser (coarser_tier).
    from_tier: str
    # The subject phrase the fresh planner expands into the wider view.
    subject: str


_CASES: list[Case] = [
    Case(
        name="engraving_city",
        source_prompt=(
            "a hand-drawn antique engraving map of a small fantasy port city, "
            "sepia ink, dense cross-hatching, woodcut linework, aged paper"
        ),
        style="hand-drawn antique engraving, sepia ink, dense cross-hatching, woodcut linework",
        from_tier="city",
        subject="a small fantasy port city",
    ),
    Case(
        name="watercolor_town",
        source_prompt=(
            "a soft watercolour map of a walled hill town, loose washes, pale "
            "pastel palette, visible paper texture"
        ),
        style="soft watercolour, loose washes, pale pastel palette, visible paper texture",
        from_tier="city",
        subject="a walled hill town",
    ),
]


@dataclass(frozen=True)
class CaseResult:
    name: str
    outpaint_score: float
    fresh_score: float
    outpaint_rationale: str
    fresh_rationale: str

    @property
    def drift(self) -> float:
        # How much the fresh rerender loses vs the zero-drift outpaint (>0 = drift).
        return round(self.outpaint_score - self.fresh_score, 4)


async def _run_case(case: Case, aspect: str, model: str) -> CaseResult:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm, model_router

    # 1. Generate the styled source (the thing we zoom OUT from).
    src = await image_provider.generate_image(
        prompt=case.source_prompt, aspect_ratio=aspect, tier="balanced", model_override=model
    )
    src_url = image_provider.encode_data_url(src.jpeg_bytes)
    w, h = (900, 1600) if aspect == "9:16" else (1600, 900)

    # 2a. OUTPAINT — the default OUTWARD path: source centred in a larger frame.
    outp = await image_edit_provider.expand_image_zoomout(src_url, 3.0, w, h)

    # 2b. FRESH — the SCALE_OUTWARD_RERENDER path: plan the container + condition on
    #     the source (exactly what generate.py's ascend branch sends).
    to_tier = model_router.coarser_tier(case.from_tier) or "region"
    plan = await llm.plan_page(
        query=f"{case.subject} (the {to_tier} that contains it)",
        web_search=False,
        style_anchor=case.style,
        render_mode="scale_parent",
    )
    fresh = await image_provider.generate_image(
        plan.prompt, aspect, tier="balanced", reference_urls=[src_url]
    )

    # 3. Judge how faithfully each container kept the SOURCE's medium.
    outp_j = await score_style_pair(src.jpeg_bytes, outp.jpeg_bytes)
    fresh_j = await score_style_pair(src.jpeg_bytes, fresh.jpeg_bytes)

    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / f"outward_{case.name}_source.jpg").write_bytes(src.jpeg_bytes)
    (_REPORTS / f"outward_{case.name}_outpaint.jpg").write_bytes(outp.jpeg_bytes)
    (_REPORTS / f"outward_{case.name}_fresh.jpg").write_bytes(fresh.jpeg_bytes)

    return CaseResult(
        name=case.name,
        outpaint_score=outp_j.score,
        fresh_score=fresh_j.score,
        outpaint_rationale=outp_j.rationale,
        fresh_rationale=fresh_j.rationale,
    )


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    """Aggregate the per-case scores, the drift number + the trust pass/fail. Pure,
    so the decision (the gate's brain) is unit-tested without spending."""
    outpaint_mean = round(statistics.mean(r.outpaint_score for r in results), 4)
    fresh_mean = round(statistics.mean(r.fresh_score for r in results), 4)
    return {
        "n_cases": len(results),
        "outpaint_medium_mean": outpaint_mean,
        "fresh_medium_mean": fresh_mean,
        # >0 → the fresh rerender drifts off-medium vs the zero-drift outpaint.
        "drift": round(outpaint_mean - fresh_mean, 4),
        # Whether the fresh path is faithful enough to enable SCALE_OUTWARD_RERENDER.
        "fresh_trustworthy": fresh_mean >= _PASS_THRESHOLD,
    }


async def run_bench(model: str) -> dict[str, Any]:
    results = [await _run_case(c, "16:9", model) for c in _CASES]
    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "image_model": model,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "threshold": _PASS_THRESHOLD,
        "cases": [asdict(r) | {"drift": r.drift} for r in results],
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


def _cli() -> None:
    if not os.environ.get("OUTWARD_BENCH_RUN"):
        raise SystemExit("set OUTWARD_BENCH_RUN=1 to spend on the paid OUTWARD-drift A/B")
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    model = os.environ.get("OUTWARD_BENCH_MODEL", "fal-ai/nano-banana-pro")
    report = asyncio.run(run_bench(model))
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "outward_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(
        f"\nDRIFT (outpaint - fresh) = {report['summary']['drift']}; "
        f"fresh trustworthy = {report['summary']['fresh_trustworthy']} "
        f"(threshold {_PASS_THRESHOLD}). Outpaint is the zero-drift default; only "
        f"enable SCALE_OUTWARD_RERENDER once 'fresh_trustworthy' holds at N >= 10."
    )


if __name__ == "__main__":
    _cli()
