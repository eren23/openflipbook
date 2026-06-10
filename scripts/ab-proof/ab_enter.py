"""A/B proof for the ENTER consistency fix (enter-via-edit).

The kill-switch IS the "before": the SAME code runs on two local backends that
differ only in one env flag —
  :8788 = ENTER_EDIT_REF=false  (the old path: fresh text-to-image, refs ignored)
  :8789 = ENTER_EDIT_REF=true   (the fix: edit endpoint on the region crop)

One map is generated once; the region crop at the tap point is computed here
exactly like the client (crop_box frac mirror); the IDENTICAL tap body goes to
both backends. The script machine-asserts the routing from the final events
(image_op / image_model) and composes a 3-panel: tapped region | BEFORE | AFTER.

Run (two terminals, from apps/modal-backend, both with WORLD_MODE=1):
  ENTER_EDIT_REF=false PORT=8788 python local_server.py
  ENTER_EDIT_REF=true  PORT=8789 python local_server.py
then:
  .venv/bin/python ../../scripts/ab-proof/ab_enter.py
Artifacts: /tmp/ab_enter_{map,region,before,after}.jpg + /tmp/ab_enter_3panel.png
"""
import base64
import io
import json
import sys

import httpx
from PIL import Image, ImageDraw, ImageFont

BEFORE = "http://localhost:8788/sse/generate"
AFTER = "http://localhost:8789/sse/generate"
SID = "ab-enter-proof"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"

STYLE = "hand-drawn antique engraving, sepia ink, dense cross-hatching, woodcut linework"
MAP_QUERY = (
    "a hand-drawn antique engraving top-down map of a walled harbor city: a tall "
    "striped lighthouse on the north cliff, a market square in the center, wooden "
    "docks along the south shore, and a stone castle on the east hill; sepia ink, "
    "dense cross-hatching, aged paper"
)
TAP = (0.78, 0.42)  # the stone castle, east hill
SUBJECT = "The Stone Castle"
SURROUNDINGS = (
    "to the west, the market square and the harbor; to the north-west, the striped "
    "lighthouse on the cliffs"
)


def sse_generate(url: str, body: dict, timeout: float = 300.0) -> dict:
    final = None
    with httpx.stream("POST", url, json=body, timeout=timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            try:
                evt = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if evt.get("type") == "error":
                raise RuntimeError(f"backend error: {evt.get('message')}")
            if evt.get("type") == "final":
                final = evt
    if not final:
        raise RuntimeError("no final event")
    return final


def save(data_url: str, path: str) -> bytes:
    raw = base64.b64decode(data_url.split(",", 1)[1])
    with open(path, "wb") as f:
        f.write(raw)
    return raw


def crop_region(map_bytes: bytes, x_pct: float, y_pct: float, frac: float = 0.42) -> bytes:
    """Pure mirror of lib/image-condition.ts cropBox — the client's region ref."""
    img = Image.open(io.BytesIO(map_bytes)).convert("RGB")
    w = min(max(frac, 0.0), 1.0)
    x = min(max(x_pct - w / 2, 0.0), 1.0 - w)
    y = min(max(y_pct - w / 2, 0.0), 1.0 - w)
    pw, ph = img.size
    crop = img.crop((round(x * pw), round(y * ph), round((x + w) * pw), round((y + w) * ph)))
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def tap_body(map_data_url: str, region_data_url: str) -> dict:
    return {
        "query": SUBJECT,
        "session_id": SID,
        "aspect_ratio": "16:9",
        "image_tier": "balanced",
        "mode": "tap",
        "image": map_data_url,
        "parent_query": MAP_QUERY,
        "parent_title": "The Harbor City",
        "click": {"x_pct": TAP[0], "y_pct": TAP[1]},
        "world_mode": True,
        "render_mode": "place_scene",
        # Identical resolved subject on both backends (skips the VLM resolver).
        "prefetched_subject": SUBJECT,
        "prefetched_style": STYLE,
        "prefetched_subject_context": "a stone castle with towers and walls on a hill east of the harbor",
        "prefetched_surroundings": SURROUNDINGS,
        "web_search": False,
        # The exact stack the client sends: region crop -> parent map -> style.
        "condition_image_urls": [region_data_url, map_data_url, map_data_url],
        "condition_roles": ["region", "parent", "style"],
        "session_style_anchor": STYLE,
    }


def labeled(raw: bytes, caption: str, barcolor: str, w: int = 520, h: int = 390) -> Image.Image:
    barh = 56
    im = Image.open(io.BytesIO(raw)).convert("RGB").resize((w, h))
    canvas = Image.new("RGB", (w, h + barh), barcolor)
    canvas.paste(im, (0, 0))
    d = ImageDraw.Draw(canvas)
    f = ImageFont.truetype(FONT, 22)
    tw = d.textlength(caption, font=f)
    d.text(((w - tw) // 2, h + (barh - 26) // 2), caption, font=f, fill="white")
    return canvas


def three_panel(panels: list[Image.Image], title: str, out: str) -> None:
    gap, titleh = 12, 64
    W = sum(p.width for p in panels) + gap * (len(panels) - 1)
    H = max(p.height for p in panels) + titleh
    canvas = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(canvas)
    f = ImageFont.truetype(FONT, 22)
    tw = d.textlength(title, font=f)
    d.text(((W - tw) // 2, (titleh - 26) // 2), title, font=f, fill="black")
    x = 0
    for p in panels:
        canvas.paste(p, (x, titleh))
        x += p.width + gap
    if canvas.width % 2 or canvas.height % 2:
        canvas = canvas.crop((0, 0, canvas.width - canvas.width % 2, canvas.height - canvas.height % 2))
    canvas.save(out)
    print("wrote", out, canvas.size)


def main() -> None:
    print("[1/4] generating the source map once (AFTER backend)...", file=sys.stderr)
    m = sse_generate(
        AFTER,
        {
            "query": MAP_QUERY,
            "session_id": SID,
            "aspect_ratio": "16:9",
            "image_tier": "balanced",
            "mode": "query",
            "web_search": False,
            "session_style_anchor": STYLE,
        },
    )
    map_url = m["image_data_url"]
    map_bytes = save(map_url, "/tmp/ab_enter_map.jpg")

    print("[2/4] cropping the tapped region (client mirror)...", file=sys.stderr)
    region_bytes = crop_region(map_bytes, *TAP)
    with open("/tmp/ab_enter_region.jpg", "wb") as f:
        f.write(region_bytes)
    region_url = "data:image/jpeg;base64," + base64.b64encode(region_bytes).decode()

    body = tap_body(map_url, region_url)
    print("[3/4] identical tap to BOTH backends...", file=sys.stderr)
    before = sse_generate(BEFORE, dict(body))
    after = sse_generate(AFTER, dict(body))
    save(before["image_data_url"], "/tmp/ab_enter_before.jpg")
    save(after["image_data_url"], "/tmp/ab_enter_after.jpg")

    # Machine-check the routing — the proof is in the trace, not vibes.
    assert "image_op" not in before, f"BEFORE unexpectedly edit-routed: {before.get('image_op')}"
    assert after.get("image_op") == "enter_scene", f"AFTER not edit-routed: {after.get('image_op')}"
    assert "/edit" in after.get("image_model", ""), f"AFTER model: {after.get('image_model')}"
    print(
        f"routing OK — before: {before.get('image_model')} (fresh, refs inert) | "
        f"after: {after.get('image_model')} (op={after.get('image_op')})",
        file=sys.stderr,
    )

    print("[4/4] composing the 3-panel...", file=sys.stderr)
    three_panel(
        [
            labeled(region_bytes, "the tapped map region", "#444444"),
            labeled(open("/tmp/ab_enter_before.jpg", "rb").read(), "BEFORE — refs silently ignored", "#B00020"),
            labeled(open("/tmp/ab_enter_after.jpg", "rb").read(), "AFTER — edit-conditioned on the crop", "#0B7A33"),
        ],
        "openflipbook — tap-to-ENTER consistency — identical request, only ENTER_EDIT_REF differs",
        "/tmp/ab_enter_3panel.png",
    )


if __name__ == "__main__":
    main()
