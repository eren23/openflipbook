"""Local-only live pilot adapter. Real application handlers, durable $5 meter.

No calls on import. ARRIVAL_PILOT=1 python -m tests.continuity_bench.arrival_live
starts an isolated backend. Only the approved cases and model are allowed.
"""
from __future__ import annotations

import asyncio
import base64
import contextvars
import hashlib
import io
import json
import os
import secrets
from decimal import Decimal
from pathlib import Path

import httpx
from fastapi import Request
from PIL import Image

from tests.continuity_bench.arrival_audit import BACKEND, CASES, OUT, build
from tests.video_transition_bench.runner import Ledger, atomic_json, generate_cell

CAP = Decimal("5.00")
MODEL = "fal-ai/nano-banana-pro/edit"
LLM = "google/gemini-3.7-flash"
ACTIVE = contextvars.ContextVar("arrival_operation", default="")


def scrub(value):
    if isinstance(value, str) and value.startswith("data:"):
        return {"data_url_sha256": hashlib.sha256(value.encode()).hexdigest()}
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def llm_reservation(kwargs: dict) -> Decimal:
    """Conservative token bound; no remote image or unbounded output inputs."""
    if kwargs.get("model") != LLM or kwargs.get("stream"):
        raise ValueError("Unapproved model or streaming LLM request")
    count = len(json.dumps(scrub(kwargs), ensure_ascii=False).encode()) + 1024
    for message in kwargs.get("messages", []):
        content = message.get("content", [])
        for part in content if isinstance(content, list) else []:
            if part.get("type") == "image_url":
                url = part["image_url"]["url"]
                if not url.startswith("data:image/"):
                    raise ValueError("Cannot bound remote image token cost")
                with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as im:
                    if im.width * im.height > 4_500_000:
                        raise ValueError("Pilot image exceeds bounded dimensions")
                count += 40_000
    output = kwargs.get("max_tokens", 3000)
    if not isinstance(output, int) or not 0 < output <= 4000 or count > 200_000:
        raise ValueError("Unbounded pilot token request")
    # Routing is constrained to these maximum USD/million-token prices.
    return (Decimal(count) * Decimal(".00000075") + Decimal(output) * Decimal(".00000375")).quantize(Decimal(".000001"))


class Meter:
    def __init__(self, ledger: Ledger):
        self.ledger = ledger
        self.llm_lock = asyncio.Lock()

    def summary(self):
        return {"approved_cap_usd": str(self.ledger.cap), "reserved_usd": str(self.ledger.total),
                "calls": len(self.ledger.cells)}

    def install(self, *, image_calls: bool = True, max_llm_calls: int | None = None,
                image_operations: frozenset[str] | None = None):
        import fal_client

        from providers import llm

        client = llm._client()
        original = client.chat.completions.create

        async def create(**kwargs):
            if not ACTIVE.get():
                raise RuntimeError("No active approved pilot operation")
            kwargs.setdefault("max_tokens", 3000)
            amount = llm_reservation(kwargs)
            extra = dict(kwargs.get("extra_body") or {})
            extra["provider"] = {"max_price": {"prompt": .75, "completion": 3.75}}
            kwargs["extra_body"] = extra
            async with self.llm_lock:
                llm_calls = sum(c.get("kind") != "image" for c in self.ledger.cells.values())
                if max_llm_calls is not None and llm_calls >= max_llm_calls:
                    raise RuntimeError("Pilot call limit reached; no request submitted")
                key = f"{ACTIVE.get()}:llm:{len(self.ledger.cells)}"
                cell = self.ledger.reserve(key, amount)
                cell.update(kind="llm", operation=ACTIVE.get(), request=scrub(kwargs), initial_reservation_usd=str(amount))
                self.ledger.save()
                try:
                    response = await original(**kwargs)
                    payload = response.model_dump(mode="json")
                    cell.update(state="complete", request_id=response.id, response=payload)
                    usage = payload.get("usage") or {}
                    cost = usage.get("cost")
                    if cost is not None:
                        paid = Decimal(str(cost))
                        if not paid.is_finite() or paid < 0 or paid > amount:
                            raise RuntimeError("Reported cost exceeds reservation; stop pilot")
                        cell["reported_cost_usd"] = str(paid)
                        cell["reserved_usd"] = str(max(paid, Decimal(".000001")))
                    self.ledger.save()
                    print(json.dumps({"operation": ACTIVE.get(), "call": "llm", **self.summary()}), flush=True)
                    return response
                except Exception as exc:
                    cell.update(state="failed_or_uncertain", error=f"{type(exc).__name__}: {str(exc)[:300]}")
                    self.ledger.save()
                    # Do not let transport retries silently repeat an ambiguous submission.
                    raise RuntimeError("Metered LLM request failed; reservation retained") from exc

        client.chat.completions.create = create

        async def subscribe(model, *, arguments, **_kwargs):
            if not image_calls:
                raise RuntimeError("Image generation is disabled for this pilot")
            operation = ACTIVE.get()
            allowed = image_operations if image_operations is not None else {c["id"] for c in build()["cells"]}
            if model != MODEL or operation not in allowed:
                raise RuntimeError("Image request is outside the approved pilot")
            if arguments.get("num_images", 1) != 1 or arguments.get("resolution", "1K") == "4K" or arguments.get("enable_web_search"):
                raise ValueError("Unapproved image settings")
            # Fix output cardinality and preserve actual app prompts/reference order.
            arguments = {**arguments, "num_images": 1, "resolution": "1K", "output_format": "png", "enable_web_search": False, "limit_generations": True}
            key = f"{operation}:image"
            auth = {"Authorization": f"Key {os.environ['FAL_KEY']}"}
            async with httpx.AsyncClient(timeout=60, follow_redirects=False) as http:
                def update(cell):
                    cell.update(operation=operation, kind="image", model=model, arguments=arguments)
                    self.ledger.save()
                result = await generate_cell(http, auth, self.ledger, key, model, arguments, Decimal(".15"), on_update=update)
                print(json.dumps({"operation": operation, "call": "image", **self.summary()}), flush=True)
                return {**result["result"], "requestId": result["request_id"]}

        fal_client.subscribe_async = subscribe


async def serve():
    if os.environ.get("ARRIVAL_PILOT") != "1":
        raise RuntimeError("Explicit live-pilot opt-in required")
    from dotenv import load_dotenv
    load_dotenv(BACKEND / ".env")
    if any(os.environ.get(k, "").lower() in {"1", "true"} for k in ["MOCK_PROVIDERS", "WORLD_SEGMENT_BORDERS"]):
        raise RuntimeError("Mock providers or extra segmentation cannot run in this pilot")
    os.environ.update(WORLD_IDENTITY_STRICT="true", LLM_PROVIDER="openrouter",
                      LLM_BASE_URL="https://openrouter.ai/api/v1", LLM_VLM_MODEL=LLM,
                      LLM_TEXT_MODEL=LLM, OPENROUTER_VLM_MODEL=LLM, OPENROUTER_TEXT_MODEL=LLM,
                      CONTINUITY_BENCH_JUDGE_MODEL=LLM, WORLD_BENCH_JUDGE_MODEL=LLM,
                      OPENROUTER_ENABLE_WEB_SEARCH="false", WORLD_SEGMENT_BORDERS="false")
    async with httpx.AsyncClient(timeout=30) as http:
        price = await http.get("https://api.fal.ai/v1/models/pricing", params={"endpoint_id": MODEL}, headers={"Authorization": f"Key {os.environ['FAL_KEY']}"})
        price.raise_for_status()
        rows = price.json()["prices"]
        if len(rows) != 1 or rows[0]["currency"] != "USD" or rows[0]["unit"] not in {"image", "images"} or Decimal(str(rows[0]["unit_price"])) > Decimal(".15"):
            raise RuntimeError("Image pricing changed; stop before submission")
    atomic_json(OUT / "live-pricing.json", price.json())
    import uvicorn
    from fastapi.responses import JSONResponse

    from generate import fastapi_app

    token = secrets.token_hex(24)
    atomic_json(OUT / "control.json", {"token": token})
    Path(OUT / "control.json").chmod(0o600)
    active = ""
    with Ledger(OUT / "ledger.json", CAP) as ledger:
        meter = Meter(ledger)
        meter.install()

        @fastapi_app.post("/pilot/activate")
        async def activate(request: Request):
            nonlocal active
            if request.headers.get("x-pilot-token") != token:
                return JSONResponse({}, status_code=403)
            body = await request.json()
            value = body["operation"]
            allowed = {c["id"] for c in build()["cells"]} | {f"{c}-extract" for c in CASES}
            if value not in allowed:
                return JSONResponse({}, status_code=400)
            active = value
            policy = next((c["policy"] for c in build()["cells"] if c["id"] == value), "context_first")
            os.environ["WORLD_ARRIVAL_REFERENCE_MODE"] = policy
            return meter.summary()

        @fastapi_app.get("/pilot/status")
        async def status():
            return meter.summary()

        @fastapi_app.middleware("http")
        async def guard(request: Request, call_next):
            path = request.url.path
            if path.startswith("/pilot/"):
                return await call_next(request)
            if path not in {"/extract-entities", "/sse/generate", "/resolve-click"} or not active:
                return JSONResponse({"error": "Outside live arrival pilot"}, status_code=403)
            body = await request.json()
            if not str(body.get("session_id", "")).startswith("arrival-live-"):
                return JSONResponse({"error": "Isolated pilot sessions only"}, status_code=403)
            if path == "/sse/generate":
                if body.get("max_attempts") != 1 or body.get("image_model") != MODEL or body.get("arrival_intent") != "exterior" or not body.get("strict_world"):
                    return JSONResponse({"error": "Request differs from approved trial"}, status_code=400)
                existing = OUT / f"{active}-request.json"
                if existing.exists():
                    return JSONResponse({"error": "Trial already started; no resubmission"}, status_code=409)
                atomic_json(existing, scrub(body))
                ref = body["place_reference"]
                from generate import PlaceRenderReference
                from providers.place_identity import reference_crop
                raw = reference_crop(ref["image_data_url"], PlaceRenderReference(**ref).bbox)
                (OUT / f"{active}-runtime.png").write_bytes(raw)
            context_token = ACTIVE.set(active)
            try:
                return await call_next(request)
            finally:
                ACTIVE.reset(context_token)

        await uvicorn.Server(uvicorn.Config(fastapi_app, host="127.0.0.1", port=8001, log_level="warning")).serve()


if __name__ == "__main__":
    asyncio.run(serve())
