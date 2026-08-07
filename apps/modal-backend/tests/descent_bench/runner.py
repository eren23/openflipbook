"""Descent reconstruction bench — the M4 payoff.

For each golden chain (a child interior/closeup linked via parent_id+parent_ref to
a place ENTITY in a parent map), crop the parent map at that place and generate an
"enter" view two ways:
  with   — region-conditioned via the seam the PRODUCT ships: the region crop is
           the edit SOURCE (view "interior" -> build_enter_instruction+edit_image
           on the enter_scene model; view "exterior" -> build_zoom_instruction+
           continue_image, the closeup rung). NOT generate_image — fal's
           text-to-image accepts-but-IGNORES reference_urls (research/01), which
           made this arm an unconditioned reinvention and place_lift
           structurally ~0 until 2026-07-29.
  without— a plain fresh generation (baseline)
then JUDGE both against the REAL child photo and the cropped region (continuity).
The headline metric is place_lift = how much region-conditioning moves the
descent TOWARD the real PLACE, scored medium-AGNOSTICALLY (score_place_match) so
an illustration->photo chain isn't penalised for the medium gap it can't close.
style_lift (score_style_pair, medium-sensitive) is kept as a secondary signal.
Reuses the continuity bench's region crop + enter generation.

Dry by default (resolve chains + cost preview, $0):
    .venv/bin/python -m tests.descent_bench.runner
Live (DESCENT_BENCH_RUN=1, ~$0.31/chain — 2 image gens + 5 judges):
    make eval-descent
Needs `make corpus-fetch` (parent + child images) and VERIFIED parent descriptions.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Awaitable, Callable
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


# The label the model can't cheat off. A famous real name (e.g. "Grand Canyon of
# the Yellowstone") lets the BASELINE render the place from text alone, so both
# arms ceiling and place_lift reads 0 — even when region-conditioning is doing
# real work. Blinding the name in BOTH arms isolates the crop's contribution:
# the fantasy/generated-map regime the product actually serves (a made-up place
# the model can only render from its DRAWN form). The judge never sees the label
# — it compares images — so this changes only what the arms are TOLD, not scoring.
_BLIND_PROMPT_LABEL = "the place marked at this spot on the map"


def _blind_label() -> bool:
    return os.environ.get("DESCENT_BENCH_BLIND_LABEL", "").lower() in ("1", "true", "yes")


def _prompt_label(label: str) -> str:
    return _BLIND_PROMPT_LABEL if _blind_label() else label


def resolve_chains() -> list[dict[str, Any]]:
    descs = {d["map_id"]: d for d in load_descriptions(status="verified")}
    return descent_chains(load_manifest(), descs)


async def _judge_with_retry(label: str, call: Callable[[], Awaitable[Any]]) -> Any:
    attempts = max(1, int(os.environ.get("DESCENT_BENCH_JUDGE_RETRIES", "3")))
    for attempt in range(1, attempts + 1):
        try:
            return await call()
        except Exception:
            if attempt == attempts:
                raise
            print(f"judge {label} failed; retrying ({attempt}/{attempts})")
            await asyncio.sleep(min(8.0, 2.0 ** (attempt - 1)))


async def _score_chain(chain: dict[str, Any], aspect: str) -> dict[str, Any]:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import judge, model_router
    from tests.continuity_bench.coherence_runner import _enter, _region_crop
    from tests.map_corpus import ROOT

    parent_bytes = image_path(chain["parent_id"]).read_bytes()
    child_bytes = image_path(chain["child_id"]).read_bytes()
    region = _region_crop(parent_bytes, chain["anchor"])
    region_url = image_provider.encode_data_url(region)
    label = chain["label"]
    # Default "interior" enters the place; a chain can set view="exterior" for a
    # closer OUTSIDE view — the shape that measures place_lift when the parent
    # already draws a distinctive exterior (tests/map_corpus/chains.py docs).
    view = chain.get("view", "interior")
    plabel = _prompt_label(label)
    base = f"A closer, {view} view of {plabel}, a place within the parent map."

    # save artifacts for visual inspection (overlays/ is gitignored). A live
    # judge can die after image spend; opt-in reuse lets the rerun finish judges
    # without paying to regenerate the same artifacts.
    art = ROOT / "overlays"
    art.mkdir(parents=True, exist_ok=True)
    # Blind vs named runs generate DIFFERENT with/without images (the prompt
    # label differs), so tag the reusable artifacts by blind state — else a
    # `BLIND_LABEL=1 REUSE_ARTIFACTS=1` run silently judges the prior named
    # images while the report claims blind_label:true. Region is pure geometry.
    blind_tag = "-blind" if _blind_label() else ""
    region_path = art / f"descent-{chain['child_id']}-region.jpg"
    with_path = art / f"descent-{chain['child_id']}-with{blind_tag}.jpg"
    without_path = art / f"descent-{chain['child_id']}-without{blind_tag}.jpg"
    region_path.write_bytes(region)

    if (
        os.environ.get("DESCENT_BENCH_REUSE_ARTIFACTS") == "1"
        and with_path.exists()
        and without_path.exists()
    ):
        print(f"  reusing descent artifacts for {chain['child_id']}")
        with_img = with_path.read_bytes()
        without_img = without_path.read_bytes()
    else:
        # with — the product seam per chain shape, region crop as the edit SOURCE
        # so the reference pixels actually bite (generate_image ignores refs).
        if view == "interior":
            instruction = image_edit_provider.build_enter_instruction(
                plabel,
                [],
                subject_context=f"{plabel}, a place within the parent map",
                interior=True,
            )
            with_gen = await image_edit_provider.edit_image(
                region_url,
                instruction,
                model_override=model_router.resolve_model("enter_scene"),
            )
        else:
            # exterior closeup = the product's zoom_continue rung (Kontext).
            instruction = image_edit_provider.build_zoom_instruction(
                plabel, [], register="view", faithful=True
            )
            with_gen = await image_edit_provider.continue_image(
                region_url,
                instruction,
                model_override=model_router.resolve_model("zoom_continue"),
            )
        with_img = with_gen.jpeg_bytes
        without_img = await _enter(base, aspect, _model(), None)
        with_path.write_bytes(with_img)
        without_path.write_bytes(without_img)

    real_with = await _judge_with_retry(
        "style_with", lambda: judge.score_style_pair(child_bytes, with_img)
    )
    real_without = await _judge_with_retry(
        "style_without", lambda: judge.score_style_pair(child_bytes, without_img)
    )
    # medium-AGNOSTIC place judge: style_pair sinks a CORRECT illustrated descent
    # of a photographed place to ~0 purely on the medium gap. place_match scores
    # same-place-ignoring-medium, so place_lift measures what the descent is
    # actually for — carrying the real place over — across illustration->photo.
    place_with = await _judge_with_retry(
        "place_with", lambda: judge.score_place_match(child_bytes, with_img)
    )
    place_without = await _judge_with_retry(
        "place_without", lambda: judge.score_place_match(child_bytes, without_img)
    )
    continuity = await _judge_with_retry(
        "continuity", lambda: judge.score_continuation(region, with_img)
    )
    return {
        "child_id": chain["child_id"],
        "parent_id": chain["parent_id"],
        "place": label,
        "real_style_with": round(real_with.score, 2),
        "real_style_without": round(real_without.score, 2),
        "style_lift": round(real_with.score - real_without.score, 2),
        "place_match_with": round(place_with.score, 2),
        "place_match_without": round(place_without.score, 2),
        "place_lift": round(place_with.score - place_without.score, 2),
        "continuity_with": round(continuity.score, 2),
        "rationale": place_with.rationale,
    }


def _aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Roll rows up into the report. The HEADLINE is mean_place_lift (medium-
    agnostic); mean_style_lift is kept as a secondary medium-transfer signal so
    the committed baseline stays comparable."""
    def _mean(key: str) -> float:
        vals = [r[key] for r in rows]
        return round(sum(vals) / len(vals), 3) if vals else 0.0

    return {
        "run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "blind_label": _blind_label(),
        "chains": rows,
        "mean_place_lift": _mean("place_lift"),
        "mean_style_lift": _mean("style_lift"),
    }


async def _run(chains: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [await _score_chain(c, "16:9") for c in chains]
    return _aggregate(rows)


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
        cost = len(chains) * (2 * _GEN_USD + 5 * _JUDGE_USD)
        print(f"\nDRY RUN — would spend ~${cost:.2f} ({len(chains)} chain(s) x 2 gens + 5 judges).")
        print("Set DESCENT_BENCH_RUN=1 to execute.")
        return 0
    report = asyncio.run(_run(chains))
    _REPORT.parent.mkdir(parents=True, exist_ok=True)
    _REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"\nmean place_lift: {report['mean_place_lift']:+.3f}  "
        f"(style_lift: {report['mean_style_lift']:+.3f}) over "
        f"{len(report['chains'])} chain(s)"
    )
    for r in report["chains"]:
        print(
            f"  {r['place']:<16} place with={r['place_match_with']} "
            f"without={r['place_match_without']} (lift {r['place_lift']:+}) | "
            f"style-lift {r['style_lift']:+} continuity={r['continuity_with']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
