"""Offline by default. Paid: SPATIAL_VIDEO_PILOT=1 python -m
tests.video_transition_bench.controlled_runner --run. Fixed $3 cumulative reservation cap.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import time
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal
from pathlib import Path

import httpx
from dotenv import load_dotenv

from . import controlled_assets as assets
from .runner import BACKEND, Ledger, atomic_json, billing_report, generate_cell, money

CAP = Decimal("3.00")
OUT = BACKEND / "tests/video_transition_bench/reports/controlled-lighthouse"
STRUCTURAL = "fal-ai/ltx-2.3-quality/reference-video-to-video"
FAST = "fal-ai/ltx-2.3/image-to-video/fast"
PROMPT = (
    "One continuous camera reframe toward the Crystal Lighthouse on the LEFT of this map. "
    "Keep the entire floating crystal, stone tower and base visible throughout. "
    "Preserve the exact architecture, landmark positions, lettering, palette and illustrated style. "
    "Only subtle water motion may be added. End on the supplied close-up. "
    "No new viewpoint, 3D dive, new buildings, cuts, fades, dissolves, titles or music."
)
NEGATIVE = "warped architecture, replaced landmarks, flicker, blur, distortion, added text"


def configurations() -> list[dict]:
    rows = []
    for seed in (101, 202):
        for strength in (0.35, 0.60):
            rows.append(
                {
                    "id": f"structural-{int(strength * 100)}-{seed}",
                    "model": STRUCTURAL,
                    "label": f"Structural / denoise {strength:.2f} / seed {seed}",
                    "arguments": {
                        "prompt": PROMPT,
                        "seed": seed,
                        "strength": strength,
                        "video_strength": 0.9,
                        "skip_control_preprocess": True,
                        "preserve_original_video": True,
                        "num_frames": assets.FRAMES,
                        "frames_per_second": assets.FPS,
                        "resolution": {"width": assets.SIZE[0], "height": assets.SIZE[1]},
                        "num_inference_steps": 15,
                        "guidance_scale": 1,
                        "enable_prompt_expansion": False,
                        "generate_audio": False,
                        "enable_safety_checker": True,
                        "negative_prompt": NEGATIVE,
                        "video_quality": "high",
                        "video_write_mode": "balanced",
                    },
                    "files": {
                        "video_url": "reference.mp4",
                        "control_video_url": "edges.mp4",
                        "image_url": "first.png",
                        "mid_image_url": "middle.png",
                        "end_image_url": "last.png",
                    },
                }
            )
    rows.append(
        {
            "id": "fast-101",
            "model": FAST,
            "label": "Endpoint only / Fast / seed 101",
            "arguments": {
                "prompt": PROMPT,
                "seed": 101,
                "duration": 6,
                "resolution": "1080p",
                "fps": 24,
                "generate_audio": False,
                "aspect_ratio": "16:9",
            },
            "files": {"image_url": "fast-first.png", "end_image_url": "fast-last.png"},
        }
    )
    return rows


def fingerprint(item: dict, manifest: dict) -> str:
    payload = {
        "model": item["model"],
        "arguments": item["arguments"],
        "fixture": manifest["signature"],
        "files": {role: manifest["assets"][name] for role, name in item["files"].items()},
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()


def prices_from_payload(payload: dict) -> dict[str, Decimal]:
    rates = {}
    for row in payload["prices"]:
        model = row["endpoint_id"]
        if model not in (STRUCTURAL, FAST):
            continue
        allowed = {"megapixel", "megapixels"} if model == STRUCTURAL else {"second", "seconds"}
        if row["currency"] != "USD" or row["unit"] not in allowed or model in rates:
            raise ValueError("Unknown or ambiguous billing contract; no uploads or generation")
        rates[model] = money(row["unit_price"])
    if set(rates) != {STRUCTURAL, FAST}:
        raise ValueError("Missing live endpoint price; no generation")
    return rates


def reservation(item: dict, rates: dict[str, Decimal]) -> Decimal:
    if item["model"] == STRUCTURAL:
        params = item["arguments"]
        size = params["resolution"]
        units = (
            Decimal(size["width"] * size["height"] * params["num_frames"]) / 1_000_000
        ).to_integral_value(rounding=ROUND_CEILING)
        estimate = units * max(rates[STRUCTURAL], Decimal("0.0024075"))
        floor = Decimal("0.35")
    else:
        estimate = Decimal(item["arguments"]["duration"]) * max(rates[FAST], Decimal("0.06"))
        floor = Decimal("0.50")
    return max(floor, estimate * Decimal("1.25")).quantize(Decimal(".01"), rounding=ROUND_CEILING)


def geometry_verdict(observed: list[list[float]], aspect: float) -> dict:
    """Manually observed boxes use normalized content-image coordinates, not canvas pixels."""
    import math

    if len(observed) != 11 or not math.isfinite(aspect) or aspect <= 0:
        raise ValueError("Eleven observed boxes and a valid content aspect are required")
    errors = []
    for i, box in enumerate(observed):
        if len(box) != 4 or not all(math.isfinite(v) for v in box):
            raise ValueError("Invalid observed bounds")
        x, y, w, h = box
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > 1 or y + h > 1:
            raise ValueError("Landmark not fully visible inside content rectangle")
        ex, ey, ew, eh = assets.expected_box(i / 10)
        errors.extend(
            math.hypot((a - b) * aspect, c - d) / math.hypot(aspect, 1)
            for a, b, c, d in (
                (x, ex, y, ey),
                (x + w, ex + ew, y, ey),
                (x, ex, y + h, ey + eh),
                (x + w, ex + ew, y + h, ey + eh),
            )
        )
    return {
        "max_corner_error": max(errors),
        "threshold": 0.03,
        "sampled_geometry": "pass" if max(errors) <= 0.03 else "fail",
    }


def summary(out: Path, rows: list[dict], manifest: dict, ledger: Ledger | None = None) -> dict:
    receipts = []
    for item in rows:
        path = out / f"{item['id']}-receipt.json"
        receipts.append(
            json.loads(path.read_text())
            if path.exists()
            else {
                "id": item["id"],
                "label": item["label"],
                "model": item["model"],
                "state": "not_submitted",
                "fingerprint": fingerprint(item, manifest),
                "arguments": item["arguments"],
                "visual_verdict": "unreviewed",
                "reported_cost_usd": None,
            }
        )
    result = {
        "version": 1,
        "cap_usd": str(CAP),
        "reserved_usd": str(ledger.total) if ledger else "0",
        "promotion": False,
        "fixture": manifest,
        "results": receipts,
        "complete": all(r.get("state") == "complete" for r in receipts),
    }
    atomic_json(out / "summary.json", result)
    return result


def record_review(out: Path, manifest: dict, review_path: Path) -> None:
    """Attach an offline audit to exact output bytes, without granting promotion."""
    review = json.loads(review_path.read_text())
    rows = configurations()
    entries = review["results"]
    if (
        not review.get("reviewer")
        or not review.get("method")
        or len(entries) != len(rows)
        or {entry["id"] for entry in entries} != {row["id"] for row in rows}
    ):
        raise ValueError("Review must identify its method, reviewer and all five configurations")
    with Ledger(out / "ledger.json", CAP) as ledger:
        updated = []
        for item in rows:
            entry = next(entry for entry in entries if entry["id"] == item["id"])
            receipt = json.loads((out / f"{item['id']}-receipt.json").read_text())
            if (
                receipt.get("state") != "complete"
                or receipt["fingerprint"] != fingerprint(item, manifest)
                or entry["output_sha256"] != receipt["metadata"]["sha256"]
                or assets.sha(out / receipt["output"]) != entry["output_sha256"]
            ):
                raise ValueError("Review does not match the completed output")
            if not isinstance(entry.get("visual_verdict"), str) or not entry["visual_verdict"]:
                raise ValueError("Explicit visual verdict required")
            geometry = {"sampled_geometry": "unverified", "threshold": 0.03}
            if entry.get("observed_boxes") is not None:
                width, height = manifest["source_size"]
                geometry = geometry_verdict(entry["observed_boxes"], width / height)
            receipt.update(
                visual_verdict=entry["visual_verdict"],
                geometry=geometry,
                review={"reviewer": review["reviewer"], "method": review["method"], **entry},
            )
            updated.append(receipt)
        # Validate the whole audit before changing any receipts.
        report_path = out / "summary.json"
        billing = (
            json.loads(report_path.read_text()).get("billing") if report_path.exists() else None
        )
        for receipt in updated:
            atomic_json(out / f"{receipt['id']}-receipt.json", receipt)
        report = summary(out, rows, manifest, ledger)
        if billing is not None:
            report["billing"] = billing
            atomic_json(report_path, report)


async def paid_run(out: Path, manifest: dict) -> None:
    if os.environ.get("SPATIAL_VIDEO_PILOT") != "1":
        raise ValueError("Paid pilot disabled; set SPATIAL_VIDEO_PILOT=1 explicitly")
    load_dotenv(BACKEND / ".env")
    from providers import mock

    if mock.on():
        raise ValueError("Mock mode is not a paid visual study")
    key = os.environ.get("FAL_KEY")
    if not key:
        raise ValueError("FAL_KEY is not set")
    auth = {"Authorization": f"Key {key}"}
    rows = configurations()
    with Ledger(out / "ledger.json", CAP) as ledger:
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
            # Completed cached runs need neither pricing nor upload/queue calls.
            pending = [r for r in rows if fingerprint(r, manifest) not in ledger.cells]
            rates = {}
            if pending:
                response = await client.get(
                    "https://api.fal.ai/v1/models/pricing",
                    params={"endpoint_id": f"{STRUCTURAL},{FAST}"},
                    headers=auth,
                )
                response.raise_for_status()
                raw = response.json()
                rates = prices_from_payload(raw)
                quotes = {r["id"]: reservation(r, rates) for r in pending}
                if ledger.total + sum(quotes.values()) > CAP:
                    raise ValueError("Planned batch exceeds $3; no upload or generation")
                atomic_json(
                    out / "pricing.json",
                    {
                        "checked_at": datetime.now(UTC).isoformat(),
                        "raw": raw,
                        "reservations": {k: str(v) for k, v in quotes.items()},
                    },
                )
            uploaded = {}
            for item in rows:
                digest = fingerprint(item, manifest)
                receipt_path = out / f"{item['id']}-receipt.json"
                previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
                if previous and previous.get("fingerprint") != digest:
                    raise ValueError("Receipt fingerprint changed; refusing to overwrite evidence")
                receipt = previous or {
                    "id": item["id"],
                    "label": item["label"],
                    "model": item["model"],
                    "fingerprint": digest,
                    "arguments": item["arguments"],
                    "asset_hashes": {k: manifest["assets"][v] for k, v in item["files"].items()},
                    "visual_verdict": "unreviewed",
                    "reported_cost_usd": None,
                }
                started = time.monotonic()

                def update(cell: dict, receipt=receipt, receipt_path=receipt_path) -> None:
                    receipt.update(
                        state=cell["state"],
                        reserved_usd=cell["reserved_usd"],
                        request_id=cell.get("request_id"),
                    )
                    atomic_json(receipt_path, receipt)
                    summary(out, rows, manifest, ledger)

                try:
                    arguments = dict(item["arguments"])
                    if digest not in ledger.cells:
                        import fal_client

                        for role, name in item["files"].items():
                            if name not in uploaded:
                                uploaded[name] = await fal_client.upload_file_async(
                                    out / "inputs" / name
                                )
                            arguments[role] = uploaded[name]
                    amount = (
                        money(ledger.cells[digest]["reserved_usd"])
                        if digest in ledger.cells
                        else reservation(item, rates)
                    )
                    cell = await generate_cell(
                        client,
                        auth,
                        ledger,
                        digest,
                        item["model"],
                        arguments,
                        amount,
                        on_update=update,
                    )
                    output = out / f"{item['id']}.mp4"
                    if not output.exists():
                        # Media requests never receive the provider Authorization header.
                        response = await client.get(
                            cell["result"]["video"]["url"], follow_redirects=True
                        )
                        response.raise_for_status()
                        partial = output.with_suffix(".part")
                        partial.write_bytes(response.content)
                        partial.replace(output)
                    if "metadata" not in receipt:
                        receipt["metadata"] = assets.inspect_video(output)
                    elif assets.sha(output) != receipt["metadata"]["sha256"]:
                        raise ValueError("Cached video bytes changed")
                    receipt.update(
                        state="complete",
                        output=output.name,
                        request_id=cell["request_id"],
                        reserved_usd=cell["reserved_usd"],
                        effective_prompt=cell["result"].get("prompt")
                        or cell["result"].get("expanded_prompt"),
                        returned_seed=cell["result"].get("seed"),
                    )
                    receipt.setdefault("elapsed_seconds", round(time.monotonic() - started, 3))
                    receipt.pop("error", None)
                except Exception as exc:
                    cell = ledger.cells.get(digest, {})
                    receipt.update(
                        state="stopped",
                        error=f"{type(exc).__name__}: {str(exc)[:300]}",
                        reserved_usd=cell.get("reserved_usd"),
                        request_id=cell.get("request_id"),
                    )
                    atomic_json(receipt_path, receipt)
                    summary(out, rows, manifest, ledger)
                    raise
                atomic_json(receipt_path, receipt)
                summary(out, rows, manifest, ledger)
                print(
                    json.dumps(
                        {
                            "id": item["id"],
                            "state": receipt["state"],
                            "reserved_usd": str(ledger.total),
                        }
                    ),
                    flush=True,
                )
            report = summary(out, rows, manifest, ledger)
            billing = await billing_report(client, auth, report["results"])
            for receipt in report["results"]:
                receipt["reported_cost_usd"] = billing.get("costs_usd", {}).get(
                    receipt.get("request_id")
                )
                atomic_json(out / f"{receipt['id']}-receipt.json", receipt)
            report = summary(out, rows, manifest, ledger)
            report["billing"] = billing
            atomic_json(out / "summary.json", report)


async def run(args: argparse.Namespace) -> None:
    manifest = assets.prepare(args.out / "inputs")
    if getattr(args, "review", None):
        record_review(args.out, manifest, args.review)
    elif args.run:
        await paid_run(args.out, manifest)
    else:
        if not (args.out / "ledger.json").exists():
            summary(args.out, configurations(), manifest)
        print(
            json.dumps({"dry_run": True, "cap_usd": str(CAP), "cells": configurations()}, indent=2)
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--review", type=Path, help="Attach a hash-bound offline review JSON")
    asyncio.run(run(parser.parse_args()))
