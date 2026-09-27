"""Offline arrival input audit. No provider imports, uploads, or network calls.

Run with --prepare to write the local study's manifest and review-only crops.
Human boxes are evaluation annotations, never runtime canonical references.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image

BACKEND = Path(__file__).resolve().parents[2]
ROOT = BACKEND.parents[1]
FIXTURES = BACKEND / "tests/click_bench/fixtures"
OUT = BACKEND / "tests/continuity_bench/reports/arrival-audit"
CASES = {
    "fishing_lighthouse": {"title": "North Point Lighthouse", "bbox": [.49, .07, .115, .25], "features": ["White tapered masonry tower", "Dark lantern and cap", "Attached terracotta-roof house"], "entrance": "Small arched opening at tower base"},
    "oasis_citadel": {"title": "Sandstone Citadel", "bbox": [.498, .05, .27, .305], "features": ["Rectangular sandstone enclosure", "Corner towers and crenellations", "Central inner keep"], "entrance": "Gate details are uncertain at source resolution"},
    "harbor_lighthouse": {"title": "Crystal Lighthouse", "bbox": [.095, .07, .12, .43], "features": ["Forked open bowl crown", "Floating cyan crystal and satellites", "Attached terracotta-roof house"], "entrance": "Small arched opening at tower base"},
}
POLICIES = ("context_first", "target_first")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def build() -> dict:
    fixtures = json.loads((FIXTURES / "v1.json").read_text())["cases"]
    cases = []
    for case_id, review in CASES.items():
        fixture = next(c for c in fixtures if c["case_id"] == case_id)
        source = FIXTURES / fixture["image_path"]
        with Image.open(source) as image:
            size = list(image.size)
        cases.append({"id": case_id, "title": review["title"], "source": source.name,
                      "source_sha256": sha(source.read_bytes()), "size": size,
                      "click": {"x_pct": fixture["x_pct"], "y_pct": fixture["y_pct"]},
                      "review": {"bbox": review["bbox"], "features": review["features"], "entrance": review["entrance"], "provenance": "human_evaluation_only"},
                      "runtime_reference": None})
    code = ["apps/web/lib/place-generation.ts", "apps/modal-backend/providers/arrival.py", "apps/modal-backend/providers/place_identity.py", "apps/modal-backend/providers/generate_modes/tap.py", "apps/modal-backend/providers/image_edit.py", "apps/modal-backend/tests/continuity_bench/arrival_audit.py"]
    manifest = {
        "version": 1, "approved_cap_usd": "0.00", "reserved_usd": "0.00", "status": "awaiting_quote_and_approval",
        "model": "fal-ai/nano-banana-pro/edit", "randomness": "provider_managed", "image_attempts_per_cell": 1,
        "arrival_intent": "exterior", "cases": cases,
        "implementation": {path: sha((ROOT / path).read_bytes()) for path in code},
        "cells": [{"id": f"{case['id']}-{policy}-{run}", "case_id": case["id"], "policy": policy, "run": run, "state": "not_submitted", "arrival": None, "view_verdict": None, "human_review": None, "output_sha256": None}
                  for case in cases for policy in POLICIES for run in (1, 2)],
        "execution_contract": {
            "entry": "normal /play click -> /api/generate-page -> generation stream",
            "metadata": "Automatic extraction must be recorded before trials; never inject review annotations as runtime metadata.",
            "billing": ["root extraction", "click resolution", "planning", "image submissions", "all judge calls", "failed or interrupted submissions"],
            "ledger": "Use tests.video_transition_bench.runner.Ledger with the approved cap; persist reservations and request IDs before polling; never resubmit ambiguous requests.",
            "promotion": "Both runs of all three cases must pass all mandatory checks and human review; otherwise no canary.",
        },
    }
    manifest["fingerprint"] = sha(json.dumps(manifest, sort_keys=True).encode())
    return manifest


def prepare(out: Path) -> dict:
    report = build()
    out.mkdir(parents=True, exist_ok=True)
    # A preparation command cannot erase or reclassify any submitted trial.
    if (out / "ledger.json").exists() or list(out.glob("*-receipt.json")) or list(out.glob("*-candidate.png")):
        raise ValueError("Trial artifacts already exist; do not overwrite the audit")
    if (out / "manifest.json").exists():
        previous = json.loads((out / "manifest.json").read_text())
        if any(cell.get("state") != "not_submitted" for cell in previous["cells"]):
            raise ValueError("Submitted trial manifest cannot be overwritten")
    for case in report["cases"]:
        source = FIXTURES / "images/real" / case["source"]
        with Image.open(source) as image:
            x, y, w, h = case["review"]["bbox"]
            bounds = (int(x * image.width), int(y * image.height), round((x + w) * image.width), round((y + h) * image.height))
            crop = image.crop(bounds).convert("RGB")
            buffer = io.BytesIO()
            crop.save(buffer, "PNG")
        case["review"]["crop_sha256"] = sha(buffer.getvalue())
        (out / f"{case['id']}-review.png").write_bytes(buffer.getvalue())
    (out / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    print(json.dumps(prepare(OUT) if args.prepare else build(), indent=2))
