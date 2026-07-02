"""Detector canary — the ONE thing the free suite can't catch: live-model
drift. Runs the real detector over a committed synthetic image with a
10-label ask (the size class that used to truncate at max_tokens=700 and
silently return []), and fails loudly on a parse failure or zero detections.

Run (PAID, ~$0.01 — one Gemini call):
    DETECTOR_SMOKE_RUN=1 .venv/bin/python -m tests.world_bench.detector_smoke
or:  make eval-detector-smoke
Override the image: DETECTOR_SMOKE_IMAGE=/path/img.png
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

_TESTS = Path(__file__).resolve().parents[1]
_REPORT = Path(__file__).resolve().parent / "reports" / "detector_smoke_latest.json"
_DEFAULT_IMAGE = _TESTS / "click_bench" / "fixtures" / "images" / "synthetic" / "steam_engine.png"

# Ten labels on purpose: the truncation class only bites on longer replies.
_LABELS = [
    "boiler", "piston", "cylinder", "firebox", "chimney",
    "flywheel", "pressure gauge", "safety valve", "crankshaft", "steam pipe",
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


async def _run() -> int:
    import obs
    from providers.detector import detect

    image = Path(os.environ.get("DETECTOR_SMOKE_IMAGE", "") or _DEFAULT_IMAGE)
    if not image.exists():
        print(f"detector_smoke: image not found: {image}")
        return 2

    warns: list[dict] = []
    orig_log = obs.log

    def capture(level: str, event: str, **kv: object) -> None:
        if event in ("detector.parse_failed", "llm.json_salvage"):
            warns.append({"level": level, "event": event, **{k: str(v) for k, v in kv.items()}})
        orig_log(level, event, **kv)

    obs.log = capture  # type: ignore[assignment]
    try:
        dets = await detect(image.read_bytes(), _LABELS)
    finally:
        obs.log = orig_log  # type: ignore[assignment]

    report = {
        "image": str(image),
        "labels_asked": len(_LABELS),
        "detected": len(dets),
        "detections": dets,
        "parse_warnings": warns,
    }
    _REPORT.parent.mkdir(parents=True, exist_ok=True)
    _REPORT.write_text(json.dumps(report, indent=2))
    print(f"detector_smoke: {len(dets)}/{len(_LABELS)} detected, "
          f"{len(warns)} parse warning(s) → {_REPORT}")

    if warns:
        print("FAIL: parse failure/salvage against the live model — model drift?")
        return 1
    if not dets:
        print("FAIL: zero detections on the synthetic fixture — model drift?")
        return 1
    return 0


def main() -> int:
    if os.environ.get("DETECTOR_SMOKE_RUN") != "1":
        print("detector_smoke: PAID (~$0.01). Set DETECTOR_SMOKE_RUN=1 to spend.")
        return 0
    _load_env()
    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
