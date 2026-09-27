"""One explicit paid Sketch trial per invocation; never retries a completed receipt."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image, ImageDraw

from providers.sketch import MODELS, SketchInput, data_url, png, render_sketch


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--model", choices=sorted(MODELS), required=True)
    parser.add_argument("--case", choices=["create", "correct", "placement"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--subject", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = args.output / "receipt.json"
    if receipt.exists():
        raise SystemExit("Receipt exists; refusing another charge")
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    os.environ["MOCK_PROVIDERS"] = "0"
    source = None
    mask = None
    subject = None
    if args.case == "create":
        guide = Image.new("RGB", (1024, 1024), "white")
        draw = ImageDraw.Draw(guide)
        draw.rectangle((90, 280, 235, 760), outline="#d94841", width=8)
        draw.polygon([(75, 280), (163, 180), (250, 280)], outline="#d94841", width=8)
        draw.ellipse((410, 450, 900, 850), outline="#148aa8", width=10)
        draw.rectangle((590, 280, 760, 410), outline="#236249", width=8)
        prompt = "A finished richly colored isometric fantasy harbor illustration. A tall stone lighthouse on the LEFT, a circular blue harbor on the RIGHT, a red-roof tavern above the harbor. Preserve the drawing's layout. No visible annotation strokes or explanatory labels."
    elif args.case == "placement":
        if not args.source or not args.subject:
            parser.error("placement requires --source and --subject")
        source = Image.open(args.source).convert("RGBA")
        subject = Image.open(args.subject).convert("RGBA")
        if source.size != (1024, 1024):
            parser.error("the controlled desk placement fixture must be 1024 square")
        guide = source.copy()
        ImageDraw.Draw(guide).ellipse((305, 460, 375, 490), outline="#d94841", width=4)
        mask = Image.new("RGB", source.size, "black")
        ImageDraw.Draw(mask).rectangle((160, 170, 610, 513), fill="white")
        prompt = (
            "Place the exact celadon ceramic mushroom lamp from the object reference on the LEFT "
            "half of this desk. The red ellipse marks where the lamp BASE contacts the tabletop. "
            "The lamp is about 45 cm tall on a roughly 150 cm wide desk: believable table-lamp scale. "
            "Preserve the pale green crackle-glazed dome, slender brushed metal stem, and oval metal "
            "foot. Match this room's camera and soft daylight from the LEFT, with a subtle contact "
            "shadow on the tabletop. Do not float the lamp, copy the reference's white background, "
            "or change the desk, books, pencil cup, window, or plant. Remove the red placement mark."
        )
        (args.output / "subject.png").write_bytes(png(subject))
    else:
        source = Image.open(
            Path(__file__).parent / "click_bench/fixtures/images/real/harbor_aethelgard.jpg"
        ).convert("RGBA")
        guide = source.copy()
        draw = ImageDraw.Draw(guide)
        area = (120, 50, 265, 205)
        draw.ellipse(area, outline="#d94841", width=8)
        mask = Image.new("RGB", source.size, "black")
        ImageDraw.Draw(mask).rectangle(area, fill="white")
        prompt = "Replace the cyan crystal atop the lighthouse on the left with a glowing RUBY RED crystal of the same shape. Keep the tower, harbor, camera and all other details unchanged. Remove the red annotation circle."
    (args.output / "guide.png").write_bytes(png(guide))
    if source is not None:
        (args.output / "source.png").write_bytes(png(source))
        (args.output / "mask.png").write_bytes(png(mask))
    request = SketchInput(
        kind="edit" if source is not None else "create",
        scope="region",
        width=guide.width,
        height=guide.height,
        guide=data_url(guide),
        mask=data_url(mask) if mask else None,
        workflow="placement" if args.case == "placement" else "render",
        subject=data_url(subject) if subject else None,
    )
    record = {
        "model": args.model,
        "case": args.case,
        "prompt": prompt,
        "reservation_usd": 0.30,
        "status": "started",
    }
    with receipt.open("x") as handle:
        handle.write(json.dumps(record, indent=2))
    start = time.monotonic()
    try:
        result, outside = await render_sketch(
            request, data_url(source) if source else None, prompt, args.model, "sketch-live-trial"
        )
        (args.output / "result.png").write_bytes(result.jpeg_bytes)
        record.update(
            status="complete", outside_changed=outside, request_id=result.provider_request_id
        )
    except Exception as error:
        record.update(status="failed", error=f"{type(error).__name__}: {error}"[:500])
    record["elapsed_seconds"] = round(time.monotonic() - start, 2)
    receipt.write_text(json.dumps(record, indent=2))
    print(json.dumps(record))
    if record["status"] != "complete":
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
