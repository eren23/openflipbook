"""Finalize saved pilot evidence; billing lookup is read-only, never generation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from decimal import Decimal

import httpx
from dotenv import load_dotenv

from providers.arrival import parse_arrival_reply
from tests.continuity_bench.arrival_audit import BACKEND, OUT, ROOT
from tests.video_transition_bench.runner import atomic_json, billing_report


async def finalize():
    report = json.loads((OUT / "manifest.json").read_text())
    ledger = json.loads((OUT / "ledger.json").read_text())
    reviews = json.loads((BACKEND / "tests/continuity_bench/arrival_review.json").read_text())
    calls = list(ledger["cells"].values())
    images = [c for c in calls if c.get("kind") == "image"]
    for cell in report["cells"]:
        if cell["state"] == "submitted":
            raise ValueError("A trial is still running or ambiguous; do not finalize")
        if cell.get("output_sha256"):
            raw = (OUT / f"{cell['id']}-candidate.png").read_bytes()
            if hashlib.sha256(raw).hexdigest() != cell["output_sha256"]:
                raise ValueError("Candidate bytes changed after judging")
        if cell["id"] in reviews:
            cell["visual_review"] = {"reviewer": "assistant", **reviews[cell["id"]]}
        # Preserve actual accept/reject decisions. Replay only the parser on
        # original responses to distinguish formatting failures from bad images.
        own = [c for c in calls if c.get("operation") == cell["id"]]
        arrival_calls = [c for c in own if c.get("kind") == "llm" and
                         "Compare an architectural reference crop" in json.dumps(c.get("request", {}))]
        if arrival_calls:
            answer = arrival_calls[-1].get("response", {}).get("choices", [{}])[0]
            if answer.get("finish_reason") != "length":
                cell["offline_parser_replay"] = parse_arrival_reply(answer.get("message", {}).get("content") or "")
        cell["provider_request_ids"] = [c["request_id"] for c in own if c.get("request_id")]
        atomic_json(OUT / f"{cell['id']}-receipt.json", cell)
    for case in report["cases"]:
        first = next((c for c in report["cells"] if c["case_id"] == case["id"] and (OUT / f"{c['id']}-runtime.png").exists()), None)
        if first and case.get("runtime_reference"):
            case["runtime_reference"]["asset"] = f"{first['id']}-runtime.png"
    load_dotenv(BACKEND / ".env")
    async with httpx.AsyncClient(timeout=30) as http:
        billing = await billing_report(http, {"Authorization": f"Key {os.environ['FAL_KEY']}"}, images)
    atomic_json(OUT / "billing.json", billing)
    llm_cost = sum((Decimal(c["reported_cost_usd"]) for c in calls if c.get("reported_cost_usd")), Decimal(0))
    reserved = sum((Decimal(c["reserved_usd"]) for c in calls), Decimal(0))
    summary = {"image_submissions": len(images), "llm_calls": len(calls) - len(images),
               "recorded_candidates": sum(bool(c.get("output_sha256")) for c in report["cells"]),
               "runtime_accepted": sum(c.get("view_verdict", {}).get("accepted") is True for c in report["cells"] if c.get("view_verdict")),
               "assistant_reviewed": len(reviews), "assistant_accepted": sum(v["accepted"] for v in reviews.values()),
               "openrouter_reported_usd": str(llm_cost), "fal_billing": billing,
               "accounted_or_reserved_usd": str(reserved), "approved_cap_usd": ledger["cap_usd"]}
    report.update(status="pilot_complete_not_promoted", reserved_usd=str(reserved), summary=summary,
                  experiment_limits=["Two early runs used the pre-fix JSON fence parser; original decisions are retained.",
                                     "Real end-to-end runs re-plan independently; this is not a prompt-identical isolated reference-order experiment.",
                                     "Assistant visual reviews are not user sign-off. No defaults are promoted."])
    report["execution_implementation"] = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in
                                         ["apps/modal-backend/tests/continuity_bench/arrival_live.py", "apps/web/scripts/run-arrival-pilot.mjs", "apps/modal-backend/providers/arrival.py"]}
    atomic_json(OUT / "manifest.json", report)
    atomic_json(OUT / "summary.json", summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(finalize())
