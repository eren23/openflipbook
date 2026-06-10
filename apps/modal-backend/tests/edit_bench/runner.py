"""EDIT-REGION — the E5 bench: a mask-scoped edit must LAND, CONFINE, and
keep the MEDIUM.

For each styled case a source page is generated live (balanced tier, the
bench precedent), the white=edit mask is built from the case's region box,
the instruction goes through the PRODUCTION fill register
(llm.polish_fill_description) and the PRODUCTION provider
(providers.inpaint). Three scores per arm:
  - alignment: score_prompt_alignment(description, inside crop) — the asked
    change landed, judged where it happened, not diluted across the frame
  - outside:   pixel_diff.changed_fraction beyond the mask — FREE, the
    confinement promise asserted with pixels
  - medium:    score_style_pair(source, result) — the art medium held

Arms: "production" (the inpaint slot) + EDIT_REGION_BENCH_MODELS extras
(comma-sep slugs — the ENTER_BENCH_MODELS precedent; how gpt's decorative
mask was demoted and any future challenger gets judged on the same cases).
EDIT_REGION_BENCH_LOOP=1 runs arms through the PRODUCTION edit loop (judged
retries with critic feedback) so the loop's lift is measurable; the default
stays single-shot so the committed baseline stays comparable.

The committed baseline (tests/eval_baselines.json "edit_region") tracks the
production arm's alignment_mean; outside-stability is a boolean gate, not a
band (lower-is-better fractions would invert _baseline.compare).

Paid (~$0.5-1/run: 2 source gens + per-arm inpaints + judges). Self-contained:
    cd apps/modal-backend && EDIT_REGION_BENCH_RUN=1 \
      .venv/bin/python -m tests.edit_bench.runner
or:  make eval-edit-region
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import statistics
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

_REPORTS = Path(__file__).resolve().parent / "reports"
# Production-arm gates (env-tunable for exploration, defaults committed).
_ALIGN_THRESHOLD = float(os.environ.get("EDIT_REGION_BENCH_THRESHOLD", "6.5"))
_OUTSIDE_MAX = float(os.environ.get("EDIT_REGION_BENCH_OUTSIDE_MAX", "0.02"))
_MEDIUM_FLOOR = float(os.environ.get("EDIT_REGION_BENCH_MEDIUM_FLOOR", "6.0"))


@dataclass(frozen=True)
class Case:
    name: str
    page_prompt: str
    style: str
    region: tuple[float, float, float, float]  # x, y, w, h normalized
    instruction: str
    facts: list[str] = field(default_factory=list)


# ADD-shaped instructions aimed at areas the prompt pins (south-shore water,
# vineyards outside the walls) — robust to the layout variance of live
# generation, unlike remove/replace of a landmark that may drift elsewhere.
_CASES: list[Case] = [
    Case(
        name="engraving_harbor_ship",
        page_prompt=(
            "a hand-drawn antique engraving top-down map of a walled harbor "
            "city: a tall striped lighthouse on the north cliff, a market "
            "square in the center, wooden docks along the south shore, and a "
            "stone castle on the east hill; sepia ink, dense cross-hatching, "
            "aged paper"
        ),
        style="hand-drawn antique engraving, sepia ink, dense cross-hatching",
        region=(0.05, 0.55, 0.24, 0.32),
        instruction="add a three-masted sailing ship on the water here",
    ),
    Case(
        name="watercolor_hilltown_pond",
        page_prompt=(
            "a soft watercolour top-down map of a walled hill town: a market "
            "hall at the central square, a bell tower just north of it, "
            "terraced vineyards south of the walls; loose washes, pale pastel "
            "palette, visible paper texture"
        ),
        style="soft watercolour, loose washes, pale pastel palette",
        region=(0.55, 0.62, 0.28, 0.30),
        instruction="add a small round pond with ducks among the fields here",
    ),
]


@dataclass(frozen=True)
class ArmResult:
    arm: str  # "production" or the override slug
    model: str
    alignment: float
    outside: float
    medium: float
    alignment_rationale: str
    attempts: int = 1  # >1 only under EDIT_REGION_BENCH_LOOP


@dataclass(frozen=True)
class CaseResult:
    name: str
    description: str  # the fill-register text the arms rendered
    arms: list[ArmResult]


def build_mask(size: tuple[int, int], region: tuple[float, float, float, float]) -> bytes:
    """The wire mask: opaque PNG at source dims, WHITE = edit."""
    from PIL import Image, ImageDraw

    w, h = size
    x, y, rw, rh = region
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rectangle(
        (round(x * w), round(y * h), round((x + rw) * w), round((y + rh) * h)),
        fill=255,
    )
    buf = io.BytesIO()
    m.save(buf, "PNG")
    return buf.getvalue()


def _arm_models() -> list[tuple[str, str | None]]:
    extras = [
        s.strip()
        for s in os.environ.get("EDIT_REGION_BENCH_MODELS", "").split(",")
        if s.strip()
    ]
    return [("production", None), *((slug, slug) for slug in extras)]


async def _score_arm(
    arm: str,
    model_override: str | None,
    case: Case,
    description: str,
    src_bytes: bytes,
    src_url: str,
    mask_bytes: bytes,
    mask_url: str,
) -> ArmResult:
    from providers import edit_loop, inpaint, judge, pixel_diff

    loop_mode = bool(os.environ.get("EDIT_REGION_BENCH_LOOP"))

    async def _render(suffix: str) -> Any:
        instr = description if not suffix else f"{description}\n\n{suffix}"
        return await inpaint.inpaint_image(
            image_data_url=src_url,
            mask_data_url=mask_url,
            instruction=instr,
            model_override=model_override,
        )

    if loop_mode:
        result = await edit_loop.run_edit_loop(
            _render,
            source_bytes=src_bytes,
            mask_png=mask_bytes,
            region_box=case.region,
            judge_alignment=judge.score_prompt_alignment,
            judge_medium=judge.score_style_pair,
            instruction=description,
        )
        best = result.best
        out_name = f"edit_{case.name}_{arm.replace('/', '_')}.jpg"
        (_REPORTS / out_name).write_bytes(result.image.jpeg_bytes)
        return ArmResult(
            arm=arm,
            model=getattr(result.image, "model", model_override or "production"),
            alignment=best.alignment.score if best.alignment else 0.0,
            outside=best.outside_change if best.outside_change is not None else 1.0,
            medium=best.medium.score if best.medium else 0.0,
            alignment_rationale=best.alignment.rationale if best.alignment else "",
            attempts=len(result.attempts),
        )

    # Single-shot (the baseline mode). fal occasionally 422s a valid request —
    # one bench-level retry, then a zero arm instead of killing the paid run.
    rendered = None
    for attempt in range(2):
        try:
            rendered = await _render("")
            break
        except Exception as exc:  # bench resilience — reported, not fatal
            print(f"[edit-bench] {case.name}/{arm} attempt {attempt + 1} failed: {exc}")
    if rendered is None:
        return ArmResult(
            arm=arm,
            model=model_override or "production",
            alignment=0.0,
            outside=1.0,
            medium=0.0,
            alignment_rationale="render failed twice (fal)",
        )
    out_bytes = rendered.jpeg_bytes
    (_REPORTS / f"edit_{case.name}_{arm.replace('/', '_')}.jpg").write_bytes(out_bytes)
    outside = pixel_diff.changed_fraction(src_bytes, out_bytes, mask_bytes, invert_mask=True)
    inside = edit_loop.inside_crop_bytes(out_bytes, case.region)
    align = await judge.score_prompt_alignment(description, inside)
    medium = await judge.score_style_pair(src_bytes, out_bytes)
    return ArmResult(
        arm=arm,
        model=rendered.model,
        alignment=align.score,
        outside=round(outside, 4),
        medium=medium.score,
        alignment_rationale=align.rationale,
    )


async def _run_case(case: Case) -> CaseResult:
    from PIL import Image

    from providers import image as image_provider
    from providers import llm

    src = await image_provider.generate_image(
        prompt=case.page_prompt, aspect_ratio="16:9", tier="balanced"
    )
    src_bytes = src.jpeg_bytes
    src_url = image_provider.encode_data_url(src_bytes)
    size = Image.open(io.BytesIO(src_bytes)).size
    mask_bytes = build_mask(size, case.region)
    mask_url = image_provider.encode_data_url(mask_bytes, "image/png")

    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / f"edit_{case.name}_src.jpg").write_bytes(src_bytes)
    (_REPORTS / f"edit_{case.name}_mask.png").write_bytes(mask_bytes)

    # The production register: the command becomes the region's described
    # final content, medium lock appended — exactly what generate.py sends.
    description = await llm.polish_fill_description(
        instruction=case.instruction,
        page_title=case.name.replace("_", " "),
        style_anchor=case.style,
    )
    arms = [
        await _score_arm(
            arm, override, case, description, src_bytes, src_url, mask_bytes, mask_url
        )
        for arm, override in _arm_models()
    ]
    return CaseResult(name=case.name, description=description, arms=arms)


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    """Per-arm means + the production gates. Pure — unit-tested free."""
    by_arm: dict[str, dict[str, float]] = {}
    arm_names = {a.arm for r in results for a in r.arms}
    for arm in sorted(arm_names):
        rows = [a for r in results for a in r.arms if a.arm == arm]
        by_arm[arm] = {
            "alignment_mean": round(statistics.mean(a.alignment for a in rows), 4),
            "outside_max": round(max(a.outside for a in rows), 4),
            "medium_mean": round(statistics.mean(a.medium for a in rows), 4),
        }
    prod = [a for r in results for a in r.arms if a.arm == "production"]
    alignment_mean = (
        round(statistics.mean(a.alignment for a in prod), 4) if prod else 0.0
    )
    return {
        "n_cases": len(results),
        "arms": by_arm,
        "alignment_mean": alignment_mean,
        # Gate 1: the asked change actually lands in the region.
        "asked_change_landed": bool(prod) and alignment_mean >= _ALIGN_THRESHOLD,
        # Gate 2: confinement is a PROMISE — every case, not an average.
        "outside_stable": bool(prod) and all(a.outside <= _OUTSIDE_MAX for a in prod),
        # Gate 3: the medium survives the patch.
        "medium_floor_held": bool(prod)
        and statistics.mean(a.medium for a in prod) >= _MEDIUM_FLOOR,
    }


async def run_bench() -> dict[str, Any]:
    results = [await _run_case(c) for c in _CASES]
    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "loop": bool(os.environ.get("EDIT_REGION_BENCH_LOOP")),
        "align_threshold": _ALIGN_THRESHOLD,
        "outside_max": _OUTSIDE_MAX,
        "medium_floor": _MEDIUM_FLOOR,
        "cases": [asdict(r) for r in results],
        "summary": summarize(results),
    }


def _load_env() -> None:
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
    if not os.environ.get("EDIT_REGION_BENCH_RUN"):
        raise SystemExit("set EDIT_REGION_BENCH_RUN=1 to spend on the paid edit-region bench")
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    report = asyncio.run(run_bench())
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "edit_region_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    s = report["summary"]
    print(
        f"\nEDIT REGION (production arm) alignment = {s['alignment_mean']} "
        f"(threshold {_ALIGN_THRESHOLD}); outside stable = {s['outside_stable']} "
        f"(max {_OUTSIDE_MAX}); medium held = {s['medium_floor_held']} "
        f"(floor {_MEDIUM_FLOOR})."
    )
    from tests._baseline import load_baselines

    if "edit_region" in load_baselines():
        from tests._baseline import compare

        verdict = compare("edit_region", s["alignment_mean"], s["n_cases"])
        print(f"baseline: {verdict.status} — {verdict.detail}")
    else:
        print(
            "baseline: none committed yet — add 'edit_region' to "
            "tests/eval_baselines.json from this run."
        )


if __name__ == "__main__":
    _cli()
