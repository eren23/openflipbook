"""Generate deterministic synthetic smoke fixtures for the click bench.

These are NOT a substitute for real captured illustrations — they're labeled
boxes/circles so the bench + leaderboard run end-to-end without first standing
up the whole generation pipeline. Ground truth is known by construction: each
element's case clicks its centre, and each page has an empty region for the
groundability rejection metric.

Run once to (re)generate images + synthetic.json::

    cd apps/modal-backend
    .venv/bin/python -m tests.click_bench._gen_synthetic

Replace these with real illustrations (see fixtures/v1.json _meta) for a
meaningful leaderboard.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

W, H = 1024, 576
_FIX_DIR = Path(__file__).parent / "fixtures"
_IMG_DIR = _FIX_DIR / "images" / "synthetic"

# Distinct fills so adjacent elements don't blur together for the VLM.
_PALETTE = [
    (59, 130, 246),
    (16, 185, 129),
    (245, 158, 11),
    (139, 92, 246),
]

PAGES: list[dict[str, Any]] = [
    {
        "id": "steam_engine",
        "title": "How a Steam Engine Works",
        "query": "how does a steam engine work",
        "bg": (237, 241, 246),
        "elements": [
            {"label": "Boiler", "shape": "box", "box": (90, 200, 340, 420),
             "subject": "Boiler", "alternates": ["the boiler"]},
            {"label": "Piston", "shape": "box", "box": (400, 200, 630, 420),
             "subject": "Piston", "alternates": ["piston rod", "the piston"]},
            {"label": "Flywheel", "shape": "circle", "box": (700, 210, 920, 410),
             "subject": "Flywheel", "alternates": ["the flywheel", "fly wheel"]},
        ],
        "empty": {"point": (0.5, 0.92), "subject": "background",
                  "notes": "plain background strip below the diagram"},
    },
    {
        "id": "solar_system",
        "title": "Inner Solar System",
        "query": "what is the inner solar system",
        "bg": (12, 16, 28),
        "elements": [
            {"label": "Sun", "shape": "circle", "box": (70, 210, 280, 410),
             "subject": "Sun", "alternates": ["the sun"]},
            {"label": "Earth", "shape": "circle", "box": (440, 240, 560, 360),
             "subject": "Earth", "alternates": ["the earth", "planet earth"]},
            {"label": "Mars", "shape": "circle", "box": (720, 250, 820, 350),
             "subject": "Mars", "alternates": ["the red planet", "planet mars"]},
        ],
        "empty": {"point": (0.5, 0.08), "subject": "empty space",
                  "notes": "dark sky above the bodies — no labelled object"},
    },
]


def _font(size: int) -> Any:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow without sized default
        return ImageFont.load_default()


def _centered_text(draw: ImageDraw.ImageDraw, cx: int, cy: int, text: str, font: Any,
                   fill: tuple[int, int, int]) -> None:
    box = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (box[2] - box[0]) / 2, cy - (box[3] - box[1]) / 2), text,
              font=font, fill=fill)


def _draw_page(page: dict[str, Any]) -> tuple[bytes, list[dict[str, Any]]]:
    img = Image.new("RGB", (W, H), color=tuple(page["bg"]))
    draw = ImageDraw.Draw(img)
    title_font = _font(34)
    label_font = _font(26)
    dark_bg = sum(page["bg"]) < 240
    title_fill = (235, 238, 245) if dark_bg else (30, 36, 48)
    _centered_text(draw, W // 2, 50, page["title"], title_font, title_fill)

    cases: list[dict[str, Any]] = []
    for i, el in enumerate(page["elements"]):
        x0, y0, x1, y1 = el["box"]
        color = _PALETTE[i % len(_PALETTE)]
        if el["shape"] == "circle":
            draw.ellipse((x0, y0, x1, y1), fill=color)
        else:
            draw.rounded_rectangle((x0, y0, x1, y1), radius=18, fill=color)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        _centered_text(draw, cx, cy, el["label"], label_font, (255, 255, 255))
        cases.append({
            "case_id": f"{page['id']}_{el['subject'].lower().replace(' ', '_')}",
            "image_path": f"images/synthetic/{page['id']}.png",
            "x_pct": round(cx / W, 4),
            "y_pct": round(cy / H, 4),
            "parent_title": page["title"],
            "parent_query": page["query"],
            "expected_subject": el["subject"],
            "alternates": el.get("alternates", []),
            "groundable": True,
            "notes": "synthetic labelled element",
        })

    empty = page["empty"]
    cases.append({
        "case_id": f"{page['id']}_empty",
        "image_path": f"images/synthetic/{page['id']}.png",
        "x_pct": empty["point"][0],
        "y_pct": empty["point"][1],
        "parent_title": page["title"],
        "parent_query": page["query"],
        "expected_subject": empty["subject"],
        "alternates": [],
        "groundable": False,
        "notes": empty["notes"],
    })

    from io import BytesIO
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), cases


def generate() -> Path:
    _IMG_DIR.mkdir(parents=True, exist_ok=True)
    all_cases: list[dict[str, Any]] = []
    for page in PAGES:
        png, cases = _draw_page(page)
        (_IMG_DIR / f"{page['id']}.png").write_bytes(png)
        all_cases.extend(cases)

    out = {
        "_meta": {
            "bench_version": 1,
            "synthetic": True,
            "description": (
                "Synthetic smoke fixtures (labelled boxes/circles) generated by "
                "_gen_synthetic.py. They make the bench + leaderboard runnable "
                "without the full generation pipeline. Replace with real "
                "illustrations for a meaningful leaderboard."
            ),
        },
        "cases": all_cases,
    }
    out_path = _FIX_DIR / "synthetic.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    return out_path


if __name__ == "__main__":
    path = generate()
    print(f"wrote {path} and {len(PAGES)} images under {_IMG_DIR}")
