"""Broad image-model bakeoff (research): which model best renders our maps?

Runs a roster of fal + OpenRouter image models on the canonical layout scenes WITH
the geometry layout clause, Gemini-judges layout fidelity (the validated axis,
reused from world_bench), and saves every image so label legibility + medium can be
eyeballed. Per-model failures are logged and skipped (never silently dropped).

Run from the backend (so imports + .env resolve):
    cd apps/modal-backend && PYTHONPATH=. .venv/bin/python <this>.py            # full
    cd apps/modal-backend && PYTHONPATH=. SMOKE=1 .venv/bin/python <this>.py     # cheap path check

Gotcha-guards (memory): judge = Gemini (qwen 429s); the .env already pins
OPENROUTER_VLM_MODEL=gemini and FAL_IMAGE_MODEL_BALANCED=nano-banana-pro.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import fal_client
import httpx

OUT = Path(__file__).resolve().parent / "out"
FAL_SIZE = {  # aspect -> fal image_size preset (seedream / gpt-image-2)
    "16:9": "landscape_16_9", "9:16": "portrait_16_9", "1:1": "square_hd",
    "4:3": "landscape_4_3", "3:4": "portrait_4_3",
}

# roster of text-to-image candidates: the incumbents + the field the user asked for.
ROSTER: list[dict[str, str]] = [
    {"name": "nano-banana-pro", "provider": "fal", "slug": "fal-ai/nano-banana-pro", "arg": "aspect"},
    {"name": "seedream-v4", "provider": "fal", "slug": "fal-ai/bytedance/seedream/v4/text-to-image", "arg": "size"},
    {"name": "gpt-image-2", "provider": "fal", "slug": "openai/gpt-image-2", "arg": "size"},
    {"name": "recraft-v4.1-utility", "provider": "openrouter", "slug": "recraft/recraft-v4.1-utility", "arg": ""},
    {"name": "recraft-v4.1-pro", "provider": "openrouter", "slug": "recraft/recraft-v4.1-pro", "arg": ""},
    {"name": "riverflow-v2.5-fast", "provider": "openrouter", "slug": "sourceful/riverflow-v2.5-fast", "arg": ""},
    {"name": "riverflow-v2.5-pro", "provider": "openrouter", "slug": "sourceful/riverflow-v2.5-pro", "arg": ""},
]
# Smoke roster: prove both provider paths at ~$0 (Riverflow :free) + ~$0.14 (fal).
SMOKE_ROSTER: list[dict[str, str]] = [
    {"name": "riverflow-v2.5-fast", "provider": "openrouter", "slug": "sourceful/riverflow-v2.5-fast", "arg": ""},
]


def _load_env() -> None:
    env = Path.cwd() / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


async def _gen_fal(model: dict[str, str], prompt: str, aspect: str) -> bytes:
    args: dict[str, Any] = {"prompt": prompt}
    if model["arg"] == "size":
        args["image_size"] = FAL_SIZE.get(aspect, "landscape_16_9")
    else:
        args["aspect_ratio"] = aspect
    res = await fal_client.subscribe_async(model["slug"], arguments=args)
    url = res["images"][0]["url"]
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    async with httpx.AsyncClient(timeout=120) as c:
        return (await c.get(url)).content


async def _gen_openrouter(model: dict[str, str], prompt: str, aspect: str) -> bytes:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"]
    )
    resp = await client.chat.completions.create(
        model=model["slug"],
        messages=[{"role": "user", "content": prompt}],
        extra_body={"modalities": ["image"], "image_config": {"aspect_ratio": aspect}},
    )
    msg = resp.model_dump()["choices"][0]["message"]
    images = msg.get("images") or []
    if not images:
        raise RuntimeError(f"{model['name']}: no image in response (content={str(msg.get('content'))[:120]})")
    url = images[0]["image_url"]["url"]
    return base64.b64decode(url.split(",", 1)[1])


@dataclass
class Cell:
    model: str
    scene: str
    fidelity: float | None
    error: str | None
    image: str | None


async def run() -> None:
    from providers import geometry_prompt
    from tests.world_bench._score import aggregate_layout_fidelity, judge_layout_fidelity

    smoke = os.environ.get("SMOKE") == "1"
    roster = SMOKE_ROSTER if smoke else ROSTER
    fixture = json.loads(
        (Path.cwd() / "tests/world_bench/fixtures/layout/scenes.json").read_text()
    )
    aspect = fixture.get("aspect_ratio", "16:9")
    scenes = fixture["scenes"][:1] if smoke else fixture["scenes"]
    OUT.mkdir(parents=True, exist_ok=True)

    cells: list[Cell] = []
    for m in roster:
        for sc in scenes:
            clause = geometry_prompt.layout_constraints(sc["expected"])
            prompt = f"{sc['prompt']}\n\n{clause}"
            tag = f"{m['name']}__{sc['name']}"
            try:
                gen = _gen_fal if m["provider"] == "fal" else _gen_openrouter
                img = await gen(m, prompt, aspect)
                (OUT / f"{tag}.jpg").write_bytes(img)
                fid = aggregate_layout_fidelity(await judge_layout_fidelity(img, sc["expected"]))
                cells.append(Cell(m["name"], sc["name"], round(fid.score, 3), None, f"{tag}.jpg"))
                print(f"  ok   {tag:42} fidelity={fid.score:.3f}")
            except Exception as exc:  # log + skip; never silently drop a candidate
                cells.append(Cell(m["name"], sc["name"], None, f"{type(exc).__name__}: {exc}", None))
                print(f"  SKIP {tag:42} {type(exc).__name__}: {str(exc)[:80]}")

    # rank by mean fidelity over the model's successful scenes
    by_model: dict[str, list[float]] = {}
    for c in cells:
        if c.fidelity is not None:
            by_model.setdefault(c.model, []).append(c.fidelity)
    ranking = sorted(
        ((name, sum(v) / len(v)) for name, v in by_model.items()), key=lambda x: -x[1]
    )
    print("\n=== ranking (mean layout fidelity, WITH clause) ===")
    for name, mean in ranking:
        print(f"  {name:28} {mean:.3f}")
    failed = [c for c in cells if c.error]
    if failed:
        print(f"\n{len(failed)} cell(s) skipped:")
        for c in failed:
            print(f"  {c.model}/{c.scene}: {c.error}")

    report = {
        "mode": "smoke" if smoke else "full",
        "judge": os.environ.get("WORLD_BENCH_JUDGE_MODEL"),
        "ranking": [{"model": n, "mean_fidelity": round(m, 3)} for n, m in ranking],
        "cells": [asdict(c) for c in cells],
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print(f"\nwrote {OUT/'report.json'} + {len([c for c in cells if c.image])} images")


if __name__ == "__main__":
    _load_env()
    asyncio.run(run())
