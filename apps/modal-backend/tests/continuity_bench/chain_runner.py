"""MULTI-HOP DRIFT — the design's Risk #1 (`PLAN_OUTWARD.md:118,123`), previously
unmeasured. `outward_runner.py` scores ONE hop; the real failure mode is
compounding drift as each OUTWARD container becomes the source for the next
(exposure bias / autoregressive error accumulation).

This walks a styled source OUTWARD k hops along the scale ladder
(`place→district→city→region→world`, `model_router.coarser_tier`), each hop the
REAL ascend op (`select_outward_op` → BRIA outpaint on same-plane hops, a
reference-conditioned fresh gen on a medium flip) conditioned on the PREVIOUS
hop's output AND re-anchored to the ORIGINAL medium each hop — mirroring the
product's ascend (ascend.py:103-126), the style-refresh mitigation itself. After each
hop it scores two things with the existing style judge:
  - from_source: faithfulness of hop_i to the ORIGINAL medium (does the chain
    wander off the starting style?);
  - step:        faithfulness of hop_i to hop_{i-1} (WHERE the wandering happens).
`summarize` turns the sequence into a `half_life` (the hop drift first crosses a
floor) — the product rule falls out: cap auto-OUTWARD at `half_life - 1`.

Paid (fal gens + Gemini judge). Self-contained — no session / web needed:
    cd apps/modal-backend && CHAIN_BENCH_RUN=1 \
      .venv/bin/python -m tests.continuity_bench.chain_runner
or:  make eval-chain-drift   (dry preview, $0: make eval-chain-drift-dry)
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
# Below this style-faithfulness the chain has wandered off the source medium;
# the hop where from_source first drops under it is the half-life.
_FLOOR = float(os.environ.get("CHAIN_BENCH_FLOOR", "6.0"))
_HOPS = int(os.environ.get("CHAIN_BENCH_HOPS", "4"))

# Rough per-op fal prices (docs/COSTS.md) for the $0 dry preview.
_OP_COST = {"outpaint_zoomout": 0.04, "scale_parent_fresh": 0.15}
_SOURCE_COST = 0.15  # nano-banana-pro source gen
_JUDGE_COST = 0.005  # x2 per hop (from_source + step)


@dataclass(frozen=True)
class Case:
    name: str
    # The finest-rung source, generated in this exact medium; every OUTWARD
    # container must keep it.
    source_prompt: str
    style: str
    # The source's rung; the chain walks one step coarser each hop.
    start_tier: str
    # The subject phrase a fresh (medium-flip) hop expands into the wider view.
    subject: str


_CASES: list[Case] = [
    Case(
        name="engraving_cottage",
        source_prompt=(
            "a hand-drawn antique engraving of a lone lighthouse keeper's cottage "
            "on a rocky headland, sepia ink, dense cross-hatching, woodcut linework, "
            "aged paper"
        ),
        style="hand-drawn antique engraving, sepia ink, dense cross-hatching, woodcut linework",
        start_tier="place",
        subject="a lighthouse keeper's cottage on a rocky headland",
    ),
    Case(
        name="watercolor_square",
        source_prompt=(
            "a soft watercolour of a small market square with a stone well, loose "
            "washes, pale pastel palette, visible paper texture"
        ),
        style="soft watercolour, loose washes, pale pastel palette, visible paper texture",
        start_tier="place",
        subject="a small market square with a stone well",
    ),
    Case(
        name="ukiyoe_shrine",
        source_prompt=(
            "a ukiyo-e woodblock print of a small hillside shinto shrine, bold flat "
            "colour areas, dark keyblock outlines, visible woodgrain, muted indigo "
            "and vermilion"
        ),
        style="ukiyo-e woodblock print, bold flat colour, dark keyblock outlines, visible woodgrain",
        start_tier="place",
        subject="a hillside shinto shrine",
    ),
]


def _active_cases() -> list[Case]:
    """CHAIN_BENCH_CASES=N runs the first N chains (0/unset = all) — the spend knob."""
    n = int(os.environ.get("CHAIN_BENCH_CASES", "0"))
    return _CASES[:n] if n > 0 else _CASES


def _fit_frame(jpeg_bytes: bytes, w: int, h: int) -> bytes:
    """Downscale a hop's output back into the base frame. Each OUTWARD zoom-out
    canvas = its INPUT's real pixel size x factor (image_edit.expand_image_zoomout
    reads the input dims), so feeding the growing output straight back compounds
    the canvas past fal's 25MP cap by ~hop 2. Bounding each rung to a fixed page
    keeps the zoom-out compounding in CONTENT, not pixels — and matches what the
    product stores (every node is a fixed-size frame)."""
    from io import BytesIO

    from PIL import Image

    im = Image.open(BytesIO(jpeg_bytes)).convert("RGB")
    im.thumbnail((w, h), Image.LANCZOS)
    out = BytesIO()
    im.save(out, format="JPEG", quality=90)
    return out.getvalue()


def plan_chain(start_tier: str, k: int) -> list[tuple[str, str, str]]:
    """Pure: the (from_tier, to_tier, op) sequence a k-hop OUTWARD walk takes,
    stopping early at the coarsest rung. Drives both the dry preview and the run."""
    from providers import model_router

    hops: list[tuple[str, str, str]] = []
    tier = start_tier
    for _ in range(k):
        to_tier = model_router.coarser_tier(tier)
        if to_tier is None:
            break
        hops.append((tier, to_tier, model_router.select_outward_op(tier, to_tier)))
        tier = to_tier
    return hops


def estimate_cost(cases: list[Case], k: int) -> float:
    """$0 dry-preview estimate: source gen + per-hop op + 2 judges, per case."""
    total = 0.0
    for c in cases:
        total += _SOURCE_COST
        for _from, _to, op in plan_chain(c.start_tier, k):
            total += _OP_COST.get(op, _SOURCE_COST) + 2 * _JUDGE_COST
    return round(total, 4)


@dataclass(frozen=True)
class HopResult:
    to_tier: str
    op: str
    from_source: float  # faithfulness of this hop to the ORIGINAL source medium
    step: float  # faithfulness of this hop to the previous hop
    from_source_rationale: str
    step_rationale: str


@dataclass(frozen=True)
class ChainResult:
    name: str
    hops: list[HopResult]


def summarize(
    from_source: list[float],
    step: list[float],
    *,
    source_baseline: float = 10.0,
    floor: float = _FLOOR,
) -> dict[str, Any]:
    """Pure gate brain over one chain's per-hop faithfulness sequences.

    `from_source[i]` = style faithfulness of hop i+1 to the ORIGINAL source (decays
    as the chain wanders); `step[i]` = faithfulness to the previous hop. The
    half-life is the FIRST hop (1-based) whose from_source drops strictly BELOW
    `floor` — the point drift crosses the band; None if it never does. Pure, so the
    stopping rule is unit-tested without spending (test_chain.py)."""
    k = len(from_source)
    half_life = next((i + 1 for i, s in enumerate(from_source) if s < floor), None)
    final = from_source[-1] if from_source else source_baseline
    total_drift = round(source_baseline - final, 4)
    return {
        "k_hops": k,
        "from_source": [round(s, 4) for s in from_source],
        "step": [round(s, 4) for s in step],
        "half_life": half_life,
        "half_life_reached": half_life is not None,
        "total_drift": total_drift,
        "mean_drift_per_hop": round(total_drift / k, 4) if k else 0.0,
        "mean_step_retention": round(statistics.mean(step), 4) if step else source_baseline,
        "floor": floor,
        # Product rule: cap auto-OUTWARD one hop before drift crosses the floor.
        "safe_hops": (half_life - 1) if half_life is not None else k,
    }


async def _run_chain(case: Case, k: int, aspect: str, model: str) -> ChainResult:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm, model_router

    w, h = (900, 1600) if aspect == "9:16" else (1600, 900)

    # 1. The finest-rung styled source — the thing every hop must stay faithful to.
    src = await image_provider.generate_image(
        prompt=case.source_prompt, aspect_ratio=aspect, tier="balanced", model_override=model
    )
    src_bytes = _fit_frame(src.jpeg_bytes, w, h)  # the fixed-frame source of truth
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / f"chain_{case.name}_00_source.jpg").write_bytes(src_bytes)

    prev_bytes = src_bytes
    prev_url = image_provider.encode_data_url(src_bytes)
    from_tier = case.start_tier
    hops: list[HopResult] = []

    for idx in range(k):
        to_tier = model_router.coarser_tier(from_tier)
        if to_tier is None:
            break  # reached the coarsest rung
        op = model_router.select_outward_op(from_tier, to_tier)

        # 2. The REAL ascend op, conditioned on the PREVIOUS hop (compounding) and
        #    re-anchored to the ORIGINAL medium each hop — mirroring the product
        #    (ascend.py:103-126): the outpaint margin carries the source style, the
        #    fresh path passes style_anchor. This is the style-refresh the product
        #    already ships; the bench measures THAT path, not an un-anchored one.
        if op == "outpaint_zoomout":
            margin = (
                f"{case.style}; extend OUTWARD into the surrounding "
                f"{to_tier.replace('_', ' ')}, drawn in the SAME style as the "
                "centre — one continuous view, NOT a photograph, no photorealism"
            )
            raw = await image_edit_provider.expand_image_zoomout(
                prev_url, 3.0, w, h, prompt=margin
            )
        else:  # scale_parent_fresh — a medium flip can't be outpainted
            plan = await llm.plan_page(
                query=f"{case.subject} (the {to_tier} that contains it)",
                web_search=False,
                style_anchor=case.style,
                render_mode="scale_parent",
            )
            raw = await image_provider.generate_image(
                plan.prompt, aspect, tier="balanced", reference_urls=[prev_url], model_override=model
            )
        hop_bytes = _fit_frame(raw.jpeg_bytes, w, h)  # bound before it feeds the next hop

        # 3. Two judgements: faithfulness to the ORIGINAL, and to the last hop.
        fs = await score_style_pair(src_bytes, hop_bytes)
        st = await score_style_pair(prev_bytes, hop_bytes)
        (_REPORTS / f"chain_{case.name}_{idx + 1:02d}_{to_tier}.jpg").write_bytes(hop_bytes)
        hops.append(
            HopResult(
                to_tier=to_tier,
                op=op,
                from_source=fs.score,
                step=st.score,
                from_source_rationale=fs.rationale,
                step_rationale=st.rationale,
            )
        )
        prev_bytes = hop_bytes
        prev_url = image_provider.encode_data_url(hop_bytes)
        from_tier = to_tier

    return ChainResult(name=case.name, hops=hops)


async def run_bench(k: int, model: str) -> dict[str, Any]:
    results = [await _run_chain(c, k, "16:9", model) for c in _active_cases()]
    per_case = []
    for r in results:
        summary = summarize(
            [h.from_source for h in r.hops], [h.step for h in r.hops]
        )
        per_case.append({"name": r.name, "hops": [asdict(h) for h in r.hops], "summary": summary})

    half_lives = [c["summary"]["half_life"] for c in per_case if c["summary"]["half_life"]]
    return {
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "image_model": model,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "k_hops": k,
        "floor": _FLOOR,
        "cases": per_case,
        "bench": {
            # The conservative product cap = the WORST chain's half-life.
            "min_half_life": min(half_lives) if half_lives else None,
            "mean_total_drift": round(
                statistics.mean(c["summary"]["total_drift"] for c in per_case), 4
            )
            if per_case
            else 0.0,
            "safe_auto_hops": (min(half_lives) - 1) if half_lives else k,
        },
    }


def _load_env() -> None:
    """Load apps/modal-backend/.env, force nano-banana-pro for balanced (the .env
    pins plain nano-banana — memory project_fal_model_pin) and pin the judge + text
    model to Gemini (the .env's qwen rate-limits)."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))
    os.environ.setdefault("CONTINUITY_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")
    os.environ.setdefault("FAL_IMAGE_MODEL_BALANCED", "fal-ai/nano-banana-pro")


def _print_dry_preview(model: str) -> None:
    print(f"MULTI-HOP DRIFT — dry preview (k={_HOPS} hops, floor={_FLOOR}, model={model})")
    cases = _active_cases()
    for c in cases:
        chain = plan_chain(c.start_tier, _HOPS)
        path = c.start_tier + "".join(f" → {to}" for _f, to, _op in chain)
        ops = ", ".join(op for _f, _t, op in chain)
        print(f"  {c.name}: {path}   [{ops}]")
    print(f"total to-bill (est): ${estimate_cost(cases, _HOPS)} over {len(cases)} chains")
    print("set CHAIN_BENCH_RUN=1 to spend.")


def _cli() -> None:
    model = os.environ.get("CHAIN_BENCH_MODEL", "fal-ai/nano-banana-pro")
    if not os.environ.get("CHAIN_BENCH_RUN"):
        _print_dry_preview(model)  # $0 preview is the default
        return
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    report = asyncio.run(run_bench(_HOPS, model))
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "chain_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    b = report["bench"]
    print(
        f"\nMIN half-life = {b['min_half_life']} hops (worst chain); "
        f"mean total drift = {b['mean_total_drift']}. Product rule: cap auto-OUTWARD "
        f"at {b['safe_auto_hops']} hops (force a style-anchor refresh / checkpoint there)."
    )


if __name__ == "__main__":
    _cli()
