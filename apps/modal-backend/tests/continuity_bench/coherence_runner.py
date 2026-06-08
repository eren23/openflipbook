"""B3 — sub-part coherence A/B (the hard number for the B2 conditioning).

For each in-frame place on a real top-down map, ENTER it twice:
  - WITHOUT: a plain fresh generation (no region reference).
  - WITH:    the same prompt + the region crop as an in-context reference +
             the faithful-closer-view conditioning preamble (B2).
A VLM judge scores each entered image for how faithfully it CONTINUES the map
region it came from (same structures/colours/landmarks). Report the per-place
scores + the mean lift — i.e. does region-conditioning make an entered place a
recognisable zoom of its parent, or a fresh invention?

Paid (fal gens + judge calls). Reads the live session via the web API:
    cd apps/modal-backend && COHERENCE_BENCH_RUN=1 \
      COHERENCE_BENCH_SESSION=session_xxx \
      .venv/bin/python -m tests.continuity_bench.coherence_runner
or:  make eval-coherence   (set COHERENCE_BENCH_SESSION first)
The judge defaults to Gemini (qwen 429s — see memory project_qwen_ratelimit).
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from ._score import score_continuation

# The image-world frame a top-down map is seeded in (mirror of the TS
# MAP_IMAGE_FRAME / extract seed): world (x,y) ↦ image fraction (x/100, y/60).
_FRAME_W = 100.0
_FRAME_H = 60.0
# Region crop size per axis (mirror of lib/image-condition.ts cropRegion default).
_REGION_FRAC = 0.42
_REPORTS = Path(__file__).resolve().parent / "reports"


def _load_env() -> None:
    """Load apps/modal-backend/.env, force the balanced model to nano-banana-pro
    (the .env pins plain nano-banana — see memory project_fal_model_pin) and pin
    the judge to Gemini (the .env's qwen VLM rate-limits)."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("CONTINUITY_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


def crop_box(x_pct: float, y_pct: float, frac: float = _REGION_FRAC) -> tuple[float, float, float, float]:
    """Clamped frac-by-frac region centred on (x_pct, y_pct), in 0..1 — a pure
    mirror of lib/image-condition.ts cropBox (kept in lockstep for parity)."""
    w = min(max(frac, 0.0), 1.0)
    h = w
    x = min(max(x_pct - w / 2, 0.0), 1.0 - w)
    y = min(max(y_pct - h / 2, 0.0), 1.0 - h)
    return x, y, w, h


@dataclass(frozen=True)
class PlaceResult:
    name: str
    without_score: float
    with_score: float
    without_rationale: str
    with_rationale: str

    @property
    def lift(self) -> float:
        return round(self.with_score - self.without_score, 4)


async def _fetch_map_and_places(base: str, session: str, n: int) -> tuple[dict[str, Any], bytes, list[dict[str, Any]]]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        sess = (await client.get(f"{base}/api/sessions/{session}")).json()
        world = (await client.get(f"{base}/api/world/{session}/map")).json()
        root = next((node for node in sess["nodes"] if not node.get("parent_id")), sess["nodes"][0])
        map_bytes = (await client.get(root["image_url"])).content
    places = [
        e for e in world.get("entities", [])
        if e.get("kind") == "place"
        and 0.0 <= e["pos"]["x"] <= _FRAME_W
        and 0.0 <= e["pos"]["y"] <= _FRAME_H
    ]
    # Largest footprints first — the most prominent landmarks make the clearest test.
    places.sort(key=lambda e: e.get("footprint", {}).get("w", 0), reverse=True)
    return root, map_bytes, places[:n]


def _region_crop(map_bytes: bytes, place: dict[str, Any]) -> bytes:
    from PIL import Image

    img = Image.open(io.BytesIO(map_bytes)).convert("RGB")
    x_pct = place["pos"]["x"] / _FRAME_W
    y_pct = place["pos"]["y"] / _FRAME_H
    bx, by, bw, bh = crop_box(x_pct, y_pct)
    w, h = img.size
    crop = img.crop((round(bx * w), round(by * h), round((bx + bw) * w), round((by + bh) * h)))
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


async def _enter(prompt: str, aspect: str, model: str, ref_data_url: str | None) -> bytes:
    from providers import image as image_provider

    img = await image_provider.generate_image(
        prompt=prompt,
        aspect_ratio=aspect,
        model_override=model,
        reference_urls=[ref_data_url] if ref_data_url else None,
    )
    return img.jpeg_bytes


async def run_one(map_title: str, aspect: str, model: str, map_bytes: bytes, place: dict[str, Any]) -> PlaceResult:
    from providers import image as image_provider

    label = place.get("label", "this place")
    region = _region_crop(map_bytes, place)
    region_url = image_provider.encode_data_url(region)
    # Same base prompt for both arms — the only lever is the region ref + B2 preamble.
    base = f"A closer, ground-level view of {label}, a place within {map_title}."
    preamble = image_provider.conditioning_preamble(["region"], "place_scene")

    without_img = await _enter(base, aspect, model, None)
    with_img = await _enter(f"{preamble}\n\n{base}", aspect, model, region_url)

    without = await score_continuation(region, without_img)
    with_cond = await score_continuation(region, with_img)

    # Persist the artefacts for eyeballing.
    _REPORTS.mkdir(parents=True, exist_ok=True)
    stem = "".join(c if c.isalnum() else "_" for c in label)[:32]
    (_REPORTS / f"{stem}_region.jpg").write_bytes(region)
    (_REPORTS / f"{stem}_without.jpg").write_bytes(without_img)
    (_REPORTS / f"{stem}_with.jpg").write_bytes(with_img)

    return PlaceResult(
        name=label,
        without_score=without.score,
        with_score=with_cond.score,
        without_rationale=without.rationale,
        with_rationale=with_cond.rationale,
    )


async def run_bench(base: str, session: str, n: int, model: str) -> dict[str, Any]:
    root, map_bytes, places = await _fetch_map_and_places(base, session, n)
    if not places:
        raise SystemExit("no in-frame place entities found for this session")
    map_title = root.get("page_title") or "the map"
    aspect = root.get("aspect_ratio") or "16:9"

    results: list[PlaceResult] = []
    for place in places:
        results.append(await run_one(map_title, aspect, model, map_bytes, place))

    without_mean = round(statistics.mean(r.without_score for r in results), 4)
    with_mean = round(statistics.mean(r.with_score for r in results), 4)
    return {
        "session_id": session,
        "map_title": map_title,
        "judge_model": os.environ.get("CONTINUITY_BENCH_JUDGE_MODEL"),
        "image_model": model,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "places": [asdict(r) | {"lift": r.lift} for r in results],
        "summary": {
            "n_places": len(results),
            "without_conditioning_mean": without_mean,
            "with_conditioning_mean": with_mean,
            "mean_lift": round(with_mean - without_mean, 4),
        },
    }


def _cli() -> None:
    if not os.environ.get("COHERENCE_BENCH_RUN"):
        raise SystemExit("set COHERENCE_BENCH_RUN=1 to spend on the paid coherence A/B")
    _load_env()
    if not os.environ.get("FAL_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("FAL_KEY + OPENROUTER_API_KEY required (apps/modal-backend/.env)")
    base = os.environ.get("COHERENCE_BENCH_BASE", "http://localhost:3137")
    session = os.environ.get("COHERENCE_BENCH_SESSION", "")
    if not session:
        raise SystemExit("set COHERENCE_BENCH_SESSION=session_...")
    n = int(os.environ.get("COHERENCE_BENCH_N", "3"))
    model = os.environ.get("COHERENCE_BENCH_MODEL", "fal-ai/nano-banana-pro")

    report = asyncio.run(run_bench(base, session, n, model))
    _REPORTS.mkdir(parents=True, exist_ok=True)
    (_REPORTS / "coherence_latest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    _cli()
