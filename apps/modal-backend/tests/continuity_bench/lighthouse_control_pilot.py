"""Eight bounded structural/camera trials. Shared $4 ledger, offline by default."""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import time
from decimal import Decimal
from pathlib import Path

from PIL import Image

from tests.continuity_bench.arrival_audit import BACKEND, ROOT, sha
from tests.continuity_bench.arrival_destination_pilot import prepare as reference_input
from tests.continuity_bench.arrival_live import ACTIVE, LLM, MODEL, Meter, scrub
from tests.video_transition_bench.runner import Ledger, atomic_json, billing_report, generate_cell

OUT = BACKEND / "tests/continuity_bench/reports/lighthouse-control-pilot"
GUIDES = OUT.parent / "lighthouse-guides"
QWEN = "fal-ai/qwen-image-edit-2511-multiple-angles"
CAP = Decimal("4.00")
VARIANTS = ("guide_color", "guide_clay", "qwen_eye", "qwen_low")
ARCH_AXES = ("crown", "tower_body", "annex", "single_scene")


def prepare() -> dict:
    ref = reference_input()
    capture = json.loads((GUIDES / "capture.json").read_text())
    for file, digest in capture["frames"].items():
        if sha((GUIDES / file).read_bytes()) != digest:
            raise ValueError("Guide pixels changed")
    for file, digest in capture["sources"].items():
        if sha((ROOT / "apps/web/app/dev/spatial-transitions/lighthouse" / file).read_bytes()) != digest:
            raise ValueError("Guide implementation changed after capture")
    return {"status": "awaiting_approval", "approved_cap_usd": "0.00", "quoted_cap_usd": str(CAP),
            "reference": ref, "guide_capture": capture, "image_limit": 8, "judge_call_limit": 48,
            "no_video": True, "automatic_publication": False,
            "trials": [{"id": f"{v}-{seed}", "variant": v, "seed": seed, "state": "not_submitted"}
                       for v in VARIANTS for seed in (521, 522)],
            "implementation": {p: sha((ROOT / p).read_bytes()) for p in (
                "apps/modal-backend/tests/continuity_bench/lighthouse_control_pilot.py",
                "apps/modal-backend/tests/continuity_bench/arrival_live.py",
                "apps/modal-backend/providers/place_identity.py", "apps/modal-backend/providers/judge.py",
                "apps/modal-backend/providers/arrival_reference.py", "apps/modal-backend/providers/arrival.py",
            )}}


def arguments(variant: str, seed: int, crop: str, guide: str | None) -> tuple[str, dict, Decimal]:
    from providers.arrival import EXTERIOR
    if variant not in VARIANTS or seed not in (521, 522):
        raise ValueError("Outside frozen trial matrix")
    if variant.startswith("guide_"):
        if not guide:
            raise ValueError("A rendered camera guide is required")
        return MODEL, {
            "image_urls": [guide, crop], "seed": seed, "num_images": 1,
            "resolution": "1K", "aspect_ratio": "16:9", "output_format": "png",
            "enable_web_search": False, "limit_generations": True,
            "prompt": (
                "Create ONE single continuous illustrated scene, not a comparison, diptych, collage or split-screen. "
                "Image 1 is a coarse 3D CAMERA AND SILHOUETTE GUIDE. Preserve its ground-level camera, horizon, "
                "tower placement, scale and attached-building arrangement. Image 2 is the architectural and art-style reference "
                "for that SAME lighthouse, not a second object to put in the scene. "
                "Replace the coarse surfaces with the reference's inked stonework, terracotta roof, open bowl crown, "
                "two visible curved crown arms and floating cyan crystal. Keep the annex connected at the tower base. "
                "Do not add large buttresses, extra towers or a ring of extra prongs. "
                "Retain the reference's hand-drawn colorful illustrated medium, not clay or a photorealistic 3D render. "
                f"{EXTERIOR} Landscape 16:9. The camera guide takes priority over the reference's aerial viewpoint."
            ),
        }, Decimal(".15")
    return QWEN, {
        "image_urls": [crop], "horizontal_angle": 0, "vertical_angle": -30 if variant == "qwen_low" else 0,
        "zoom": 5, "lora_scale": 1, "seed": seed, "image_size": {"width": 1280, "height": 720},
        "num_images": 1, "num_inference_steps": 28, "guidance_scale": 4.5,
        "acceleration": "regular", "enable_safety_checker": True, "output_format": "png",
        "additional_prompt": f"{EXTERIOR} One continuous 16:9 illustrated scene. Keep the exact open bowl crown, curved arms, floating cyan crystal, tapered stone body and attached terracotta-roof annex. Preserve the inked illustrated style and palette.",
        "negative_prompt": "split screen, comparison, diptych, duplicate lighthouse, aerial map, large buttresses, ring of extra prongs, photorealism",
    }, Decimal(".20")


def architecture_result(value: dict) -> dict:
    raw = value.get("checks")
    raw = raw if isinstance(raw, dict) else {}
    checks = {k: raw[k] if raw.get(k) in ("pass", "fail", "unknown") else "unknown" for k in ARCH_AXES}
    return {"checks": checks, "accepted": all(v == "pass" for v in checks.values()),
            "rationale": str(value.get("rationale", "Unavailable"))[:900]}


async def quote(client, auth):
    response = await client.get("https://api.fal.ai/v1/models/pricing", params={"endpoint_id": f"{MODEL},{QWEN}"}, headers=auth)
    response.raise_for_status()
    rows = {r["endpoint_id"]: r for r in response.json()["prices"]}
    for model, maximum, units in [(MODEL, Decimal(".15"), {"image", "images"}), (QWEN, Decimal(".04"), {"megapixel", "megapixels"})]:
        r = rows[model]
        if r["currency"] != "USD" or r["unit"] not in units or not 0 < Decimal(str(r["unit_price"])) <= maximum:
            raise ValueError("Pricing exceeds conservative quote; no image submission")
    return response.json()


async def run():
    if os.environ.get("LIGHTHOUSE_CONTROL_PILOT") != "1":
        raise RuntimeError("Explicit approved $4 pilot opt-in required")
    report = prepare()
    from dotenv import load_dotenv
    load_dotenv(BACKEND / ".env")
    os.environ.update(LLM_PROVIDER="openrouter", LLM_BASE_URL="https://openrouter.ai/api/v1",
                      LLM_VLM_MODEL=LLM, OPENROUTER_VLM_MODEL=LLM, CONTINUITY_BENCH_JUDGE_MODEL=LLM,
                      WORLD_BENCH_JUDGE_MODEL=LLM, OPENROUTER_ENABLE_WEB_SEARCH="false",
                      WORLD_IDENTITY_ACCEPT_PLACE="7", WORLD_IDENTITY_ACCEPT_MEDIUM="7",
                      WORLD_IDENTITY_ACCEPT_CONFORMANCE="7", VIEW_LOOP_ACCEPT_DETAIL="6")
    import httpx

    from providers.arrival_reference import _inspect
    from providers.image import GeneratedImage, _fetch_image_bytes, _first_image, encode_data_url
    from providers.place_identity import verify_and_render
    from providers.render_budget import RenderBudget

    with Ledger(OUT / "ledger.json", CAP) as ledger:
        if ledger.cells:
            raise RuntimeError("This batch has submitted calls; never resubmit or overwrite it")
        auth = {"Authorization": f"Key {os.environ['FAL_KEY']}"}
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as http:
            atomic_json(OUT / "pricing.json", await quote(http, auth))
            meter = Meter(ledger)
            meter.install(image_calls=False, max_llm_calls=48)
            report.update(status="running", approved_cap_usd=str(CAP))
            atomic_json(OUT / "manifest.json", report)
            crop = Path(report["reference"]["reference"]).read_bytes()
            (OUT / "reference.png").write_bytes(crop)
            crop_url = encode_data_url(crop, "image/png")
            for trial in report["trials"]:
                token = ACTIVE.set(trial["id"])
                try:
                    mode = trial["variant"].removeprefix("guide_")
                    guide = (GUIDES / f"{mode}.png").read_bytes() if mode in ("color", "clay") else None
                    model, args, amount = arguments(trial["variant"], trial["seed"], crop_url, encode_data_url(guide, "image/png") if guide else None)
                    budget = RenderBudget(trial["id"], 1, time.monotonic() + 700)
                    trial.update(state="submitted", model=model, arguments=scrub(args), image_reservation_usd=str(amount))
                    atomic_json(OUT / "manifest.json", report)

                    async def render(suffix, index, *, budget=budget, trial=trial, model=model, args=args, amount=amount):
                        if suffix or index:
                            raise RuntimeError("No unplanned reroll")
                        # The queue ledger is the monetary authority for both model families.
                        budget.reserve(MODEL)
                        def submitted(cell):
                            cell.update(kind="image", operation=trial["id"], model=model, arguments=scrub(args))
                            ledger.save()
                        cell = await generate_cell(http, auth, ledger, f"{trial['id']}:image", model, args, amount, on_update=submitted)
                        pixels, mime = await _fetch_image_bytes(_first_image(cell["result"]))
                        (OUT / f"{trial['id']}.png").write_bytes(pixels)
                        trial.update(output_sha256=sha(pixels), request_id=cell["request_id"])
                        atomic_json(OUT / "manifest.json", report)
                        return GeneratedImage(pixels, mime, model, cell["request_id"])

                    async def abort(_stage):
                        return None

                    result = await verify_and_render(render, budget=budget, reference=crop,
                        label=report["reference"]["label"], visual=report["reference"]["visual"],
                        projection="eye_level", facts=report["reference"]["facts"], abort=abort, exterior=True)
                    architectural = await asyncio.wait_for(_inspect(
                        "Compare image 1 (the established lighthouse) to image 2 (a new exterior). Ignore generic subject similarity. "
                        "Return checks pass/fail/unknown and short rationale. crown: same open bowl, curved arms and floating crystal, "
                        "not replaced by a different cage or ring of many extra supports. tower_body: same tapered stone silhouette "
                        "and base, no invented large buttresses. annex: same attached building, roof mass and relationship to tower; "
                        "not a different large house or detached outbuilding. single_scene: one scene and one lighthouse only. "
                        "Visible contradictions fail; occluded evidence is unknown, never pass. Judge against the reference, "
                        "not an imagined generic lighthouse. Do not penalize viewpoint change itself. "
                        '{"checks":{"crown":"pass|fail|unknown","tower_body":"pass|fail|unknown","annex":"pass|fail|unknown","single_scene":"pass|fail|unknown"},"rationale":"evidence"}',
                        [crop, result.image.jpeg_bytes]), timeout=75)
                    architecture = architecture_result(architectural)
                    with Image.open(io.BytesIO(result.image.jpeg_bytes)) as im:
                        width, height = im.size
                    framing = abs(width / height - 16 / 9) / (16 / 9) <= .02
                    trial.update(state="complete", view_verdict=result.verdict, architecture=architecture,
                                 framing={"width": width, "height": height, "accepted": framing},
                                 all_checks_passed=result.verdict["accepted"] and architecture["accepted"] and framing,
                                 human_review=None)
                except Exception as exc:
                    trial.update(state="failed_or_uncertain", error=f"{type(exc).__name__}: {str(exc)[:400]}")
                finally:
                    ACTIVE.reset(token)
                    atomic_json(OUT / f"{trial['id']}-receipt.json", trial)
                    report.update(meter.summary())
                    atomic_json(OUT / "manifest.json", report)
                    print(json.dumps({"trial": trial["id"], "state": trial["state"], "accepted": trial.get("all_checks_passed"), **meter.summary()}), flush=True)
            atomic_json(OUT / "billing.json", await billing_report(http, auth, [c for c in ledger.cells.values() if c.get("kind") == "image"]))
            report.update(status="complete_not_promoted", **meter.summary())
            atomic_json(OUT / "manifest.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if args.run:
        asyncio.run(run())
    else:
        print(json.dumps(prepare(), indent=2))
