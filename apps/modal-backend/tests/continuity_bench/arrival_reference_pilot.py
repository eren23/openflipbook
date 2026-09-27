"""Reference-only follow-up. Default preparation is offline; --run needs approval."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from decimal import Decimal
from pathlib import Path

from tests.continuity_bench.arrival_audit import BACKEND, CASES, FIXTURES, OUT, ROOT, sha
from tests.video_transition_bench.runner import Ledger, atomic_json

REFERENCE_OUT = OUT.parent / "arrival-reference-pilot"
CAP = Decimal("1.00")


def inputs(audit: Path = OUT, fixtures: Path = FIXTURES / "images/real") -> list[dict]:
    manifest = json.loads((audit / "manifest.json").read_text())
    result = []
    for case_id in CASES:
        case = next(c for c in manifest["cases"] if c["id"] == case_id)
        request = json.loads((audit / f"{case_id}-context_first-1-request.json").read_text())
        ref = request["place_reference"]
        source = fixtures / Path(case["source"]).name
        if sha(source.read_bytes()) != ref["provenance"]["image_sha256"] or ref["provenance"]["image_sha256"] != case["source_sha256"]:
            raise ValueError("Original reference source does not match its receipt")
        if ref["provenance"]["kind"] == "curated":
            raise ValueError("This pilot requires automatic, not curated, references")
        result.append({"id": case_id, "source": str(source), "source_sha256": case["source_sha256"],
                       "label": ref["label"], "visual": ref["visual"], "bbox": ref["bbox"], "provenance": ref["provenance"]})
    return result


def prepare() -> dict:
    return {"status": "awaiting_approval", "approved_cap_usd": "0.00", "quoted_cap_usd": str(CAP),
            "max_vision_calls": 6, "generated_images": 0, "videos": 0, "cases": inputs(),
            "implementation": {path: sha((ROOT / path).read_bytes()) for path in (
                "apps/modal-backend/providers/arrival_reference.py",
                "apps/modal-backend/tests/continuity_bench/arrival_reference_pilot.py",
                "apps/modal-backend/tests/continuity_bench/arrival_live.py",
            )}}


async def run():
    if os.environ.get("ARRIVAL_REFERENCE_PILOT") != "1":
        raise RuntimeError("Explicit approval and ARRIVAL_REFERENCE_PILOT=1 are required")
    report = prepare()
    from dotenv import load_dotenv
    load_dotenv(BACKEND / ".env")
    from tests.continuity_bench.arrival_live import ACTIVE, LLM, Meter
    os.environ.update(LLM_PROVIDER="openrouter", LLM_BASE_URL="https://openrouter.ai/api/v1",
                      LLM_VLM_MODEL=LLM, OPENROUTER_VLM_MODEL=LLM,
                      CONTINUITY_BENCH_JUDGE_MODEL=LLM, WORLD_BENCH_JUDGE_MODEL=LLM,
                      OPENROUTER_ENABLE_WEB_SEARCH="false")
    from providers.arrival_reference import ReferenceBox, resolve_physical_reference
    from providers.image import encode_data_url
    from providers.place_identity import reference_crop
    with Ledger(REFERENCE_OUT / "ledger.json", CAP) as ledger:
        if ledger.cells:
            raise RuntimeError("A reference pilot was already submitted; do not resubmit or overwrite receipts")
        report.update(status="running", approved_cap_usd=str(CAP))
        atomic_json(REFERENCE_OUT / "manifest.json", report)
        meter = Meter(ledger)
        meter.install(image_calls=False, max_llm_calls=6)
        try:
            for case in report["cases"]:
                token = ACTIVE.set(case["id"])
                try:
                    source = Path(case["source"]).read_bytes()
                    url = encode_data_url(source, "image/jpeg")
                    box = ReferenceBox.parse(case["bbox"])
                    if box is None:
                        raise ValueError("Invalid original reference box")
                    (REFERENCE_OUT / f"{case['id']}-original.png").write_bytes(reference_crop(url, box))
                    resolved = await asyncio.wait_for(resolve_physical_reference(url, box, case["label"], case["visual"]), timeout=60)
                    receipt = {**resolved.receipt, "case_id": case["id"], "calls": [c for c in ledger.cells.values() if c["operation"] == case["id"]], "human_review": None}
                    atomic_json(REFERENCE_OUT / f"{case['id']}-receipt.json", receipt)
                    # Keep rejected crops too, separate from their acceptance state.
                    effective = ReferenceBox.parse(resolved.receipt.get("effective_bbox"))
                    if effective:
                        (REFERENCE_OUT / f"{case['id']}-proposed.png").write_bytes(reference_crop(url, effective))
                    print(json.dumps({"case": case["id"], "status": resolved.receipt["status"], **meter.summary()}), flush=True)
                finally:
                    ACTIVE.reset(token)
            report["status"] = "complete_not_promoted"
        except BaseException:
            report["status"] = "stopped_no_resubmission"
            raise
        finally:
            report.update(meter.summary())
            atomic_json(REFERENCE_OUT / "manifest.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if args.run:
        asyncio.run(run())
    else:
        print(json.dumps(prepare(), indent=2))
