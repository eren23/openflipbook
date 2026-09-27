"""One fixed-input exterior arrival. Offline by default; live execution needs approval."""
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
from tests.continuity_bench.arrival_live import ACTIVE, LLM, MODEL, Meter
from tests.continuity_bench.arrival_reference_pilot import REFERENCE_OUT
from tests.video_transition_bench.runner import Ledger, atomic_json

OUT = REFERENCE_OUT.parent / "arrival-destination-pilot"
OPERATION = "crystal-eye-level-1"
CAP = Decimal("1.00")


def prepare(reference_dir: Path = REFERENCE_OUT) -> dict:
    from providers.arrival import EXTERIOR
    from providers.prompt_library.style import medium_lock

    manifest = json.loads((reference_dir / "manifest.json").read_text())
    case = next(c for c in manifest["cases"] if c["id"] == "harbor_lighthouse")
    receipt = json.loads((reference_dir / "harbor_lighthouse-receipt.json").read_text())
    source, crop = Path(case["source"]), reference_dir / "harbor_lighthouse-proposed.png"
    if receipt["status"] != "pass" or sha(source.read_bytes()) != case["source_sha256"] or sha(source.read_bytes()) != receipt["source_sha256"] or sha(crop.read_bytes()) != receipt["crop_sha256"]:
        raise ValueError("Reference evidence is missing, rejected or changed")
    prompt = (
        f"Image 1 is the architectural crop of {case['label']}: {case['visual']} "
        "Image 2 is world context only, not an output background plate. "
        f"{EXTERIOR}\nThe reference viewpoint is NOT the output viewpoint. "
        "Place the camera at standing height on the ground beside the tower, approximately 1.6 metres high, "
        "looking toward the tower from nearby. Look forward or upward, never downward over its crown or roof. "
        "Preserve the tower's visible proportions and the attached building's relationship to it. "
        f"{medium_lock(None, ref_name='image 1')} "
        "Render a landscape 16:9 output even though the architectural reference crop is portrait. "
        "No aerial overview, diagram, inset, or map border."
    )
    return {"status": "awaiting_approval", "approved_cap_usd": "0.00", "quoted_cap_usd": str(CAP),
            "operation": OPERATION, "model": MODEL, "aspect_ratio": "16:9", "resolution": "1K",
            "image_limit": 1, "max_judge_calls": 5, "videos": 0, "retries": 0,
            "entry": "fixed-input component experiment, not normal-click end-to-end proof",
            "reference_policy": "target_first", "source": str(source), "reference": str(crop),
            "source_sha256": case["source_sha256"], "reference_sha256": receipt["crop_sha256"],
            "reference_receipt_sha256": sha((reference_dir / "harbor_lighthouse-receipt.json").read_bytes()),
            "label": case["label"], "visual": case["visual"], "facts": [case["visual"]], "prompt": prompt,
            "floors": {"same_place": 7, "medium": 7, "conformance": 7, "detail": 6},
            "implementation": {path: sha((ROOT / path).read_bytes()) for path in (
                "apps/modal-backend/tests/continuity_bench/arrival_destination_pilot.py",
                "apps/modal-backend/tests/continuity_bench/arrival_live.py",
                "apps/modal-backend/providers/image_edit.py", "apps/modal-backend/providers/place_identity.py",
                "apps/modal-backend/providers/arrival.py", "apps/modal-backend/providers/judge.py",
                "apps/modal-backend/providers/prompt_library/style.py",
            )}}


async def run():
    if os.environ.get("ARRIVAL_DESTINATION_PILOT") != "1":
        raise RuntimeError("Explicit approval and ARRIVAL_DESTINATION_PILOT=1 are required")
    report = prepare()
    from dotenv import load_dotenv
    load_dotenv(BACKEND / ".env")
    if os.environ.get("MOCK_PROVIDERS", "").lower() in {"1", "true"}:
        raise RuntimeError("Mock providers cannot run in a live pilot")
    os.environ.update(LLM_PROVIDER="openrouter", LLM_BASE_URL="https://openrouter.ai/api/v1",
                      LLM_VLM_MODEL=LLM, OPENROUTER_VLM_MODEL=LLM,
                      CONTINUITY_BENCH_JUDGE_MODEL=LLM, WORLD_BENCH_JUDGE_MODEL=LLM,
                      OPENROUTER_ENABLE_WEB_SEARCH="false", WORLD_IDENTITY_ACCEPT_PLACE="7",
                      WORLD_IDENTITY_ACCEPT_MEDIUM="7", WORLD_IDENTITY_ACCEPT_CONFORMANCE="7",
                      VIEW_LOOP_ACCEPT_DETAIL="6")
    import httpx

    from providers.image import encode_data_url
    from providers.image_edit import edit_image
    from providers.place_identity import verify_and_render
    from providers.render_budget import RenderBudget

    with Ledger(OUT / "ledger.json", CAP) as ledger:
        if ledger.cells:
            raise RuntimeError("Already submitted; reconcile saved receipts, do not rerun")
        async with httpx.AsyncClient(timeout=30) as http:
            price = await http.get("https://api.fal.ai/v1/models/pricing", params={"endpoint_id": MODEL}, headers={"Authorization": f"Key {os.environ['FAL_KEY']}"})
            price.raise_for_status()
            prices = price.json()["prices"]
            if len(prices) != 1 or prices[0]["currency"] != "USD" or prices[0]["unit"] not in {"image", "images"} or Decimal(str(prices[0]["unit_price"])) > Decimal(".15"):
                raise RuntimeError("Image quote changed; no submission")
        atomic_json(OUT / "pricing.json", price.json())
        report.update(status="running", approved_cap_usd=str(CAP))
        atomic_json(OUT / "manifest.json", report)
        meter = Meter(ledger)
        meter.install(max_llm_calls=5, image_operations=frozenset({OPERATION}))
        source, crop = Path(report["source"]).read_bytes(), Path(report["reference"]).read_bytes()
        (OUT / "reference.png").write_bytes(crop)
        (OUT / "source.jpg").write_bytes(source)
        budget = RenderBudget(OPERATION, 1, time.monotonic() + 480)

        async def render(suffix: str, index: int):
            if suffix or index != 0:
                raise RuntimeError("No reroll is approved")
            result = await edit_image(encode_data_url(crop, "image/png"), report["prompt"],
                                      model_override=MODEL, context_ref_url=encode_data_url(source, "image/jpeg"),
                                      aspect_ratio="16:9", budget=budget)
            (OUT / "candidate.png").write_bytes(result.jpeg_bytes)
            report.update(output_sha256=sha(result.jpeg_bytes), provider_request_id=result.provider_request_id)
            atomic_json(OUT / "manifest.json", report)
            return result

        async def abort(_stage: str):
            return None

        token = ACTIVE.set(OPERATION)
        try:
            result = await verify_and_render(render, budget=budget, reference=crop, label=report["label"],
                                             visual=report["visual"], projection="eye_level", facts=report["facts"],
                                             abort=abort, exterior=True)
            with Image.open(io.BytesIO(result.image.jpeg_bytes)) as image:
                width, height = image.size
            framing = abs(width / height - 16 / 9) / (16 / 9) <= .02
            receipt = {"view_verdict": result.verdict, "framing": {"width": width, "height": height, "accepted": framing},
                       "all_automatic_checks_passed": result.verdict["accepted"] and framing,
                       "output_sha256": sha(result.image.jpeg_bytes), "human_review": None,
                       "automatic_publication": False, **meter.summary()}
            atomic_json(OUT / "result-receipt.json", receipt)
            report["status"] = "complete_not_promoted"
            print(json.dumps(receipt), flush=True)
        except BaseException:
            report["status"] = "stopped_no_resubmission"
            raise
        finally:
            ACTIVE.reset(token)
            report.update(meter.summary())
            atomic_json(OUT / "manifest.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if args.run:
        asyncio.run(run())
    else:
        print(json.dumps(prepare(), indent=2))
