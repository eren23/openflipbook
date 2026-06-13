"""ENTER-CONSISTENCY — the A/B for the metric the owner actually cares about:
does the ENTERED place look like the place you tapped on the map?

For each styled top-down map we tap a named landmark and render the entered
scene BOTH ways:
  - FRESH (the shipped bug, byte-faithful): conditioning preamble + scene
    prompt -> generate_image(reference_urls=[region, map, map]) — fal's
    text-to-image accepts-but-IGNORES those refs (research/01), so this arm is
    an unconditioned reinvention. This was the live path until ENTER_EDIT_REF.
  - EDIT (the fix): build_enter_instruction -> edit_image(region crop, style
    ref) on the router's enter_scene model — the path where refs bite.
Optional extra arms via ENTER_BENCH_MODELS (comma-sep ref-honouring slugs,
e.g. fal-ai/flux-pro/kontext,openai/gpt-image-2/edit,fal-ai/nano-banana-2/edit)
decide the enter_scene default empirically.

`score_continuation(region_crop, candidate)` is the judge: 0-10 "is this the
SAME place seen closer?" (it was built for exactly this and never pointed at
the broken path). `score_style_pair(map, candidate)` seconds it on medium.
LIFT = edit_mean - fresh_mean; the committed baseline (eval_baselines.json,
"enter_same_place") guards it against regression once measured.

Paid (fal gens + Gemini judge). Self-contained — no session / web needed:
    cd apps/modal-backend && ENTER_BENCH_RUN=1 \
      .venv/bin/python -m tests.continuity_bench.enter_runner
or:  make eval-enter-drift
The judge + text model default to Gemini (qwen 429s — memory
project_qwen_ratelimit); the balanced image model is forced to nano-banana-pro.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ._score import score_continuation, score_style_pair
from .coherence_runner import crop_box

_REPORTS = Path(__file__).resolve().parent / "reports"
# Below this mean, the edit-routed enter still isn't a trustworthy continuation
# of the tapped region — iterate the instruction/model before trusting it.
_PASS_THRESHOLD = float(os.environ.get("ENTER_BENCH_THRESHOLD", "6.5"))


@dataclass(frozen=True)
class Case:
    name: str
    # The styled top-down map; the prompt PLACES the landmark so `tap` can aim.
    map_prompt: str
    style: str
    # Normalised tap point aimed at the named landmark on the map.
    tap: tuple[float, float]
    # What the tap resolves to (the prefetched_subject / page title analogue).
    place_label: str
    subject_context: str
    surroundings: str
    facts: list[str] = field(default_factory=list)


_CASES: list[Case] = [
    Case(
        name="engraving_harbor_castle",
        map_prompt=(
            "a hand-drawn antique engraving top-down map of a walled harbor "
            "city: a tall striped lighthouse on the north cliff, a market "
            "square in the center, wooden docks along the south shore, and a "
            "stone castle on the east hill; sepia ink, dense cross-hatching, "
            "aged paper"
        ),
        style="hand-drawn antique engraving, sepia ink, dense cross-hatching",
        tap=(0.78, 0.42),
        place_label="The Stone Castle",
        subject_context="a stone castle with towers and walls on a hill east of the harbor",
        surroundings=(
            "to the west, the market square and the harbor; to the north-west, "
            "the striped lighthouse on the cliffs"
        ),
        facts=["the inner bailey", "the east gatehouse"],
    ),
    Case(
        name="watercolor_hilltown_market",
        map_prompt=(
            "a soft watercolour top-down map of a walled hill town: a market "
            "hall at the central square, a bell tower just north of it, "
            "terraced vineyards south of the walls; loose washes, pale pastel "
            "palette, visible paper texture"
        ),
        style="soft watercolour, loose washes, pale pastel palette",
        tap=(0.5, 0.5),
        place_label="The Market Hall",
        subject_context="a timber market hall on the town's central square",
        surroundings="just north, the bell tower; south beyond the walls, terraced vineyards",
        facts=["the cloth stalls", "the well"],
    ),
    Case(
        name="infographic_workshop_bench",
        map_prompt=(
            "a flat vector infographic top-down floor plan of a clockmaker's "
            "workshop: a long workbench along the north wall, a brass lathe in "
            "the center, a parts cabinet on the east wall; clean flat colours, "
            "minimal palette, crisp outlines"
        ),
        style="flat vector infographic, clean flat colours, crisp outlines",
        tap=(0.5, 0.22),
        place_label="The Workbench",
        subject_context="the clockmaker's long workbench along the north wall",
        surroundings="behind it, the brass lathe at the room's center; to the east, the parts cabinet",
        facts=["the escapement jig", "rows of tiny drawers"],
    ),
]


@dataclass(frozen=True)
class CaseResult:
    name: str
    fresh_score: float
    edit_score: float
    fresh_rationale: str
    edit_rationale: str
    # Medium-faithfulness of the edit arm vs the map (style second opinion).
    edit_medium_score: float
    # Optional extra arms: model slug -> same-place score.
    extra_models: dict[str, float] = field(default_factory=dict)

    @property
    def lift(self) -> float:
        # >0 = the edit-routed enter continues the tapped region better.
        return round(self.edit_score - self.fresh_score, 4)


def _crop_region(map_bytes: bytes, tap: tuple[float, float]) -> bytes:
    """Pillow mirror of the client's region crop (cropBox + cropRegionRect) — the same
    region ref the frontend would send for this tap. Test-only dep (Pillow is
    not in the backend runtime)."""
    from PIL import Image

    img = Image.open(io.BytesIO(map_bytes)).convert("RGB")
    bx, by, bw, bh = crop_box(tap[0], tap[1])
    w, h = img.size
    crop = img.crop(
        (round(bx * w), round(by * h), round((bx + bw) * w), round((by + bh) * h))
    )
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


async def _run_case(case: Case, aspect: str) -> CaseResult:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm, model_router

    # 1. The styled top-down map (what the user generated, then tapped).
    src = await image_provider.generate_image(
        prompt=case.map_prompt, aspect_ratio=aspect, tier="balanced"
    )
    map_url = image_provider.encode_data_url(src.jpeg_bytes)
    region_bytes = _crop_region(src.jpeg_bytes, case.tap)
    region_url = image_provider.encode_data_url(region_bytes)

    # 2. One plan shared by both arms (same knowledge, different render route —
    #    a fair A/B). Exactly what generate.py's tap branch asks the planner.
    plan = await llm.plan_page(
        query=case.place_label,
        web_search=False,
        style_anchor=case.style,
        subject_context=case.subject_context,
        render_mode="place_scene",
        surroundings=case.surroundings,
    )
    facts = list(plan.facts or case.facts)

    # 3a. FRESH — the shipped bug, byte-faithful: preamble + styled prompt with
    #     the (inert) reference stack on text-to-image.
    fresh_prompt = (
        image_provider.conditioning_preamble(["region", "parent", "style"], "place_scene")
        + f"Style: {case.style}\n\n{plan.prompt}"
    )
    fresh = await image_provider.generate_image(
        fresh_prompt,
        aspect,
        tier="balanced",
        reference_urls=[region_url, map_url, map_url],
    )

    # 3b. EDIT — the fix: the region crop is the edit source, refs bite.
    instruction = image_edit_provider.build_enter_instruction(
        plan.page_title or case.place_label,
        facts,
        style_anchor=case.style,
        subject_context=case.subject_context,
        surroundings=case.surroundings,
    )
    edited = await image_edit_provider.edit_image(
        region_url,
        instruction,
        model_override=model_router.resolve_model("enter_scene"),
        style_ref_url=map_url,
    )

    # 3c. Optional extra ref-honouring arms (decide the enter default).
    extra: dict[str, float] = {}
    extra_blobs: dict[str, bytes] = {}
    for slug in [
        s.strip() for s in os.environ.get("ENTER_BENCH_MODELS", "").split(",") if s.strip()
    ]:
        alt = await image_edit_provider.edit_image(
            region_url, instruction, model_override=slug, style_ref_url=map_url
        )
        alt_j = await score_continuation(region_bytes, alt.jpeg_bytes)
        extra[slug] = alt_j.score
        extra_blobs[slug] = alt.jpeg_bytes

    # 4. Judge both arms against the tapped region.
    fresh_j = await score_continuation(region_bytes, fresh.jpeg_bytes)
    edit_j = await score_continuation(region_bytes, edited.jpeg_bytes)
    edit_style_j = await score_style_pair(src.jpeg_bytes, edited.jpeg_bytes)

    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / f"enter_{case.name}_map.jpg").write_bytes(src.jpeg_bytes)
    (_REPORTS / f"enter_{case.name}_region.jpg").write_bytes(region_bytes)
    (_REPORTS / f"enter_{case.name}_fresh.jpg").write_bytes(fresh.jpeg_bytes)
    (_REPORTS / f"enter_{case.name}_edit.jpg").write_bytes(edited.jpeg_bytes)
    for slug, blob in extra_blobs.items():
        safe = slug.replace("/", "_").replace(":", "_")
        (_REPORTS / f"enter_{case.name}_{safe}.jpg").write_bytes(blob)

    return CaseResult(
        name=case.name,
        fresh_score=fresh_j.score,
        edit_score=edit_j.score,
        fresh_rationale=fresh_j.rationale,
        edit_rationale=edit_j.rationale,
        edit_medium_score=edit_style_j.score,
        extra_models=extra,
    )


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    """Aggregate the A/B: per-arm same-place means, the LIFT, the trust gate,
    and per-extra-model means. Pure, so the decision is unit-tested free."""
    fresh_mean = round(statistics.mean(r.fresh_score for r in results), 4)
    edit_mean = round(statistics.mean(r.edit_score for r in results), 4)
    extra_means: dict[str, float] = {}
    slugs = {s for r in results for s in r.extra_models}
    for slug in sorted(slugs):
        vals = [r.extra_models[slug] for r in results if slug in r.extra_models]
        extra_means[slug] = round(statistics.mean(vals), 4)
    return {
        "n_cases": len(results),
        "fresh_same_place_mean": fresh_mean,
        "edit_same_place_mean": edit_mean,
        # >0 → the edit route continues the tapped place better than the old
        # text-to-image path. THE number for the owner's complaint.
        "mean_lift": round(edit_mean - fresh_mean, 4),
        "edit_medium_mean": round(
            statistics.mean(r.edit_medium_score for r in results), 4
        ),
        "extra_model_same_place_means": extra_means,
        "edit_trustworthy": edit_mean >= _PASS_THRESHOLD,
    }


async def run_bench() -> dict[str, Any]:
    results = [await _run_case(c, "16:9") for c in _CASES]
    from dataclasses import asdict

    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "enter_model": _enter_model(),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "threshold": _PASS_THRESHOLD,
        "cases": [asdict(r) | {"lift": r.lift} for r in results],
        "summary": summarize(results),
    }


def _enter_model() -> str:
    from providers import model_router

    return model_router.resolve_model("enter_scene") or "unset"


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
    if not os.environ.get("ENTER_BENCH_RUN"):
        raise SystemExit("set ENTER_BENCH_RUN=1 to spend on the paid ENTER-consistency A/B")
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    report = asyncio.run(run_bench())
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "enter_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    summary = report["summary"]
    print(
        f"\nLIFT (edit - fresh, same-place 0-10) = {summary['mean_lift']}; "
        f"edit trustworthy = {summary['edit_trustworthy']} (threshold {_PASS_THRESHOLD})."
    )
    from tests._baseline import load_baselines

    if "enter_same_place" in load_baselines():
        from tests._baseline import compare

        verdict = compare("enter_same_place", summary["mean_lift"], summary["n_cases"])
        print(f"baseline: {verdict.status} — {verdict.detail}")
    else:
        print(
            "baseline: none committed yet — add 'enter_same_place' to "
            "tests/eval_baselines.json from this run."
        )


if __name__ == "__main__":
    _cli()
