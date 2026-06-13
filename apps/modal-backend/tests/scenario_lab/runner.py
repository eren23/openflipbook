"""Scenario Lab matrix provider — plugs committed scenarios into matrix_bench.

Registers gen/judge/score functions for scenario JSON arms. Dry-run is the
default; live spend requires MATRIX_BENCH_RUN=1.

    cd apps/modal-backend && .venv/bin/python -m tests.scenario_lab.runner
    MATRIX_SWEEP=tests/scenario_lab/sweeps/layout.json make bench-dry
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from tests.matrix_bench._record import PROMPTS_DIR as MATRIX_PROMPTS_DIR
from tests.matrix_bench._record import load_sweep, render_prompt
from tests.matrix_bench.runner import Scenario, run_matrix
from tests.scenario_lab import (
    REPORTS_DIR,
    filter_by_dimensions,
    resolve_scenario_refs,
    scenario_cell_id,
)

_SWEEPS_DIR = Path(__file__).resolve().parent / "sweeps"
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_REPORT = REPORTS_DIR / "lab_latest.json"

# Arms that map to image manipulation ops (model slug used as cell.model).
_MANIPULATION_ARMS = frozenset({
    "zoom_continue",
    "enter_scene",
    "outpaint",
    "inpaint",
    "edit_without_lock",
    "edit_with_lock",
})

# Process-local source cache for pair judges (style/continuity), keyed by cell
# label. The same bytes are also persisted to the cell cache as source.jpg so
# the gallery can show before/after and a re-judge has the source on disk.
_SOURCE_CACHE: dict[str, bytes] = {}

# Sentinel score meaning "this judge does not apply to this cell" — kept >=0
# scores honest and JSON-safe (NaN breaks the report's JSON.parse). The lab
# score_fn renormalises the composite over the judges that DID apply.
_NA = -1.0

# Scenario POV dimension → the projection name score_view_conformance expects.
_POV_PROJECTION: dict[str, str] = {
    "pov_top_down": "top_down",
    "pov_eye_level": "eye_level",
    "pov_oblique": "oblique",
    "interior": "eye_level",
}


def _projection_for(payload: dict[str, Any]) -> str | None:
    """The intended camera projection for a scenario, from its POV dimension
    tag (or an explicit arm `view`). None = no POV intent declared."""
    for dim in payload.get("dimensions", []):
        if dim in _POV_PROJECTION:
            return _POV_PROJECTION[dim]
    return None


def _desc_sha(data: dict[str, Any]) -> str:
    """Digest of ground truth — rev bump changes cell identity."""
    payload = {
        "id": data["id"],
        "rev": data["rev"],
        "prompt": data.get("prompt", ""),
        "expected_layout": data.get("expected_layout", []),
        "edit_instruction": data.get("edit_instruction", ""),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]


def lab_scenarios(sweep: dict[str, Any]) -> list[Scenario]:
    refs = sweep.get("scenarios", [])
    raw = resolve_scenario_refs(refs, verified_only=True)
    filtered = filter_by_dimensions(raw, sweep.get("dimension_filter"))
    return [
        Scenario(
            id=scenario_cell_id(s),
            desc_sha=_desc_sha(s),
            payload=s,
        )
        for s in filtered
    ]


def _aspect(payload: dict[str, Any], params: dict[str, Any]) -> str:
    return (
        payload.get("requirements", {}).get("aspect_ratio")
        or params.get("aspect_ratio")
        or "16:9"
    )


def _build_prompt(
    payload: dict[str, Any], template: str, arm: str
) -> tuple[str, dict[str, Any]]:
    from providers import geometry_prompt

    slots: dict[str, str] = {
        "prompt": payload.get("prompt", ""),
        "style": payload.get("style", ""),
        "edit": payload.get("edit_instruction", ""),
    }
    text = render_prompt(template, **slots)
    meta: dict[str, Any] = {"arm": arm, "slots": slots}
    arm_cfg = (payload.get("arms") or {}).get(arm, {})
    use_layout = arm in ("fresh_layout",) or arm_cfg.get("layout_clause")
    if use_layout and payload.get("expected_layout"):
        clause = geometry_prompt.layout_constraints(payload["expected_layout"])
        text = f"{text}\n\n{clause}"
        meta["layout_clause"] = True
    return text, meta


def lab_fns(sweep: dict[str, Any]) -> dict[str, Any]:
    """Return gen_fn, judge_fns, extract_fn, score_fn for run_matrix.

    The matrix chassis is SYNCHRONOUS (mirrors recon_bench): the async
    providers are driven through one persistent event loop. gen runs WITHOUT a
    retry (a second image generation would double-bill); judges retry once
    (cheap). Returning bare coroutines here would make the chassis subscript a
    coroutine — the bug this wiring exists to avoid."""
    weights = sweep.get("composite_weights") or {}
    loop = asyncio.new_event_loop()

    def _await(make_coro: Any) -> Any:
        try:
            return loop.run_until_complete(make_coro())
        except Exception:
            time.sleep(5)
            return loop.run_until_complete(make_coro())

    async def _gen_async(cell, payload: dict[str, Any], template: str) -> dict[str, Any]:
        from providers import image as image_provider
        from providers import image_edit as image_edit_provider

        aspect = _aspect(payload, cell.params)
        prompt, meta = _build_prompt(payload, template, cell.arm)
        model = cell.model

        if cell.arm in ("edit_without_lock", "edit_with_lock"):
            src = await image_provider.generate_image(
                prompt=payload.get("prompt", ""),
                aspect_ratio=aspect,
                tier="balanced",
                model_override="fal-ai/nano-banana-pro",
            )
            _SOURCE_CACHE[cell.label] = src.jpeg_bytes
            src_url = image_provider.encode_data_url(src.jpeg_bytes)
            instruction = payload.get("edit_instruction", "")
            if cell.arm == "edit_with_lock":
                style = payload.get("style", "")
                instruction = f"{instruction}. Keep the existing art medium: {style}."
                edited = await image_edit_provider.edit_image(
                    image_data_url=src_url,
                    instruction=instruction,
                    tier="balanced",
                    style_ref_url=src_url,
                    model_override=model,
                )
            else:
                edited = await image_edit_provider.edit_image(
                    image_data_url=src_url,
                    instruction=instruction,
                    tier="balanced",
                    model_override=model,
                )
            return {
                "jpeg": edited.jpeg_bytes,
                "model": model,
                "inputs": {**meta, "prompt": instruction, "source": "edit"},
                "artifacts": {"source.jpg": src.jpeg_bytes},
            }

        # Video: real image-to-video. Fail LOUD — if the clip call raises, let
        # it propagate so the chassis records status:"failed"; never return the
        # still poster as if a video was produced. On success the poster (the
        # source frame) is the cell image and the clip URL rides in inputs.
        if cell.arm == "animate":
            from providers import video as video_provider

            src = await image_provider.generate_image(
                prompt=payload.get("prompt", ""),
                aspect_ratio=aspect,
                tier="balanced",
                model_override="fal-ai/nano-banana-pro",
            )
            src_url = image_provider.encode_data_url(src.jpeg_bytes)
            tier = "fast" if "ltx-video" in model else "balanced"
            clip = await video_provider.animate_image(
                image_data_url=src_url,
                prompt=payload.get("prompt", ""),
                tier=tier,
            )
            return {
                "jpeg": src.jpeg_bytes,
                "model": model,
                "inputs": {
                    **meta,
                    "manipulation": "animate",
                    "video_url": clip.video_url,
                    "video_content_type": clip.content_type,
                    "video_duration_s": clip.duration_seconds,
                    "video_model": clip.model,
                },
                "artifacts": {"poster.jpg": src.jpeg_bytes},
            }

        if cell.arm in _MANIPULATION_ARMS:
            src = await image_provider.generate_image(
                prompt=payload.get("prompt", ""),
                aspect_ratio=aspect,
                tier="balanced",
                model_override="fal-ai/nano-banana-pro",
            )
            _SOURCE_CACHE[cell.label] = src.jpeg_bytes
            src_url = image_provider.encode_data_url(src.jpeg_bytes)
            if cell.arm == "zoom_continue":
                out = await image_edit_provider.edit_image(
                    image_data_url=src_url,
                    instruction="A closer faithful continuation of this exact scene.",
                    tier="balanced",
                    model_override=model,
                )
            elif cell.arm == "enter_scene":
                out = await image_edit_provider.edit_image(
                    image_data_url=src_url,
                    instruction="Step into this place at eye level, ground-level POV.",
                    tier="balanced",
                    model_override=model,
                )
            elif cell.arm == "outpaint":
                out = await image_edit_provider.expand_image(
                    image_data_url=src_url,
                    direction="east",
                    model_override=model,
                )
            elif cell.arm == "inpaint":
                out = await image_edit_provider.edit_image(
                    image_data_url=src_url,
                    instruction="Refine and enrich the center of the scene.",
                    tier="balanced",
                    model_override=model,
                )
            else:
                out = src
            return {
                "jpeg": out.jpeg_bytes,
                "model": model,
                "inputs": {**meta, "manipulation": cell.arm},
                "artifacts": {"source.jpg": src.jpeg_bytes},
            }

        # Default: fresh text-to-image
        img = await image_provider.generate_image(
            prompt=prompt,
            aspect_ratio=aspect,
            tier="balanced",
            model_override=model if "/" in model or model.startswith("openrouter:") else None,
        )
        return {
            "jpeg": img.jpeg_bytes,
            "model": model,
            "inputs": {**meta, "prompt": prompt},
        }

    def gen_fn(cell, payload: dict[str, Any], template: str) -> dict[str, Any]:
        # No retry wrapper: a retried gen would generate (and bill) a second
        # image. A raise here is caught by the chassis → cell recorded failed.
        return loop.run_until_complete(_gen_async(cell, payload, template))

    def judge_layout(cell, payload: dict[str, Any], jpeg: bytes) -> tuple[float, float]:
        from tests.world_bench._score import aggregate_layout_fidelity, judge_layout_fidelity

        expected = payload.get("expected_layout") or []
        if not expected:
            return 0.0, 0.0
        agg = aggregate_layout_fidelity(_await(lambda: judge_layout_fidelity(jpeg, expected)))
        return agg.score, 0.03

    def judge_grounding(cell, payload: dict[str, Any], jpeg: bytes) -> tuple[float, float]:
        from providers import detector, grounding
        from tests.world_bench.grounding_runner import bins_to_box

        expected = payload.get("expected_layout") or []
        if not expected:
            return 0.0, 0.0
        labels = [e["label"] for e in expected]
        detected = _await(lambda: detector.detect(jpeg, labels))
        boxes = [bins_to_box(e) for e in expected]
        return grounding.diff(boxes, detected, iou_thresh=0.1).score, 0.03

    def judge_style(cell, payload: dict[str, Any], jpeg: bytes) -> tuple[float, float]:
        from tests.continuity_bench._score import score_style_pair

        src_bytes = _SOURCE_CACHE.get(cell.label)
        if src_bytes is None:
            # Fail loud: a style judge with no source is a wiring bug, not a
            # silent pass — the chassis records this cell as failed.
            raise RuntimeError(
                f"style_pair: no source image cached for {cell.label} "
                "(edit arm did not run in-process)"
            )
        result = _await(lambda: score_style_pair(src_bytes, jpeg))
        return result.score, 0.03  # 0-10 scale (matches style_medium_lock baseline)

    def judge_view(cell, payload: dict[str, Any], jpeg: bytes) -> tuple[float, float]:
        """Does the render actually use the scenario's intended projection?
        Not-applicable (no POV dim) returns the _NA sentinel so the composite
        renormalises rather than scoring a 0."""
        projection = _projection_for(payload)
        if projection is None:
            return _NA, 0.0
        from providers.judge import score_view_conformance

        result = _await(lambda: score_view_conformance(jpeg, projection))
        return round(result.score / 10.0, 4), 0.03  # → 0-1 to match layout/grounding

    def judge_continuity(cell, payload: dict[str, Any], jpeg: bytes) -> tuple[float, float]:
        """Is the output a faithful continuation of the source? Only applies to
        arms that produced a source (continuation/edit ops); fresh arms have no
        source → _NA (renormalised out of the composite)."""
        src_bytes = _SOURCE_CACHE.get(cell.label)
        if src_bytes is None:
            return _NA, 0.0
        from tests.continuity_bench._score import score_continuation

        result = _await(lambda: score_continuation(src_bytes, jpeg))
        return round(result.score / 10.0, 4), 0.03  # → 0-1

    judge_fns = {
        "layout_fidelity": judge_layout,
        "grounding_diff": judge_grounding,
        "style_pair": judge_style,
        "view_conformance": judge_view,
        "continuity": judge_continuity,
    }

    def score_fn(
        cell,
        payload: dict[str, Any],
        outputs: dict[str, Any],
        judge_scores: dict[str, float],
    ) -> dict[str, float]:
        scores = dict(judge_scores)
        if weights:
            # Renormalise over judges that actually applied (score >= 0); an _NA
            # judge drops out of both numerator and denominator so it neither
            # helps nor hurts.
            applied = {
                k: w for k, w in weights.items() if scores.get(k, _NA) >= 0.0
            }
            total_w = sum(applied.values())
            if total_w > 0:
                scores["composite"] = round(
                    sum(scores[k] * w for k, w in applied.items()) / total_w, 4
                )
        return scores

    return {
        "gen_fn": gen_fn,
        "judge_fns": judge_fns,
        "score_fn": score_fn,
        "prompts_dir": _PROMPTS_DIR,
    }


def _resolve_sweep_path() -> Path:
    env = os.environ.get("MATRIX_SWEEP", "")
    if env:
        p = Path(env)
        return p if p.is_absolute() else Path.cwd() / p
    return _SWEEPS_DIR / "layout.json"


def _uses_scenario_lab(sweep: dict[str, Any]) -> bool:
    return any(r.startswith("scenario:") for r in sweep.get("scenarios", []))


def main() -> int:
    from tests.matrix_bench.runner import _load_env

    _load_env()
    sweep_path = _resolve_sweep_path()
    sweep = load_sweep(sweep_path)
    if os.environ.get("MATRIX_BUDGET_USD"):
        sweep["budget_usd"] = float(os.environ["MATRIX_BUDGET_USD"])

    if not _uses_scenario_lab(sweep):
        from tests.recon_bench.runner import corpus_scenarios, recon_fns

        scenarios = corpus_scenarios(sweep["scenarios"])
        if not scenarios:
            print("scenario_lab: sweep has no scenario:* refs and corpus is empty.")
            return 0
        fns = recon_fns(sweep)
        prompts_dir = MATRIX_PROMPTS_DIR
    else:
        scenarios = lab_scenarios(sweep)
        if not scenarios:
            print(
                "scenario_lab: no verified scenarios match sweep "
                f"(filter={sweep.get('dimension_filter')})."
            )
            return 0
        fns = lab_fns(sweep)
        prompts_dir = fns.pop("prompts_dir")

    live = os.environ.get("MATRIX_BENCH_RUN") == "1"
    report = run_matrix(
        scenarios,
        sweep,
        live=live,
        allow_partial=os.environ.get("MATRIX_ALLOW_PARTIAL") == "1",
        run_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        report_path=_REPORT,
        prompts_dir=prompts_dir,
        **fns,
    )
    if live and report.get("cells"):
        from tests.matrix_bench import report as report_mod

        print(report_mod.format_summary(report_mod.attach_summary(_REPORT)))
    return 0 if report.get("stopped_reason") is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
