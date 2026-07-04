"""Reconstruction bench — description → regenerated map → compare.

Two arms per corpus scenario:
  graph  — the PRODUCT path: prose → plan_world_from_description →
           layout_solver → layout clause → render. Measures the whole
           describe-a-place pipeline.
  direct — ground-truth entities → layout clause → render. Isolates the
           image model from the planner (a low graph score with a high
           direct score blames the planning, not the paint).

Per cell: render → detect + segment + anchored heights → geometric scores
(presence / pos_raw / pos_aligned / size / height order + abs) → VLM judges
(style vs the reference scan, plausibility, prompt alignment) → composite
via the sweep's weights. Everything rides the matrix chassis: disk cache,
hard budget cap, dry-run by default.

Run:  make eval-recon          (RECON_BENCH_RUN=1, sweeps/recon.json)
Dry:  .venv/bin/python -m tests.recon_bench.runner   (cost preview, $0)
Needs `make corpus-fetch` first (the style judge compares against the
reference scans).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from providers.geometry import ProjectedEntity, ProjectInput

from tests.map_corpus import (
    description_sha,
    image_path,
    load_descriptions,
    load_manifest,
)
from tests.matrix_bench._budget import JUDGE_CALL_FLAT
from tests.matrix_bench._record import Cell, load_sweep, render_prompt
from tests.matrix_bench.runner import EXTRACT_FLAT, Scenario, run_matrix
from tests.recon_bench._align import FRAME_H, FRAME_W, geo_scores

_SWEEPS_DIR = Path(__file__).resolve().parents[1] / "matrix_bench" / "sweeps"
_REPORTS_DIR = Path(__file__).resolve().parent / "reports"


def _sweep_name() -> str:
    """Which sweep to run: RECON_SWEEP (default "recon" = maps; "recon_closeup"
    = the closeup tier). Picks the sweep file, the report, and the baseline key."""
    return os.environ.get("RECON_SWEEP", "recon")


def _sweep_path() -> Path:
    return _SWEEPS_DIR / f"{_sweep_name()}.json"


def _report_path() -> Path:
    return _REPORTS_DIR / f"{_sweep_name()}_latest.json"


def corpus_scenarios(specs: list[str]) -> list[Scenario]:
    """Resolve sweep scenario specs: "corpus:*" → every VERIFIED corpus
    description; "corpus:tier=<map|interior|closeup>" → the verified ones of that
    tier; "corpus:<map_id>" → that one (must be verified)."""
    verified = {d["map_id"]: d for d in load_descriptions(status="verified")}
    wanted: list[dict[str, Any]] = []
    for spec in specs:
        if spec == "corpus:*":
            wanted.extend(verified.values())
        elif spec.startswith("corpus:tier="):
            tier = spec.split("=", 1)[1]
            tier_ids = {m["id"] for m in load_manifest(tier=tier)}
            wanted.extend(d for d in verified.values() if d["map_id"] in tier_ids)
        elif spec.startswith("corpus:"):
            map_id = spec.split(":", 1)[1]
            if map_id not in verified:
                raise SystemExit(
                    f"scenario {spec!r} is not a VERIFIED corpus description — "
                    "review the draft and flip review.status first"
                )
            wanted.append(verified[map_id])
    seen: set[str] = set()
    out = []
    for d in wanted:
        if d["map_id"] in seen:
            continue
        seen.add(d["map_id"])
        out.append(Scenario(id=d["map_id"], desc_sha=description_sha(d), payload=d))
    return out


def _norm(label: str) -> str:
    return " ".join(label.lower().split())


def _expected_layout(
    desc: dict[str, Any],
) -> tuple[list[ProjectedEntity], list[tuple[str, float, str]] | None]:
    """Ground-truth entities → ProjectedEntity bins (for the layout clause)
    + relative-height tuples (label, ratio, anchor) for its HEIGHTS block."""
    from providers.geometry import project_top_down

    ents = [
        {
            "id": e["ref"],
            "label": e["label"],
            "pos": e["pos"],
            "footprint": e["footprint"],
            "height": e.get("height_m") or 4.0,
        }
        for e in desc["entities"]
    ]
    expected = project_top_down(cast("list[ProjectInput]", ents), FRAME_W, FRAME_H)
    real: list[tuple[str, float]] = sorted(
        ((str(e["label"]), float(e["height_m"])) for e in desc["entities"] if e.get("height_m")),
        key=lambda t: t[1],
    )
    heights = None
    if len(real) >= 2:
        anchor_label, anchor_h = real[0]
        heights = [(label, h / anchor_h, anchor_label) for label, h in real[1:]]
    return expected, heights


def _graph_layout(
    desc: dict[str, Any], loop: asyncio.AbstractEventLoop
) -> list[ProjectedEntity]:
    """The product path: prose → scene graph → solved geos → bins."""
    from providers.geometry import project_top_down
    from providers.layout_solver import solve_layout
    from providers.llm import plan_world_from_description

    graph = loop.run_until_complete(plan_world_from_description(desc["description"]))
    solved = solve_layout(graph)
    ents = [
        {
            "id": str(g.get("id") or g.get("label") or i),
            "label": str(g.get("label") or ""),
            "pos": g["pos"],
            "footprint": g["footprint"],
            "height": g.get("height") or 4.0,
        }
        for i, g in enumerate(solved.geos)
    ]
    return project_top_down(cast("list[ProjectInput]", ents), FRAME_W, FRAME_H)


def recon_fns(sweep: dict[str, Any]) -> dict[str, Any]:
    """The chassis plug: gen/extract/judge/score functions. One persistent
    event loop for every async provider call (a per-call asyncio.run would
    orphan the cached HTTP clients)."""
    from providers import heights as heights_lib
    from providers import judge
    from providers.detector import detect
    from providers.image import generate_image
    from providers.prompt_library.layout import layout_constraints
    from providers.segmenter import segment

    loop = asyncio.new_event_loop()
    weights: dict[str, float] = dict(sweep.get("composite_weights", {}))

    def _await(make_coro: Any) -> Any:
        """Run an async provider call with ONE retry — OpenRouter
        occasionally times a single request out, and a bench cell costs
        real money to redo. `make_coro` is a factory (a coroutine can't be
        awaited twice)."""
        try:
            return loop.run_until_complete(make_coro())
        except Exception:
            time.sleep(5)
            return loop.run_until_complete(make_coro())

    def gen_fn(cell: Cell, desc: dict[str, Any], template: str) -> dict[str, Any]:
        expected, heights = _expected_layout(desc)
        if cell.arm == "graph":
            layout = _graph_layout(desc, loop)
            clause = layout_constraints(layout, heights=heights)
        elif cell.arm == "direct":
            clause = layout_constraints(expected, heights=heights)
        else:
            raise ValueError(f"unknown recon arm: {cell.arm!r}")
        prompt = render_prompt(
            template,
            style=desc["style"],
            description=desc["description"],
            layout_clause=clause,
        )
        img = loop.run_until_complete(
            generate_image(
                prompt=prompt,
                aspect_ratio=str(cell.params.get("aspect_ratio", "16:9")),
                model_override=cell.model,
            )
        )
        return {
            "jpeg": img.jpeg_bytes,
            "model": img.model,
            "inputs": {"prompt_text": prompt, "layout_clause": clause, "arm": cell.arm},
        }

    def extract_fn(
        cell: Cell, desc: dict[str, Any], jpeg: bytes
    ) -> tuple[dict[str, Any], float]:
        labels = [e["label"] for e in desc["entities"]]
        detections = _await(lambda: detect(jpeg, labels))
        segments = _await(lambda: segment(jpeg, labels, boxes=detections))
        inferred = heights_lib.infer_heights_m(list(segments))
        return (
            {
                "detections": detections,
                "segments": segments,
                "heights_m": inferred,
            },
            EXTRACT_FLAT,
        )

    def _style_judge(cell: Cell, desc: dict[str, Any], jpeg: bytes) -> tuple[float, float]:
        ref = image_path(desc["map_id"])
        if not ref.exists():
            raise SystemExit(
                f"{ref} missing — run `make corpus-fetch` before the recon bench "
                "(the style judge compares against the reference scan)"
            )
        r = _await(lambda: judge.score_style_pair(ref.read_bytes(), jpeg))
        return r.score, JUDGE_CALL_FLAT

    def _plausibility_judge(
        cell: Cell, desc: dict[str, Any], jpeg: bytes
    ) -> tuple[float, float]:
        r = _await(
            lambda: judge.score_map_plausibility(jpeg, desc["genre"], desc["description"])
        )
        return r.score, JUDGE_CALL_FLAT

    def _alignment_judge(
        cell: Cell, desc: dict[str, Any], jpeg: bytes
    ) -> tuple[float, float]:
        r = _await(
            lambda: judge.score_prompt_alignment(desc["description"], jpeg)
        )
        return r.score, JUDGE_CALL_FLAT

    def _articulation_judge(
        cell: Cell, desc: dict[str, Any], jpeg: bytes
    ) -> tuple[float, float]:
        # The closeup/interior-tier analogue of map_plausibility: does the render
        # ARTICULATE the object's named parts, rather than read as a coherent map?
        # features = the description's catalogued part labels.
        labels = [str(e["label"]) for e in desc["entities"]]
        r = _await(
            lambda: judge.score_feature_articulation(jpeg, desc.get("genre", "object"), labels)
        )
        return r.score, JUDGE_CALL_FLAT

    def score_fn(
        cell: Cell,
        desc: dict[str, Any],
        outputs: dict[str, Any],
        judge_scores: dict[str, float],
    ) -> dict[str, float]:
        expected = {
            _norm(e["label"]): {
                "pos": (e["pos"]["x"], e["pos"]["y"]),
                "diag": (e["footprint"]["w"] ** 2 + e["footprint"]["d"] ** 2) ** 0.5,
            }
            for e in desc["entities"]
        }
        observed = {
            _norm(d["label"]): {
                "pos": (d["x_pct"] * FRAME_W, d["y_pct"] * FRAME_H),
                "diag": (
                    (d["w_pct"] * FRAME_W) ** 2 + (d["h_pct"] * FRAME_H) ** 2
                ) ** 0.5,
            }
            for d in outputs.get("detections", [])
        }
        geo = geo_scores(expected, observed)
        expected_h = {
            _norm(e["label"]): float(e["height_m"])
            for e in desc["entities"]
            if e.get("height_m")
        }
        observed_h = {
            _norm(k): v for k, v in (outputs.get("heights_m") or {}).items()
        }
        scores: dict[str, float] = {
            "presence": round(geo["presence"], 3),
            "pos_raw": round(geo["pos_raw"], 3),
            "pos_aligned": round(geo["pos_aligned"], 3),
            "size": round(geo["size"], 3),
            # judges arrive 0-10; composite consumes 0-1
            **{k: round(v / 10.0, 3) for k, v in judge_scores.items()},
        }
        # Height metrics only when the corpus map HAS heights — an
        # astronomical map (mars) carries no built heights, and scoring it
        # 0.0 on a metric it can't have dragged the sweep mean below the
        # baseline in BOTH arms. Absent key = excluded from the composite
        # (weights∩scores) and from the baseline mean, like an absent judge.
        if expected_h:
            scores["height_order"] = round(
                heights_lib.height_order_score(expected_h, observed_h), 3
            )
            scores["height_abs"] = round(
                heights_lib.height_abs_score(expected_h, observed_h), 3
            )
        # Register instrumentation (UI_AUDIT #11's bench half): persist the
        # fitted similarity per cell so every report shows the drift SHAPE
        # (scale hitting the 0.5 clamp + translation is the signature) instead
        # of one opaque pos_raw number. Flat floats, zero composite weight.
        align = geo.get("alignment")  # geo_scores serializes it as a dict
        if align is not None:
            scores["align_scale"] = float(align["scale"])
            scores["align_tx"] = round(float(align["tx"]), 1)
            scores["align_ty"] = round(float(align["ty"]), 1)
            scores["align_flip"] = 1.0 if align["flip_x"] else 0.0
        scores["unalignable"] = 1.0 if geo.get("unalignable") else 0.0
        used = {k: w for k, w in weights.items() if k in scores and w > 0}
        if used:
            total = sum(used.values())
            scores["composite"] = round(
                sum(scores[k] * w for k, w in used.items()) / total, 3
            )
        return scores

    return {
        "gen_fn": gen_fn,
        "extract_fn": extract_fn,
        "judge_fns": {
            "style_pair": _style_judge,
            "map_plausibility": _plausibility_judge,
            "prompt_alignment": _alignment_judge,
            "feature_articulation": _articulation_judge,
        },
        "score_fn": score_fn,
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
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


def main() -> int:
    _load_env()
    report_path = _report_path()
    sweep = load_sweep(_sweep_path())
    if os.environ.get("MATRIX_BUDGET_USD"):
        sweep["budget_usd"] = float(os.environ["MATRIX_BUDGET_USD"])
    scenarios = corpus_scenarios(sweep["scenarios"])
    if not scenarios:
        print(f"recon[{_sweep_name()}]: no VERIFIED corpus descriptions of that tier.")
        return 1
    live = os.environ.get("RECON_BENCH_RUN") == "1"
    report = run_matrix(
        scenarios,
        sweep,
        live=live,
        allow_partial=os.environ.get("MATRIX_ALLOW_PARTIAL") == "1",
        run_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        report_path=report_path,
        **recon_fns(sweep),
    )
    if live:
        cells = [c for c in report["cells"] if "scores" in c]
        composites = [
            c["scores"]["composite"] for c in cells if "composite" in c.get("scores", {})
        ]
        if composites:
            mean = sum(composites) / len(composites)
            print(f"recon composite mean: {mean:.3f} over {len(composites)} cells")
            try:
                from tests._baseline import compare

                # fidelity baseline is per-sweep ("recon_fidelity" for maps,
                # "recon_closeup_fidelity" for closeups); height_order only the
                # map sweep (objects carry no built-height ladder).
                baselines = [(f"{_sweep_name()}_fidelity", "composite")]
                if _sweep_name() == "recon":
                    baselines.append(("height_order", "height_order"))
                    # The register-drift headline (AUDIT_BOX §4) gets its own
                    # gate — pos_raw's 0.05 composite weight made a 10x drift
                    # nearly invisible in the fidelity number.
                    baselines.append(("recon_pos_raw", "pos_raw"))
                for name, key in baselines:
                    vals = [c["scores"][key] for c in cells if key in c.get("scores", {})]
                    if vals:
                        v = compare(name, sum(vals) / len(vals), len(vals))
                        print(f"  {v.status}: {v.detail}")
            except KeyError:
                print("  (no committed baseline yet — commit one from this run)")
    if live:
        from tests.matrix_bench import report as report_mod

        print(report_mod.format_summary(report_mod.attach_summary(report_path)))
    json.dumps(report)  # smoke: the report is JSON-serializable
    return 0 if report.get("stopped_reason") is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
