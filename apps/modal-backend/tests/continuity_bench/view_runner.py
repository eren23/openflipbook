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
    # The failing-first case: the 2026-07-21 failure class was oblique enters
    # into DENSE complex places — the landmark survives but the FRAMING
    # scatters (wider/sideways) across retries. The two cases above pass on
    # attempt 0, so the retry path (and ENTER_RETRY_MODEL_SWAP) never runs;
    # this one crowds the subject so oblique framing is genuinely hard.
    Case(
        name="etched_cliff_monastery",
        map_prompt=(
            "a fine-lined etched top-down map of a sprawling cliffside "
            "monastery complex: a great domed library hall at the center, "
            "twin bell towers flanking it, terraced courtyards stepping down "
            "the cliff to the south, a covered bridge crossing a gorge to the "
            "west, and a walled herb garden northeast; dense fine linework, "
            "muted umber wash, many small annexes and stairways crowding the "
            "slopes"
        ),
        style="fine-lined etching, muted umber wash, dense linework",
        tap=(0.5, 0.45),
        place_label="The Great Library Hall",
        subject_context=(
            "a great domed library hall at the heart of a crowded cliffside "
            "monastery complex, hemmed in by towers, annexes and stairways"
        ),
        surroundings=(
            "twin bell towers flanking the hall; terraced courtyards stepping "
            "down the cliff to the south; the covered gorge bridge to the west"
        ),
        facts=["the reading terrace", "the twin bell towers"],
    ),
]


# The env names the bench honours for its loop accept floors (A/B lever).
_BENCH_ACCEPT_ENVS = (
    "VIEW_BENCH_ACCEPT_CONFORMANCE",
    "VIEW_BENCH_ACCEPT_SAME_PLACE",
    "VIEW_BENCH_ACCEPT_DETAIL",
    "VIEW_BENCH_ACCEPT_MEDIUM",
)


def _bench_loop_config() -> Any:
    """The bench's LoopConfig. Passing a literal here SHORT-CIRCUITS
    loop_config_from_env, so the production VIEW_LOOP_ACCEPT_* env never
    reaches bench runs — accept floors were locked at the dataclass defaults
    and the two seed cases pass on attempt 0, leaving the retry path (and
    ENTER_RETRY_MODEL_SWAP) unexercisable. VIEW_BENCH_ACCEPT_* raises the
    floors for A/Bs that need guaranteed retries; unset env keeps runs
    byte-identical to the old literal (defaults match the dataclass)."""
    from providers import render_loop

    return render_loop.LoopConfig(
        max_attempts=3,
        accept_conformance=render_loop._env_float(
            "VIEW_BENCH_ACCEPT_CONFORMANCE", 7.0
        ),
        accept_same_place=render_loop._env_float("VIEW_BENCH_ACCEPT_SAME_PLACE", 6.0),
        accept_detail=render_loop._env_float("VIEW_BENCH_ACCEPT_DETAIL", 6.0),
        accept_medium=render_loop._env_float("VIEW_BENCH_ACCEPT_MEDIUM", 6.0),
    )


def _selected(name: str, allowed: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return allowed
    picked = [v.strip() for v in raw.split(",") if v.strip()]
    unknown = [v for v in picked if v not in allowed]
    if unknown:
        raise ValueError(f"{name} has unknown value(s): {', '.join(unknown)}")
    return picked


def _positioning_probe_on() -> bool:
    return os.environ.get("VIEW_BENCH_POSITIONING_PROBE", "true").lower() in (
        "1",
        "true",
        "yes",
    )


@dataclass(frozen=True)
class ArmResult:
    arm: str
    conformance: float
    same_place: float
    conformance_rationale: str
    # How many loop attempts produced this arm (1 = single-shot, the default).
    attempts: int = 1
    # Loop mode only: per-attempt judge scores in attempt order, so an A/B can
    # compare the RETRY attempts (index >= 1) — the only ones a retry-model
    # swap changes — instead of just the kept-best headline.
    attempt_scores: list[dict[str, float | None]] = field(default_factory=list)


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


def _style_ref_bytes(map_bytes: bytes) -> bytes:
    """Compact the style exemplar before fal upload.

    The report still keeps the full map, but the second nano reference only
    needs medium/style signal; multi-MB data URLs can stall inside fal upload.
    """
    from PIL import Image, ImageOps

    try:
        max_side = int(os.environ.get("VIEW_BENCH_STYLE_REF_MAX_SIDE", "1024"))
    except ValueError:
        max_side = 1024
    try:
        quality = int(os.environ.get("VIEW_BENCH_STYLE_REF_QUALITY", "82"))
    except ValueError:
        quality = 82
    max_side = max(256, min(2048, max_side))
    quality = max(45, min(95, quality))

    img = ImageOps.exif_transpose(Image.open(io.BytesIO(map_bytes))).convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


async def _run_case(case: Case, aspect: str) -> CaseResult:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import model_router
    from providers.prompt_library import camera as camera_lib

    _REPORTS.mkdir(parents=True, exist_ok=True)
    map_path = _REPORTS / f"view_{case.name}_map.jpg"
    reuse = bool(os.environ.get("VIEW_BENCH_REUSE_ARTIFACTS")) and map_path.exists()
    if reuse:
        map_bytes = map_path.read_bytes()
    else:
        src = await image_provider.generate_image(
            prompt=case.map_prompt, aspect_ratio=aspect, tier="balanced"
        )
        map_bytes = src.jpeg_bytes
    style_ref_url = image_provider.encode_data_url(_style_ref_bytes(map_bytes))
    region_bytes = _crop_region(map_bytes, case.tap)
    region_url = image_provider.encode_data_url(region_bytes)

    loop_mode = bool(os.environ.get("VIEW_BENCH_LOOP"))

    map_path.write_bytes(map_bytes)
    (_REPORTS / f"view_{case.name}_region.jpg").write_bytes(region_bytes)

    arms: list[ArmResult] = []
    for arm in _selected("VIEW_BENCH_ARMS", list(_ARM_VIEWS)):
        view = _ARM_VIEWS[arm]
        # Per-arm model = the production router pick, so the bench measures
        # the full stack instead of a stale model pin.
        arm_model = model_router.select_enter_model(
            str(view.get("projection")) if view else None
        )
        family = camera_lib.model_family(arm_model)
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
        # VIEW_BENCH_LOOP=1: ALL deliberate arms render through the PRODUCTION
        # render loop (judged retries with critic feedback — same-place +
        # medium floors on every camera since the oblique-drift fix) so
        # eval-view-loop measures what users actually get. The default path
        # stays byte-identical (the committed baseline stays comparable).
        if loop_mode and view is not None:
            from providers import judge as judge_mod
            from providers import render_loop

            retry_arm_model = model_router.select_enter_retry_model(arm_model)

            async def _render_attempt(
                suffix: str,
                attempt_index: int,
                _i: str = instruction,
                _first: str | None = arm_model,
                _retry: str | None = retry_arm_model,
            ) -> Any:
                full = _i if not suffix else f"{_i}\n\n{suffix}"
                model = _first if attempt_index == 0 else _retry
                return await image_edit_provider.edit_image(
                    region_url,
                    full,
                    model_override=model,
                    style_ref_url=style_ref_url,
                )

            async def _render(suffix: str) -> Any:
                return await _render_attempt(suffix, 0)

            async def _judge_detail(
                img: bytes, _label: str = case.place_label, _f: list[str] = case.facts
            ) -> Any:
                return await judge_mod.score_feature_articulation(img, _label, _f)

            loop_result = await render_loop.run_view_loop(
                _render,
                projection=_ARM_INTENT[arm],
                region_bytes=region_bytes,
                judge_conformance=judge_mod.score_view_conformance,
                judge_same_place=judge_mod.score_continuation,
                config=_bench_loop_config(),
                judge_detail=_judge_detail,
                judge_medium=judge_mod.score_style_pair,
                render_for_attempt=_render_attempt,
            )
            for i, att in enumerate(loop_result.attempts):
                (_REPORTS / f"view_{case.name}_{arm}_a{i}.jpg").write_bytes(
                    att.image.jpeg_bytes
                )
            best = max(
                loop_result.attempts,
                key=lambda a: (
                    a.conformance.score if a.conformance else -1.0,
                    a.same_place.score if a.same_place else -1.0,
                ),
            )
            (_REPORTS / f"view_{case.name}_{arm}.jpg").write_bytes(
                loop_result.image.jpeg_bytes
            )
            arms.append(
                ArmResult(
                    arm=arm,
                    conformance=best.conformance.score if best.conformance else 0.0,
                    same_place=best.same_place.score if best.same_place else 0.0,
                    conformance_rationale=(
                        best.conformance.rationale if best.conformance else ""
                    ),
                    attempts=len(loop_result.attempts),
                    attempt_scores=[
                        {
                            "conformance": (
                                att.conformance.score if att.conformance else None
                            ),
                            "same_place": (
                                att.same_place.score if att.same_place else None
                            ),
                        }
                        for att in loop_result.attempts
                    ],
                )
            )
            continue
        # fal occasionally 422s a perfectly valid edit ("Could not generate
        # images... Please try again") — one bench-level retry, then record a
        # zero arm instead of killing the whole paid run.
        rendered = None
        for attempt in range(2):
            try:
                rendered = await image_edit_provider.edit_image(
                    region_url,
                    instruction,
                    model_override=arm_model,
                    style_ref_url=style_ref_url,
                )
                break
            except Exception as exc:  # bench resilience — reported, not fatal
                print(f"[view-bench] {case.name}/{arm} attempt {attempt + 1} failed: {exc}")
        if rendered is None:
            arms.append(
                ArmResult(
                    arm=arm,
                    conformance=0.0,
                    same_place=0.0,
                    conformance_rationale="render failed twice (fal)",
                )
            )
            continue
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

    case_names = _selected("VIEW_BENCH_CASES", [c.name for c in _CASES])
    results = [await _run_case(c, "16:9") for c in _CASES if c.name in case_names]
    probe = (
        await _positioning_probe("16:9")
        if _positioning_probe_on()
        else {"skipped": True}
    )
    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "loop": bool(os.environ.get("VIEW_BENCH_LOOP")),
        "arms_filter": os.environ.get("VIEW_BENCH_ARMS"),
        "cases_filter": os.environ.get("VIEW_BENCH_CASES"),
        # Receipts: which accept floors this run actually used (A/B lever).
        "accept_env": {
            k: os.environ[k] for k in _BENCH_ACCEPT_ENVS if k in os.environ
        },
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
