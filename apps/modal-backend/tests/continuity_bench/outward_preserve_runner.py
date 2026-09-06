"""One paid OUTWARD preservation receipt, using the production stream and judges.

OUTWARD_PRESERVE_BENCH_RUN=1 .venv/bin/python -m \
    tests.continuity_bench.outward_preserve_runner --source map.png --output /tmp/outward-proof
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
from pathlib import Path
from typing import Any
from unittest.mock import patch

from dotenv import load_dotenv
from PIL import Image

from generate import GenerateBody
from providers import image_edit, judge
from providers.generate_modes.ascend import stream_ascend
from providers.image import GeneratedImage, encode_data_url
from providers.outward_pixels import OutwardCanvas


async def run(source: Path, output: Path) -> dict:
    data = source.read_bytes()
    layout = OutwardCanvas.prepare(data, 2)
    output.mkdir(parents=True, exist_ok=True)
    (output / "source.png").write_bytes(layout.source_png)
    renders: list[dict] = []
    expand = image_edit.expand_image_zoomout

    async def capture(*args: Any, **kwargs: Any) -> GeneratedImage:
        result = await expand(*args, **kwargs)
        name = f"attempt-{len(renders) + 1}.png"
        (output / name).write_bytes(result.jpeg_bytes)
        image = Image.open(io.BytesIO(result.jpeg_bytes)).convert("RGBA")
        x, y = layout.location
        w, h = layout.source_size
        original = Image.open(io.BytesIO(layout.source_png)).convert("RGBA")
        exact = image.crop((x, y, x + w, y + h)).tobytes() == original.tobytes()
        renders.append({"file": name, "model": result.model, "source_pixels_equal": exact})
        return result

    verdicts: dict[str, dict] = {}
    alignment_judge, style_judge = judge.score_prompt_alignment, judge.score_style_pair

    async def alignment(prompt: str, image: bytes) -> judge.JudgeResult:
        result = await alignment_judge(prompt, image)
        verdicts["alignment"] = {"score": result.score, "rationale": result.rationale}
        return result

    async def style(first: bytes, second: bytes) -> judge.JudgeResult:
        result = await style_judge(first, second)
        verdicts["style"] = {"score": result.score, "rationale": result.rationale}
        return result

    async def abort(_: str) -> None:
        pass

    body = GenerateBody(
        query="Ankh-Morpork",
        session_id="outward-preserve-bench",
        mode="ascend",
        image=encode_data_url(data, "image/png"),
        max_attempts=1,
        scene_view=None,
        session_style_anchor="hand-inked cartography, muted green terrain, sepia paper, fine dark linework",
        outward_context="Ankh-Morpork on the River Ankh, surrounded by the Sto Plains.",
        web_search=False,
    )
    events: list[dict] = []
    with (
        patch.object(image_edit, "expand_image_zoomout", capture),
        patch.object(judge, "score_prompt_alignment", alignment),
        patch.object(judge, "score_style_pair", style),
    ):
        async for chunk in stream_ascend(
            body, "outward-preserve-bench",
            _sse=lambda event, _: json.dumps(event).encode(),
            _frame_dims=lambda _: (1600, 900),
            _view_grammar_on=lambda: True,
            _abort_if_disconnected=abort,
        ):
            event = json.loads(chunk)
            event.pop("image_data_url", None)
            events.append(event)
    report = {
        "source": source.name,
        "source_size": layout.source_size,
        "canvas_size": layout.canvas_size,
        "renders": renders,
        "judges": verdicts,
        "accepted": any(e["type"] == "ascend_ready" for e in events),
        "events": events,
    }
    (output / "receipt.json").write_text(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("OUTWARD_PRESERVE_BENCH_RUN") != "1":
        raise SystemExit("Set OUTWARD_PRESERVE_BENCH_RUN=1 to authorize one paid render + judges")
    backend = Path(__file__).resolve().parents[2]
    load_dotenv(backend / ".env", override=False)
    load_dotenv(backend.parents[1] / ".env", override=False)
    os.environ["MOCK_PROVIDERS"] = "0"
    os.environ["SCALE_OUTWARD_PRESERVE_SOURCE"] = "1"
    os.environ["SCALE_LADDER_NAV"] = "1"
    os.environ["SCALE_OUTWARD"] = "1"
    print(json.dumps(asyncio.run(run(args.source, args.output)), indent=2))


if __name__ == "__main__":
    main()
