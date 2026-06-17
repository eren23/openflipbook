"""Descent reconstruction bench — the M4 payoff.

For each golden chain (a child interior/closeup linked via parent_id+parent_ref to
a place ENTITY in a parent map), crop the parent map at that place and generate an
"enter" view two ways:
  with   — region-conditioned on the cropped parent place (the product descent)
  without— a plain fresh generation (baseline)
then JUDGE both against the REAL child photo (style match) and the cropped region
(continuity). The headline metric is style_lift = how much region-conditioning
moves the descent TOWARD the real place. Reuses the continuity bench's region
crop + enter generation.

Dry by default (resolve chains + cost preview, $0):
    .venv/bin/python -m tests.descent_bench.runner
Live (DESCENT_BENCH_RUN=1, ~$0.30/chain — 2 image gens + 3 judges):
    make eval-descent
Needs `make corpus-fetch` (parent + child images) and VERIFIED parent descriptions.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from tests.map_corpus import image_path, load_descriptions, load_manifest
from tests.map_corpus.chains import descent_chains

_REPORT = Path(__file__).resolve().parent / "reports" / "descent_latest.json"
_GEN_USD = 0.15  # one balanced image
_JUDGE_USD = 0.001


def _load_env() -> None:
    env = Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("CONTINUITY_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


def _model() -> str:
    # force the balanced model (the .env may pin plain nano-banana — memory
    # project_fal_model_pin — which garbles; nano-banana-pro is the real balanced)
    return os.environ.get("FAL_IMAGE_MODEL_BALANCED", "fal-ai/nano-banana-pro")


def resolve_chains() -> list[dict[str, Any]]:
    descs = {d["map_id"]: d for d in load_descriptions(status="verified")}
    return descent_chains(load_manifest(), descs)


async def _score_chain(chain: dict[str, Any], aspect: str) -> dict[str, Any]:
    from providers import image as image_provider
    from providers import judge
    from tests.continuity_bench.coherence_runner import _enter, _region_crop

    parent_bytes = image_path(chain["parent_id"]).read_bytes()
    child_bytes = image_path(chain["child_id"]).read_bytes()
    region = _region_crop(parent_bytes, chain["anchor"])
    region_url = image_provider.encode_data_url(region)
    label = chain["label"]
    base = f"A closer, interior view of {label}, a place within the parent map."
    preamble = image_provider.conditioning_preamble(["region"], "place_scene")
    model = _model()

    with_img = await _enter(f"{preamble}\n\n{base}", aspect, model, region_url)
    without_img = await _enter(base, aspect, model, None)
    # save artifacts for visual inspection (overlays/ is gitignored)
    from tests.map_corpus import ROOT

    art = ROOT / "overlays"
    art.mkdir(parents=True, exist_ok=True)
    (art / f"descent-{chain['child_id']}-region.jpg").write_bytes(region)
    (art / f"descent-{chain['child_id']}-with.jpg").write_bytes(with_img)
    (art / f"descent-{chain['child_id']}-without.jpg").write_bytes(without_img)
    real_with = await judge.score_style_pair(child_bytes, with_img)
    real_without = await judge.score_style_pair(child_bytes, without_img)
    continuity = await judge.score_continuation(region, with_img)
    return {
        "child_id": chain["child_id"],
        "parent_id": chain["parent_id"],
        "place": label,
        "real_style_with": round(real_with.score, 2),
        "real_style_without": round(real_without.score, 2),
        "style_lift": round(real_with.score - real_without.score, 2),
        "continuity_with": round(continuity.score, 2),
        "rationale": real_with.rationale,
    }


async def _run(chains: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [await _score_chain(c, "16:9") for c in chains]
    lifts = [r["style_lift"] for r in rows]
    return {
        "run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "chains": rows,
        "mean_style_lift": round(sum(lifts) / len(lifts), 3) if lifts else 0.0,
    }


def main() -> int:
    _load_env()
    chains = resolve_chains()
    print(f"descent: {len(chains)} golden chain(s) resolved")
    for c in chains:
        print(f"  {c['parent_id']} :: {c['label']!r} -> {c['child_id']}")
    if not chains:
        print("  (none — link a child manifest row with parent_id + parent_ref to a "
              "verified parent map entity)")
        return 0
    if os.environ.get("DESCENT_BENCH_RUN") != "1":
        cost = len(chains) * (2 * _GEN_USD + 3 * _JUDGE_USD)
        print(f"\nDRY RUN — would spend ~${cost:.2f} ({len(chains)} chain(s) x 2 gens + 3 judges).")
        print("Set DESCENT_BENCH_RUN=1 to execute.")
        return 0
    report = asyncio.run(_run(chains))
    _REPORT.parent.mkdir(parents=True, exist_ok=True)
    _REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"\nmean style_lift: {report['mean_style_lift']:+.3f} over {len(report['chains'])} chain(s)")
    for r in report["chains"]:
        print(
            f"  {r['place']:<16} real-style with={r['real_style_with']} "
            f"without={r['real_style_without']} (lift {r['style_lift']:+}) "
            f"continuity={r['continuity_with']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
