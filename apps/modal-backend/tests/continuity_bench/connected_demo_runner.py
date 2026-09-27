"""One explicitly selected still at a time, with a durable $3 reservation cap.

Offline preview by default. CONNECTED_DEMO=1 enables --run. No LLM/video calls.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import os
import time
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal
from pathlib import Path

import httpx
from dotenv import load_dotenv
from PIL import Image

from providers.image_edit import _edit_args_for, _resolve_edit_model
from tests.video_transition_bench.runner import BACKEND, Ledger, atomic_json, generate_cell, money

ROOT = BACKEND.parents[1]
OUT = BACKEND / "tests/continuity_bench/reports/connected-demo"
PLAN = ROOT / "scripts/record-demo/connected-route.json"
SOURCE = BACKEND / "tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg"
CAP = Decimal("3.00")
MODEL = "fal-ai/nano-banana-pro/edit"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(shot: str, attempt: int, plan: dict, out: Path) -> dict:
    spec = plan["shots"][shot]
    parent = SOURCE if spec["source"] == "root" else out / f"{spec['source']}.png"
    if not parent.is_file():
        raise ValueError("Approved parent output is missing")
    if spec["source"] != "root":
        receipt = json.loads((out / f"{spec['source']}-receipt.json").read_text())
        if receipt.get("review", {}).get("accepted") is not True or sha(parent) != receipt["output_sha256"]:
            raise ValueError("Parent must be visually reviewed before generating a deeper view")
    config = spec["attempts"][str(attempt)]
    roles = [{"role": "parent", "path": str(parent), "sha256": sha(parent)}]
    # A landmark-only reference prevents the whole map becoming a backdrop.
    # This is a crop of real source pixels, not a generated replacement.
    crop = config.get("reference_crop")
    if crop is not None:
        if len(crop) != 4 or not (0 <= crop[0] < crop[2] <= 1 and 0 <= crop[1] < crop[3] <= 1):
            raise ValueError("Invalid reference crop")
        cropped = out / f"{shot}-{attempt}-reference.png"
        out.mkdir(parents=True, exist_ok=True)
        buffer = io.BytesIO()
        with Image.open(parent) as image:
            image.crop(tuple(round(v * (image.width if i % 2 == 0 else image.height))
                             for i, v in enumerate(crop))).save(buffer, format="PNG")
        if cropped.exists() and cropped.read_bytes() != buffer.getvalue():
            raise ValueError("Reference crop changed; use a new attempt number")
        if not cropped.exists():
            cropped.write_bytes(buffer.getvalue())
        roles = [{"role": "parent-crop", "path": str(cropped), "sha256": sha(cropped),
                  "original_sha256": sha(parent), "crop": crop}]
    if parent != SOURCE:
        roles.append({"role": "world-style", "path": str(SOURCE), "sha256": sha(SOURCE)})
    arguments = _edit_args_for(_resolve_edit_model(None, MODEL), config["prompt"], "parent")
    arguments.pop("image_urls")
    arguments.update(num_images=1, seed=config["seed"], aspect_ratio="16:9", resolution="2K",
                     output_format="png", enable_web_search=False, limit_generations=True)
    payload = {"model": MODEL, "arguments": arguments, "inputs": roles,
               "source": spec["source"], "click": spec["click"], "title": spec["title"]}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return {**payload, "id": f"{shot}-{attempt}", "fingerprint": digest}


def reserve_price(payload: dict) -> Decimal:
    rows = [p for p in payload["prices"] if p["endpoint_id"] == MODEL]
    if len(rows) != 1 or rows[0]["currency"] != "USD" or rows[0]["unit"] not in {"image", "images"}:
        raise ValueError("Unknown pricing contract; refusing generation")
    return max(Decimal(".25"), money(rows[0]["unit_price"]) * Decimal("1.5")).quantize(Decimal(".01"), rounding=ROUND_CEILING)


async def run(item: dict, out: Path) -> dict:
    if os.environ.get("CONNECTED_DEMO") != "1":
        raise ValueError("Paid demo disabled; set CONNECTED_DEMO=1")
    load_dotenv(BACKEND / ".env")
    if os.environ.get("MOCK_PROVIDERS", "").lower() in {"1", "true"}:
        raise ValueError("Mock images are not visual evidence")
    key = os.environ.get("FAL_KEY")
    if not key:
        raise ValueError("FAL_KEY missing")
    auth = {"Authorization": f"Key {key}"}
    path = out / f"{item['id']}-receipt.json"
    previous = json.loads(path.read_text()) if path.exists() else None
    if previous and previous["fingerprint"] != item["fingerprint"]:
        raise ValueError("Shot changed; use an explicitly numbered new attempt")
    row = previous or item.copy()
    with Ledger(out / "ledger.json", CAP) as ledger:
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
            cell = ledger.cells.get(item["fingerprint"])
            if cell is None:
                response = await client.get("https://api.fal.ai/v1/models/pricing", params={"endpoint_id": MODEL}, headers=auth)
                response.raise_for_status()
                amount = reserve_price(response.json())
                if ledger.total + amount > CAP:
                    raise ValueError("Demo budget exhausted before uploads")
                row["pricing"] = {"checked_at": datetime.now(UTC).isoformat(), "raw": response.json()}
                import fal_client
                urls = [await fal_client.upload_file_async(Path(ref["path"])) for ref in item["inputs"]]
            else:
                amount = money(cell["reserved_usd"])
                urls = []
            def update(current):
                row.update(state=current["state"], request_id=current.get("request_id"), reserved_usd=current["reserved_usd"])
                atomic_json(path, row)
            started = time.monotonic()
            cell = await generate_cell(client, auth, ledger, item["fingerprint"], MODEL,
                                       {**item["arguments"], "image_urls": urls}, amount, on_update=update)
            output = out / f"{item['id']}.png"
            if not output.exists():
                images = cell["result"].get("images", [])
                if len(images) != 1:
                    raise ValueError("Expected exactly one returned image")
                response = await client.get(images[0]["url"], follow_redirects=True)
                response.raise_for_status()
                part = output.with_suffix(".part")
                part.write_bytes(response.content)
                with Image.open(part) as image:
                    image.verify()
                part.replace(output)
            if row.get("output_sha256") and row["output_sha256"] != sha(output):
                raise ValueError("Frozen output bytes changed")
            with Image.open(output) as image:
                size = image.size
            row.update(state="complete", output=output.name, output_sha256=sha(output), size=size,
                       request_id=cell["request_id"], reserved_total_usd=str(ledger.total),
                       reported_cost_usd=None, raw_description=cell["result"].get("description"))
            row.setdefault("elapsed_seconds", round(time.monotonic() - started, 3))
            atomic_json(path, row)
            print(json.dumps({"id": item["id"], "output": str(output), "reserved_usd": str(ledger.total), "cached": previous is not None}), flush=True)
            return row


def review(out: Path, item: dict, verdict: str, notes: str) -> None:
    path = out / f"{item['id']}-receipt.json"
    row = json.loads(path.read_text())
    if row["fingerprint"] != item["fingerprint"] or row["output_sha256"] != sha(out / row["output"]):
        raise ValueError("Review must bind to current output bytes")
    if not notes.strip():
        raise ValueError("A visual review note is required")
    row["review"] = {"accepted": verdict == "accept", "notes": notes, "reviewer": "assistant visual inspection",
                     "not_a_geometry_guarantee": True}
    atomic_json(path, row)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot")
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--out", type=Path, default=OUT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--review", choices=["accept", "reject"])
    parser.add_argument("--notes", default="")
    args = parser.parse_args()
    item = prepare(args.shot, args.attempt, json.loads(PLAN.read_text()), args.out)
    if args.run:
        asyncio.run(run(item, args.out))
    elif args.review:
        review(args.out, item, args.review, args.notes)
    else:
        print(json.dumps(item, indent=2))
