"""Python replica of ``apps/web/lib/image-click.ts:annotateClickPoint``.

The web client draws a red crosshair + white halo at the click point and
sends the annotated JPEG to the VLM. The bench needs the same annotation
applied server-side so resolver accuracy is measured under production
conditions.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageDraw


def annotate_click_point(
    image_bytes: bytes,
    x_pct: float,
    y_pct: float,
    *,
    output_format: str = "JPEG",
    quality: int = 92,
) -> bytes:
    """Draw a red crosshair with white halo at (x_pct, y_pct) on the image.

    Matches the geometry of ``annotateClickPoint`` in image-click.ts:
      - circle radius r = max(24, round(width * 0.02))
      - crosshair reach = r * 1.8
      - white halo stroke width 8, red overlay stroke width 4
      - red filled center dot, radius max(3, r * 0.18)
    """
    if not 0.0 <= x_pct <= 1.0 or not 0.0 <= y_pct <= 1.0:
        raise ValueError(f"x_pct/y_pct must be in [0,1]; got {x_pct}, {y_pct}")

    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    cx = round(x_pct * w)
    cy = round(y_pct * h)
    r = max(24, round(w * 0.02))
    reach = round(r * 1.8)

    draw = ImageDraw.Draw(img, "RGBA")

    halo = (255, 255, 255, 242)
    red = (239, 68, 68, 255)

    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=halo, width=8)
    draw.line((cx - reach, cy, cx + reach, cy), fill=halo, width=8)
    draw.line((cx, cy - reach, cx, cy + reach), fill=halo, width=8)

    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=red, width=4)
    draw.line((cx - reach, cy, cx + reach, cy), fill=red, width=4)
    draw.line((cx, cy - reach, cx, cy + reach), fill=red, width=4)

    dot = max(3, round(r * 0.18))
    draw.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=red)

    buf = BytesIO()
    img.save(buf, format=output_format, quality=quality)
    return buf.getvalue()


def to_data_url(image_bytes: bytes, mime: str = "image/jpeg") -> str:
    """Encode image bytes as a base64 data URL ready for the VLM payload."""
    import base64

    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"
