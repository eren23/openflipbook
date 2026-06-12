"""Segmenter smoke — eyeball the polygons + anchored heights on real images.

VLM-only (zero fal): runs `segment()` over up to 3 existing report JPGs
(any prior paid bench leaves some in tests/*/reports/), infers absolute
heights off the anchored ladder, flags tier-implausible values, and writes
everything to reports/segment_smoke_latest.json for a human look.

Run (PAID, ~$0.02-0.05 — a few Gemini calls):
    SEGMENT_BENCH_RUN=1 .venv/bin/python -m tests.world_bench.segment_smoke
or:  make eval-segment-smoke
Override the image set: SEGMENT_SMOKE_IMAGES=/path/a.jpg,/path/b.jpg
Labels default to a generic landmark set; override: SEGMENT_SMOKE_LABELS=a,b
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

_TESTS = Path(__file__).resolve().parents[1]
_REPORT = Path(__file__).resolve().parent / "reports" / "segment_smoke_latest.json"

_DEFAULT_LABELS = [
    "tower", "castle", "palace", "bridge", "house", "church",
    "river", "wall", "gate", "ship",
]


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


def _images() -> list[Path]:
    override = os.environ.get("SEGMENT_SMOKE_IMAGES", "")
    if override:
        return [Path(p) for p in override.split(",") if Path(p).exists()]
    found = sorted(_TESTS.glob("*/reports/*.jpg"))
    return found[:3]


async def _run() -> int:
    from providers import heights
    from providers.segmenter import segment

    labels = [
        s.strip()
        for s in os.environ.get("SEGMENT_SMOKE_LABELS", "").split(",")
        if s.strip()
    ] or _DEFAULT_LABELS
    images = _images()
    if not images:
        print(
            "segment-smoke: no report JPGs found — run any paid bench first "
            "(e.g. make eval-enter-drift) or set SEGMENT_SMOKE_IMAGES=/path.jpg"
        )
        return 1

    results = []
    for img in images:
        segs = await segment(img.read_bytes(), labels)
        inferred = heights.infer_heights_m(list(segs))
        flags = heights.flag_implausible(inferred, "city")
        results.append(
            {
                "image": str(img),
                "segments": segs,
                "heights_m": inferred,
                "tier_flags": flags,
            }
        )
        print(f"{img.name}: {len(segs)} segments")
        for s in segs:
            h = inferred.get(s["label"])
            print(
                f"  {s['label']}: {len(s['polygon'])} verts, "
                f"rel={s['rel_height']:.2f}, est={s['est_height_m']}, "
                f"inferred={f'{h:.1f} m' if h else '-'}"
            )
        for f in flags:
            print(f"  FLAG: {f}")

    _REPORT.parent.mkdir(parents=True, exist_ok=True)
    _REPORT.write_text(json.dumps(results, indent=1))
    print(f"wrote {_REPORT}")
    return 0


def main() -> int:
    if os.environ.get("SEGMENT_BENCH_RUN") != "1":
        print("segment-smoke: PAID (a few Gemini calls). Set SEGMENT_BENCH_RUN=1 to run.")
        return 0
    _load_env()
    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
