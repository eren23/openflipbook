"""Bounded, cached pilot on three checked-in real maps. Never changes defaults.

PLACE_IDENTITY_PILOT=1 .venv/bin/python -m tests.continuity_bench.place_identity_runner
Both arms get one image attempt, the same model and the same named target.
The $5 conservative reservation ledger also counts each LLM request. A missing
cell or failed judge marks the pilot incomplete, never as a zero-score success.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[2]
FIXTURES = BACKEND / "tests/click_bench/fixtures"
OUT = BACKEND / "tests/continuity_bench/reports/place-identity-pilot"
MODEL = "fal-ai/nano-banana-pro"
CASES = ("fishing_lighthouse", "oasis_citadel", "harbor_lighthouse")


class PilotLedger:
    """Run-wide reservations survive restarts and UTC day boundaries."""

    def __init__(self, path: Path, cap: float = 4.80):
        self.path, self.cap = path, cap
        self.reserved = float(json.loads(path.read_text())["reserved_usd"]) if path.exists() else 0.0
        if not math.isfinite(self.reserved) or self.reserved < 0:
            raise ValueError("Invalid pilot ledger; reconcile spend before continuing")

    def reserve(self, amount: float) -> None:
        if not math.isfinite(amount) or amount < 0:
            raise ValueError("Invalid reservation")
        if self.reserved + amount > self.cap:
            raise RuntimeError("Run-wide pilot budget exhausted")
        self.reserved = round(self.reserved + amount, 4)
        self.path.write_text(json.dumps({"reserved_usd": self.reserved}, indent=2))


async def main() -> None:
    if os.environ.get("PLACE_IDENTITY_PILOT") != "1":
        raise SystemExit("Paid pilot disabled; set PLACE_IDENTITY_PILOT=1 explicitly")
    load_dotenv(BACKEND / ".env")
    if os.environ.get("MOCK_PROVIDERS") in {"1", "true"}:
        raise SystemExit("A mock run is not a visual-quality pilot")
    sys.modules.setdefault("modal", MagicMock())
    from generate import GenerateBody, _event_stream
    from providers import image, image_edit, judge, llm, spend
    from providers.place_identity import reference_crop
    from providers.render_budget import RenderBudget

    os.environ.update(WORLD_IDENTITY_STRICT="true", WORLD_MODE="true", VIEW_GRAMMAR="true", PROGRESSIVE_DRAFT="false", VLM_JUDGE_EMPTY_RETRIES="1", MAX_DAILY_SPEND="4.80", MAX_SESSION_SPEND="4.80")
    OUT.mkdir(parents=True, exist_ok=True)
    ledger = PilotLedger(OUT / "ledger.json")
    spend.reset_for_tests()
    spend.record("pilot", ledger.reserved)
    raw_reserve = spend.reserve

    def reserve(session_id: str, amount: float) -> float:
        ledger.reserve(amount)
        return raw_reserve(session_id, amount)

    spend.reserve = reserve
    # Actual submission reservations, not a second post-hoc image estimate.
    spend.record_generation = lambda session_id, model, images=1: spend.session_total(session_id)
    raw_llm = llm._create_with_retry

    async def bounded_llm(client, **kwargs):
        reserve("pilot-llm", .02)
        kwargs["max_retries"] = 0
        return await raw_llm(client, **kwargs)

    llm._create_with_retry = bounded_llm
    from providers.llm import client as llm_client

    llm_client._create_with_retry = bounded_llm
    raw_fal = image._fal_subscribe
    current_budget = None

    async def bounded_fal(model, arguments, *, require_images=False, budget=None):
        return await raw_fal(model, arguments, require_images=require_images, budget=budget or current_budget)

    image._fal_subscribe = bounded_fal
    image_edit._fal_subscribe = bounded_fal
    cases = json.loads((FIXTURES / "v1.json").read_text())["cases"]
    results = []
    for case_id in CASES:
        case = next(c for c in cases if c["case_id"] == case_id)
        source = (FIXTURES / case["image_path"]).read_bytes()
        source_url = image.encode_data_url(source, "image/jpeg")
        box = {"x_pct": max(0, case["x_pct"] - .11), "y_pct": max(0, case["y_pct"] - .14), "w_pct": .22, "h_pct": .28}
        crop = reference_crop(source_url, SimpleNamespace(**box))
        crop_url = image.encode_data_url(crop, "image/png")
        label = case["alternates"][0]
        for transition in ("enter", "closeup"):
            for strict in (False, True):
                key = f"{case_id}-{transition}-{'strict' if strict else 'baseline'}"
                receipt = OUT / f"{key}.json"
                # Include production source hashes so a changed gate cannot
                # masquerade as a cached receipt from this implementation.
                sources = [BACKEND / "providers/place_identity.py", BACKEND / "providers/generate_modes/tap.py", BACKEND / "providers/image_edit.py"]
                digest = hashlib.sha256(source + b"".join(p.read_bytes() for p in sources) + MODEL.encode()).hexdigest()
                if receipt.exists():
                    cached = json.loads(receipt.read_text())
                    if cached.get("source_hash") == digest and cached.get("complete"):
                        results.append(cached)
                        continue
                current_budget = RenderBudget(key, 1, time.monotonic() + 600)
                started = time.monotonic()
                row = {"case": key, "source_hash": digest, "complete": False, "accepted": False}
                try:
                    body = GenerateBody(
                        query=case["parent_title"], session_id=key, current_node_id="fixture", mode="tap", image=source_url,
                        world_mode=True, strict_world=strict, target_geo_id=case_id,
                        place_reference={"geo_id": case_id, "label": label, "visual": case["notes"], "image_data_url": source_url, "bbox": box} if strict else None,
                        prefetched_subject=label, prefetched_subject_context=case["notes"],
                        render_mode="place_scene" if transition == "enter" else "place_submap",
                        condition_image_urls=[crop_url, source_url], condition_roles=["region", "parent"],
                        scene_view={"node_id": "fixture", "level": "building" if transition == "enter" else "map", "focus_id": case_id, "closeup": transition == "closeup", "view": {"projection": "oblique" if transition == "enter" else "top_down", "source": "user"}},
                        image_model=MODEL, max_attempts=1, verify=True, web_search=False,
                    )
                    output = None
                    async for chunk in _event_stream(body, key):
                        for line in chunk.decode().splitlines():
                            if line.startswith("data:"):
                                event = json.loads(line[5:])
                                if event["type"] in {"final", "error"}:
                                    output = event
                    task = asyncio.current_task()
                    if task and task.cancelling():
                        raise asyncio.CancelledError()
                    if not output:
                        raise RuntimeError("No final result or rejection")
                    url = output.get("image_data_url") or output.get("candidate_image_data_url")
                    if not url:
                        raise RuntimeError(output.get("message", "No image produced"))
                    from providers.render_loop import data_url_bytes

                    candidate = data_url_bytes(url)
                    assert candidate is not None
                    (OUT / f"{key}.jpg").write_bytes(candidate)
                    identity = await judge.score_entity_consistency(label, case["notes"], crop, candidate)
                    medium = await judge.score_style_pair(crop, candidate)
                    row.update(complete=True, accepted=output["type"] == "final", identity=identity.score, medium=medium.score, identity_reason=identity.rationale, medium_reason=medium.rationale, receipt=output.get("view_verdict"), seconds=round(time.monotonic() - started, 2))
                except Exception as exc:
                    row["error"] = str(exc)[:240]
                receipt.write_text(json.dumps(row, indent=2))
                results.append(row)
                print(json.dumps(row), flush=True)
                (OUT / "summary.json").write_text(json.dumps({"complete": len(results) == 12 and all(r["complete"] for r in results), "promotion": False, "reserved_usd": ledger.reserved, "results": results}, indent=2))
    (OUT / "summary.json").write_text(json.dumps({"complete": len(results) == 12 and all(r["complete"] for r in results), "promotion": False, "reserved_usd": ledger.reserved, "results": results}, indent=2))
    print(f"Pilot receipts: {OUT}; conservative reservations ${ledger.reserved:.2f}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
