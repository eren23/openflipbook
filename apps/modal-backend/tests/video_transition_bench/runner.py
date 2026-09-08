"""Six saved-frame transitions, at most $2 reserved, with no submit retries.

Dry-run: python -m tests.video_transition_bench.runner --assets-root /path/to/backend
Paid: add --run and H3_TRANSITION_PILOT=1. Existing queue IDs resume by GET only.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import hashlib
import json
import os
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv

from providers.video import DESCENT_ANIMATE_MODEL, H3_MAX_MODEL, descent_arguments

BACKEND = Path(__file__).resolve().parents[2]
CASES = ("fishing_lighthouse", "oasis_citadel", "harbor_lighthouse")
MODELS = (H3_MAX_MODEL, DESCENT_ANIMATE_MODEL)
CAP = Decimal("2.00")
DURATION = 6


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def money(value: object) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite() or result <= 0:
        raise ValueError("Invalid price or reservation")
    return result


class Ledger:
    """A separate lock inode protects atomic replacements across processes."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = None
        self.cells: dict = {}

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = self.path.with_suffix(".lock").open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                data = json.loads(self.path.read_text())
                if data["cap_usd"] != str(CAP):
                    raise ValueError("Unexpected pilot cap; reconcile the ledger")
                self.cells = data["cells"]
                if not isinstance(self.cells, dict) or self.total > CAP:
                    raise ValueError("Invalid pilot ledger")
            elif list(self.path.parent.glob("*.mp4")) or list(
                self.path.parent.glob("*-receipt.json")
            ):
                raise ValueError("Receipts exist without a ledger; reconcile spend first")
            self.save()
            return self
        except BaseException:
            self.lock.close()
            raise

    def __exit__(self, *_args):
        self.lock.close()

    @property
    def total(self) -> Decimal:
        return sum((money(c["reserved_usd"]) for c in self.cells.values()), Decimal(0))

    def save(self) -> None:
        atomic_json(self.path, {"cap_usd": str(CAP), "cells": self.cells})

    def reserve(self, key: str, amount: Decimal) -> dict:
        if key in self.cells:
            raise RuntimeError("A submitted cell cannot be submitted again")
        amount = money(amount)
        if self.total + amount > CAP:
            raise RuntimeError("Pilot budget exhausted; no request submitted")
        self.cells[key] = {"reserved_usd": str(amount), "state": "reserved"}
        self.save()
        return self.cells[key]


def fingerprint(source: bytes, destination: bytes, model: str, arguments: dict) -> str:
    # URL lifetimes are irrelevant; exact source bytes and effective settings are not.
    settings = {k: v for k, v in arguments.items() if k not in {"image_url", "end_image_url"}}
    return hashlib.sha256(
        json.dumps(
            {
                "model": model,
                "settings": settings,
                "source": hashlib.sha256(source).hexdigest(),
                "destination": hashlib.sha256(destination).hexdigest(),
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


def queue_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.netloc != "queue.fal.run":
        raise ValueError("Unexpected queue URL; refusing to forward credentials")
    return value


async def quote(client: httpx.AsyncClient, auth: dict) -> tuple[dict, dict]:
    response = await client.get(
        "https://api.fal.ai/v1/models/pricing",
        params={"endpoint_id": ",".join(MODELS)},
        headers=auth,
    )
    response.raise_for_status()
    raw = response.json()
    rates = {}
    for row in raw["prices"]:
        if row["endpoint_id"] not in MODELS:
            continue
        if row["currency"] != "USD" or row["unit"] not in {"second", "seconds"}:
            raise ValueError("Unknown billing units; no generation permitted")
        rates[row["endpoint_id"]] = money(row["unit_price"])
    if set(rates) != set(MODELS):
        raise ValueError("Missing live model price; no generation permitted")
    # Endpoint prices can describe the cheapest resolution; reserve at least
    # the documented rate for our selected resolution, including promo expiry.
    h3_floor = (
        Decimal(".02") if datetime.now(UTC).date().isoformat() < "2026-09-14" else Decimal(".08")
    )
    rates[H3_MAX_MODEL] = max(rates[H3_MAX_MODEL], h3_floor)
    rates[DESCENT_ANIMATE_MODEL] = max(rates[DESCENT_ANIMATE_MODEL], Decimal(".06"))
    return {k: v * DURATION for k, v in rates.items()}, raw


async def generate_cell(
    client: httpx.AsyncClient,
    auth: dict,
    ledger: Ledger,
    key: str,
    model: str,
    arguments: dict,
    amount: Decimal,
) -> dict:
    cell = ledger.cells.get(key)
    if cell and cell.get("result"):
        return cell
    if cell is None:
        cell = ledger.reserve(key, amount)
        # Raw httpx has no automatic POST retries (fal-client's submit does).
        response = await client.post(f"https://queue.fal.run/{model}", json=arguments, headers=auth)
        response.raise_for_status()
        job = response.json()
        cell.update(
            request_id=job["request_id"],
            status_url=queue_url(job["status_url"]),
            response_url=queue_url(job["response_url"]),
            state="submitted",
        )
        ledger.save()
    if not cell.get("request_id"):
        raise RuntimeError("Earlier submission is ambiguous; no automatic resubmission")
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        response = await client.get(queue_url(cell["status_url"]), headers=auth)
        response.raise_for_status()
        status = response.json()["status"]
        if status == "COMPLETED":
            response = await client.get(queue_url(cell["response_url"]), headers=auth)
            response.raise_for_status()
            cell.update(result=response.json(), state="complete")
            ledger.save()
            return cell
        if status not in {"IN_QUEUE", "IN_PROGRESS"}:
            raise RuntimeError(f"Generation ended with status {status}")
        await asyncio.sleep(2)
    raise TimeoutError("Polling deadline reached; the existing job can be resumed")


async def billing_report(client: httpx.AsyncClient, auth: dict, results: list[dict]) -> dict:
    ids = {row["request_id"] for row in results if row.get("request_id")}
    if not ids:
        return {"status": "unavailable"}
    try:
        response = await client.get(
            "https://api.fal.ai/v1/models/billing-events",
            params={"request_id": ",".join(sorted(ids)), "limit": 100},
            headers=auth,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("has_more"):
            return {"status": "incomplete"}
        totals: dict[str, Decimal] = {}
        for event in payload["billing_events"]:
            if event["request_id"] not in ids:
                continue
            cost = Decimal(str(event["cost_total"]))
            if not cost.is_finite() or cost < 0:
                raise ValueError("Invalid reported cost")
            totals[event["request_id"]] = totals.get(event["request_id"], Decimal(0)) + cost
        return {
            "status": "complete" if set(totals) == ids else "pending",
            "costs_usd": {key: str(value) for key, value in totals.items()},
        }
    except (httpx.HTTPError, ValueError, KeyError, TypeError, InvalidOperation):
        return {"status": "unavailable"}


def audit_frames(video: Path) -> dict:
    metadata = json.loads(
        subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(video)]
        )
    )
    stream = next(s for s in metadata["streams"] if s["codec_type"] == "video")
    duration = float(metadata["format"]["duration"])
    for index, fraction in enumerate((0, 0.25, 0.5, 0.75, 1)):
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                str(max(0, duration - 0.06) * fraction),
                "-i",
                str(video),
                "-frames:v",
                "1",
                str(video.with_name(f"{video.stem}-frame-{index}.jpg")),
            ],
            check=True,
        )
    return {
        "width": stream["width"],
        "height": stream["height"],
        "duration_seconds": duration,
        "fps": stream["r_frame_rate"],
    }


def input_cells(assets_root: Path) -> list[dict]:
    fixtures = assets_root / "tests/click_bench/fixtures"
    cases = json.loads((fixtures / "v1.json").read_text())["cases"]
    cells = []
    for case_id in CASES:
        case = next(c for c in cases if c["case_id"] == case_id)
        source = fixtures / case["image_path"]
        destination = (
            assets_root
            / "tests/continuity_bench/reports/place-identity-pilot"
            / f"{case_id}-enter-baseline.jpg"
        )
        if not destination.is_file():
            destination = (
                BACKEND / "tests/video_transition_bench/fixtures" / f"{case_id}-destination.jpg"
            )
        for path in (source, destination):
            if not path.is_file():
                raise ValueError(
                    f"Saved input missing: {path}. No still-image regeneration is allowed."
                )
        prompt = (
            f"One continuous camera move from the map into {case['alternates'][0]}, "
            "ending at the supplied destination image. Preserve landmarks, colors and drawing style "
            "throughout. No cuts, fades, dissolves, extra buildings, titles, dialogue or music."
        )
        for model in MODELS:
            arguments = descent_arguments(model, "source", "destination", prompt, DURATION)
            if model == DESCENT_ANIMATE_MODEL:
                arguments.update(duration=6, resolution="1080p", fps=24)
            cells.append(
                {
                    "case": case_id,
                    "model": model,
                    "source": source,
                    "destination": destination,
                    "arguments": arguments,
                }
            )
    return cells


async def run(args: argparse.Namespace) -> None:
    cells = input_cells(args.assets_root)
    if not args.run:
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "cap_usd": str(CAP),
                    "cells": [
                        {**c, "source": str(c["source"]), "destination": str(c["destination"])}
                        for c in cells
                    ],
                },
                indent=2,
            )
        )
        return
    if os.environ.get("H3_TRANSITION_PILOT") != "1":
        raise ValueError("Paid pilot disabled; set H3_TRANSITION_PILOT=1 explicitly")
    load_dotenv(args.assets_root / ".env")
    from providers import mock
    from providers._common import to_fal_url

    if mock.on():
        raise ValueError("Mock mode is not a visual-quality pilot")
    key = os.environ.get("FAL_KEY")
    if not key:
        raise ValueError("FAL_KEY is not set")
    auth = {"Authorization": f"Key {key}"}
    with Ledger(args.out / "ledger.json") as ledger:
        async with httpx.AsyncClient(timeout=60) as client:
            prices, raw_prices = await quote(client, auth)
            atomic_json(
                args.out / "pricing.json",
                {
                    "checked_at": datetime.now(UTC).isoformat(),
                    "raw": raw_prices,
                    "reserved_per_cell": {k: str(v) for k, v in prices.items()},
                },
            )
            results = []
            for item in cells:
                source, destination = item["source"].read_bytes(), item["destination"].read_bytes()
                arguments, model = dict(item["arguments"]), item["model"]
                digest = fingerprint(source, destination, model, arguments)
                stem = f"{item['case']}-{'h3' if model == H3_MAX_MODEL else 'ltx'}-{digest[:10]}"
                row = {
                    "case": item["case"],
                    "model": model,
                    "fingerprint": digest,
                    "complete": False,
                    "visual_verdict": "unreviewed",
                    "reported_cost_usd": None,
                    "settings": item["arguments"],
                    "source_sha256": hashlib.sha256(source).hexdigest(),
                    "destination_sha256": hashlib.sha256(destination).hexdigest(),
                }
                started = time.monotonic()
                try:
                    if digest not in ledger.cells:
                        if ledger.total + prices[model] > CAP:
                            raise RuntimeError("Pilot budget exhausted; no upload or generation")
                        arguments["image_url"] = await to_fal_url(
                            "data:image/jpeg;base64," + base64.b64encode(source).decode()
                        )
                        arguments["end_image_url"] = await to_fal_url(
                            "data:image/jpeg;base64," + base64.b64encode(destination).decode()
                        )
                    cell = await generate_cell(
                        client, auth, ledger, digest, model, arguments, prices[model]
                    )
                    output = args.out / f"{stem}.mp4"
                    if not output.exists():
                        response = await client.get(cell["result"]["video"]["url"])
                        response.raise_for_status()
                        temp = output.with_suffix(".part")
                        temp.write_bytes(response.content)
                        os.replace(temp, output)
                    metadata = audit_frames(output)
                    row.update(
                        complete=True,
                        request_id=cell["request_id"],
                        reserved_usd=cell["reserved_usd"],
                        output=output.name,
                        video_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                        metadata=metadata,
                        expanded_prompt=cell["result"].get("expanded_prompt"),
                        timings=cell["result"].get("timings"),
                    )
                except Exception as error:
                    row["error"] = str(error)[:300]
                    if digest in ledger.cells:
                        row["reserved_usd"] = ledger.cells[digest]["reserved_usd"]
                        row["request_id"] = ledger.cells[digest].get("request_id")
                row["elapsed_seconds"] = round(time.monotonic() - started, 3)
                # A cached rerun must preserve the original latency measurement.
                receipt = args.out / f"{stem}-receipt.json"
                if receipt.exists() and row["complete"]:
                    previous = json.loads(receipt.read_text())
                    if previous.get("complete"):
                        row = previous
                atomic_json(receipt, row)
                results.append(row)
                atomic_json(
                    args.out / "summary.json",
                    {
                        "complete": all(r["complete"] for r in results) and len(results) == 6,
                        "reserved_usd": str(ledger.total),
                        "cap_usd": str(CAP),
                        "promotion": False,
                        "results": results,
                    },
                )
                print(json.dumps(row), flush=True)
            billing = await billing_report(client, auth, results)
            for row in results:
                row["reported_cost_usd"] = billing.get("costs_usd", {}).get(row.get("request_id"))
                stem = f"{row['case']}-{'h3' if row['model'] == H3_MAX_MODEL else 'ltx'}-{row['fingerprint'][:10]}"
                atomic_json(args.out / f"{stem}-receipt.json", row)
            atomic_json(
                args.out / "summary.json",
                {
                    "complete": len(results) == 6 and all(row["complete"] for row in results),
                    "reserved_usd": str(ledger.total),
                    "cap_usd": str(CAP),
                    "promotion": False,
                    "billing": billing,
                    "results": results,
                },
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-root", type=Path, default=BACKEND)
    parser.add_argument(
        "--out", type=Path, default=BACKEND / "tests/video_transition_bench/reports"
    )
    parser.add_argument("--run", action="store_true")
    asyncio.run(run(parser.parse_args()))
