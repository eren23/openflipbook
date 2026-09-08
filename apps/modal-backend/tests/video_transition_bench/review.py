"""Build a local A/B viewer and contact sheets from saved results; zero API calls."""

from __future__ import annotations

import argparse
import html
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .runner import BACKEND, CASES, H3_MAX_MODEL, atomic_json, input_cells


def build(out: Path, assets_root: Path) -> None:
    summary = json.loads((out / "summary.json").read_text())
    rows = summary["results"]
    inputs = input_cells(assets_root)
    sections = []
    mapping = {}
    for index, case in enumerate(CASES):
        source = next(c for c in inputs if c["case"] == case)
        for role in ("source", "destination"):
            shutil.copyfile(source[role], out / f"{case}-{role}.jpg")
        candidates = [r for r in rows if r["case"] == case and r["complete"]]
        candidates.sort(key=lambda r: r["model"] == H3_MAX_MODEL, reverse=index % 2 == 0)
        columns = []
        sheet = Image.new("RGB", (5 * 320, 2 * 210), "#f4f5f6")
        draw = ImageDraw.Draw(sheet)
        for row_index, row in enumerate(candidates):
            label = "AB"[row_index]
            mapping[f"{case}-{label}"] = row["model"]
            stem = Path(row["output"]).stem
            for frame in range(5):
                with Image.open(out / f"{stem}-frame-{frame}.jpg") as image:
                    thumbnail = ImageOps.contain(image.convert("RGB"), (320, 180))
                    sheet.paste(thumbnail, (frame * 320, row_index * 210 + 25))
                draw.text(
                    (frame * 320 + 8, row_index * 210 + 5), f"{label} / {frame * 25}%", fill="black"
                )
            columns.append(
                f'<figure><figcaption>{label}</figcaption><video controls playsinline preload="metadata" src="{html.escape(row["output"], quote=True)}"></video></figure>'
            )
        sheet.save(out / f"{case}-contact.jpg", quality=85)
        sections.append(
            f"<section><h2>{html.escape(case.replace('_', ' '))}</h2>"
            f'<div class="pair"><figure><figcaption>Saved map</figcaption><img src="{case}-source.jpg" alt="Saved map"></figure>'
            f'<figure><figcaption>Saved destination</figcaption><img src="{case}-destination.jpg" alt="Saved destination"></figure></div>'
            f'<div class="pair">{"".join(columns)}</div><img src="{case}-contact.jpg" alt="Five sampled frames per candidate"></section>'
        )
    atomic_json(out / "ab-mapping.json", mapping)
    document = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    document += "<title>openflipbook transition pilot</title><style>body{margin:0;background:#f4f5f6;color:#181c20;font:16px system-ui;letter-spacing:0}main{max-width:1100px;margin:auto;padding:20px}h1{font-size:26px}h2{font-size:20px}section{border-top:1px solid #bbb;padding:20px 0}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}figure{margin:0}figcaption{padding:8px 0}img,video{display:block;width:100%;object-fit:contain}video{aspect-ratio:16/9;background:#161616}a{color:#12634f}@media(max-width:600px){.pair{grid-template-columns:1fr}main{padding:12px}}</style><main><h1>openflipbook transition pilot</h1>"
    document += (
        f"<p>Reserved: ${summary['reserved_usd']} / $2.00. Production defaults unchanged.</p>"
    )
    document += "".join(sections)
    document += '<p><a href="ab-mapping.json">Model identities</a> | <a href="summary.json">Receipts</a></p></main></html>'
    (out / "review.html").write_text(document)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path, default=BACKEND / "tests/video_transition_bench/reports"
    )
    parser.add_argument("--assets-root", type=Path, default=BACKEND)
    args = parser.parse_args()
    build(args.out, args.assets_root)
