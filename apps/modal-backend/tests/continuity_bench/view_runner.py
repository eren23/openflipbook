"""VIEW-CONFORMANCE — does the render actually use the camera we asked for?

The view grammar's eval: for each styled map we tap a landmark and render the
enter FIVE ways — `none` (the legacy "ground level" instruction: the BEFORE
arm) and the four deliberate projections (top_down plan / oblique establishing
/ isometric / eye_level). Each arm is judged twice:
  - score_view_conformance(render, intended): is it ACTUALLY that projection?
    (iso gets the parallel-verticals criterion — the known drift trap)
  - score_continuation(region, render): a view change must NOT cost the
    same-place identity (the enter-consistency invariant rides along).
Plus a POSITIONING probe with zero new machinery: one fresh map rendered with
the layout clause + the top_down camera clause, detector.detect'ed and
grounding.diff'ed against expected bins computed by the NEW project_top_down
port (correct-register bins — the V1 fix for the invalid perspective probe).

Paid (fal gens + Gemini judge), ~$2.5/run. Self-contained:
    cd apps/modal-backend && VIEW_BENCH_RUN=1 \
      .venv/bin/python -m tests.continuity_bench.view_runner
or:  make eval-view
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

from ._score import score_continuation, score_view_conformance
from .coherence_runner import crop_box

_REPORTS = Path(__file__).resolve().parent / "reports"
# Below this mean an intended-projection arm isn't trustworthy.
_CONFORM_THRESHOLD = float(os.environ.get("VIEW_BENCH_THRESHOLD", "6.5"))
# A view change must keep the place: per-arm same-place floor.
_SAME_PLACE_FLOOR = float(os.environ.get("VIEW_BENCH_SAME_PLACE_FLOOR", "6.0"))

_ARM_VIEWS: dict[str, dict[str, Any] | None] = {
    "none": None,  # the legacy instruction — the honest BEFORE measurement
    "top_down": {"projection": "top_down", "pitch_deg": -90.0, "camera_height": "aerial", "source": "user"},
    "oblique": {"projection": "oblique", "pitch_deg": -45.0, "camera_height": "aerial", "source": "user"},
    "isometric": {"projection": "isometric", "pitch_deg": -35.0, "source": "user"},
    "eye_level": {"projection": "eye_level", "pitch_deg": 0.0, "camera_height": "eye", "source": "user"},
}
# What the none arm CLAIMS ("ground level within it") — judged as eye_level.
_ARM_INTENT: dict[str, str] = {
    "none": "eye_level",
    "top_down": "top_down",
    "oblique": "oblique",
    "isometric": "isometric",
    "eye_level": "eye_level",
}


@dataclass(frozen=True)
class Case:
    name: str
    map_prompt: str
    style: str
    tap: tuple[float, float]
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
]


@dataclass(frozen=True)
class ArmResult:
    arm: str
    conformance: float
    same_place: float
    conformance_rationale: str


@dataclass(frozen=True)
class CaseResult:
    name: str
    arms: list[ArmResult]


def _crop_region(map_bytes: bytes, tap: tuple[float, float]) -> bytes:
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
    from providers import model_router
    from providers.prompt_library import camera as camera_lib

    src = await image_provider.generate_image(
        prompt=case.map_prompt, aspect_ratio=aspect, tier="balanced"
    )
    map_url = image_provider.encode_data_url(src.jpeg_bytes)
    region_bytes = _crop_region(src.jpeg_bytes, case.tap)
    region_url = image_provider.encode_data_url(region_bytes)

    enter_model = model_router.resolve_model("enter_scene")
    family = camera_lib.model_family(enter_model)

    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / f"view_{case.name}_map.jpg").write_bytes(src.jpeg_bytes)
    (_REPORTS / f"view_{case.name}_region.jpg").write_bytes(region_bytes)

    arms: list[ArmResult] = []
    for arm, view in _ARM_VIEWS.items():
        instruction = image_edit_provider.build_enter_instruction(
            case.place_label,
            case.facts,
            style_anchor=case.style,
            subject_context=case.subject_context,
            surroundings=case.surroundings,
            view=view,
            family=family if view is not None else None,
            style_ref=True,
        )
        rendered = await image_edit_provider.edit_image(
            region_url,
            instruction,
            model_override=enter_model,
            style_ref_url=map_url,
        )
        conf = await score_view_conformance(rendered.jpeg_bytes, _ARM_INTENT[arm])
        same = await score_continuation(region_bytes, rendered.jpeg_bytes)
        (_REPORTS / f"view_{case.name}_{arm}.jpg").write_bytes(rendered.jpeg_bytes)
        arms.append(
            ArmResult(
                arm=arm,
                conformance=conf.score,
                same_place=same.score,
                conformance_rationale=conf.rationale,
            )
        )
    return CaseResult(name=case.name, arms=arms)


async def _positioning_probe(aspect: str) -> dict[str, Any]:
    """One fresh map with layout clause + the top_down camera clause, verified
    by detector + grounding against bins from the NEW project_top_down port —
    the 'is positioning consistent with the map' number, on correct-register
    bins (the V1 fix for the invalid perspective probe)."""
    from providers import detector, grounding
    from providers import image as image_provider
    from providers.geometry import project_top_down
    from providers.prompt_library import camera as camera_lib
    from providers.prompt_library import layout as layout_lib
    from providers.prompt_library import policy as view_policy

    entities = [
        {"id": "g1", "label": "the lighthouse", "pos": {"x": 20.0, "y": 10.0},
         "height": 12.0, "footprint": {"w": 6.0, "d": 6.0}},
        {"id": "g2", "label": "the market square", "pos": {"x": 50.0, "y": 30.0},
         "height": 2.0, "footprint": {"w": 18.0, "d": 12.0}},
        {"id": "g3", "label": "the stone castle", "pos": {"x": 80.0, "y": 22.0},
         "height": 15.0, "footprint": {"w": 12.0, "d": 10.0}},
    ]
    expected = project_top_down(entities, 100.0, 60.0)  # type: ignore[arg-type]
    prompt = (
        "a hand-drawn engraving map of a small walled harbor city, sepia ink"
        + "\n\n"
        + layout_lib.layout_constraints(expected)
        + "\n\n"
        + camera_lib.camera_clause(view_policy.top_down_map(), medium="hand-drawn engraving")
    )
    img = await image_provider.generate_image(prompt, aspect, tier="balanced")
    (_REPORTS / "view_probe_map.jpg").write_bytes(img.jpeg_bytes)
    detections = await detector.detect(
        img.jpeg_bytes, [str(e["label"]) for e in expected]
    )
    diff = grounding.diff(expected, detections)
    return {
        "grounding_score": diff.score,
        "missing": diff.missing,
        "extra": diff.extra,
        "pos_ok": sum(1 for m in diff.matched if m.pos_ok),
        "matched": len(diff.matched),
    }


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    """Per-arm means + the two gates. Pure — the decision is unit-tested free."""
    by_arm: dict[str, dict[str, float]] = {}
    for arm in _ARM_VIEWS:
        confs = [a.conformance for r in results for a in r.arms if a.arm == arm]
        sames = [a.same_place for r in results for a in r.arms if a.arm == arm]
        if confs:
            by_arm[arm] = {
                "conformance_mean": round(statistics.mean(confs), 4),
                "same_place_mean": round(statistics.mean(sames), 4),
            }
    intended = [v for k, v in by_arm.items() if k != "none"]
    return {
        "n_cases": len(results),
        "arms": by_arm,
        "intended_conformance_mean": round(
            statistics.mean(a["conformance_mean"] for a in intended), 4
        )
        if intended
        else 0.0,
        # Gate 1: every deliberate projection actually lands.
        "view_trustworthy": bool(intended)
        and all(a["conformance_mean"] >= _CONFORM_THRESHOLD for a in intended),
        # Gate 2: no view change may cost the place's identity.
        "same_place_floor_held": bool(intended)
        and all(a["same_place_mean"] >= _SAME_PLACE_FLOOR for a in intended),
    }


async def run_bench() -> dict[str, Any]:
    from dataclasses import asdict

    results = [await _run_case(c, "16:9") for c in _CASES]
    probe = await _positioning_probe("16:9")
    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "conform_threshold": _CONFORM_THRESHOLD,
        "same_place_floor": _SAME_PLACE_FLOOR,
        "cases": [asdict(r) for r in results],
        "positioning_probe": probe,
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
    if not os.environ.get("VIEW_BENCH_RUN"):
        raise SystemExit("set VIEW_BENCH_RUN=1 to spend on the paid view-conformance bench")
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    report = asyncio.run(run_bench())
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "view_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    s = report["summary"]
    print(
        f"\nVIEW CONFORMANCE (intended arms) = {s['intended_conformance_mean']}; "
        f"view trustworthy = {s['view_trustworthy']} (threshold {_CONFORM_THRESHOLD}); "
        f"same-place floor held = {s['same_place_floor_held']} (floor {_SAME_PLACE_FLOOR})."
    )
    from tests._baseline import load_baselines

    if "view_conformance" in load_baselines():
        from tests._baseline import compare

        verdict = compare(
            "view_conformance", s["intended_conformance_mean"], s["n_cases"]
        )
        print(f"baseline: {verdict.status} — {verdict.detail}")
    else:
        print(
            "baseline: none committed yet — add 'view_conformance' to "
            "tests/eval_baselines.json from this run."
        )


if __name__ == "__main__":
    _cli()
