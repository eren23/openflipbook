"""A/B proof driver for the style medium-lock fix.

Identical input (same source map, same forced subject, same engraving style text,
same corrected env) sent to two backends that differ ONLY in code:
  :8788 = main  (pre-fix)
  :8789 = fix   (feat/consistency-fixes)
prefetched_subject skips the VLM resolver, so the subject is deterministic and
the only variable is the style-handling prompt logic.
"""
import base64
import json
import sys

import httpx

MAIN = "http://localhost:8788/sse/generate"
FIX = "http://localhost:8789/sse/generate"
SID = "ab-style-proof"

STYLE = (
    "hand-drawn antique engraving, sepia ink, dense cross-hatching, woodcut "
    "linework, aged paper"
)
MAP_QUERY = (
    "a hand-drawn antique engraving map of the fictional walled city of "
    "Ankh-Morpork, sepia ink, dense cross-hatching, woodcut style, labelled "
    "districts, a winding river, compass rose"
)
SUBJECT = (
    "the interior of the grand domed Unseen University great hall at the city "
    "centre"
)


def sse_generate(url: str, body: dict, timeout: float = 240.0) -> dict:
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
            t = evt.get("type")
            if t == "error":
                raise RuntimeError(f"backend error: {evt.get('message')}")
            if t == "final":
                final = evt
    if not final:
        raise RuntimeError("no final event")
    return final


def save(data_url: str, path: str) -> None:
    b64 = data_url.split(",", 1)[1]
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))


def tap_body(image: str) -> dict:
    return {
        "query": "Unseen University great hall",
        "session_id": SID,
        "aspect_ratio": "16:9",
        "image_tier": "balanced",
        "mode": "tap",
        "image": image,
        "parent_query": MAP_QUERY,
        "parent_title": "Ankh-Morpork",
        "click": {"x_pct": 0.5, "y_pct": 0.45},
        "world_mode": True,
        "render_mode": "place_scene",
        # Force identical subject on both backends (skips the VLM resolver).
        "prefetched_subject": SUBJECT,
        "prefetched_style": STYLE,
        # The map is both the place being entered (region) and the medium
        # exemplar (style). Same refs to both backends.
        "condition_image_urls": [image, image],
        "condition_roles": ["region", "style"],
        "session_style_anchor": STYLE,
    }


def main() -> None:
    print("[1/3] generating the source engraving map (fix backend)...", file=sys.stderr)
    m = sse_generate(
        FIX,
        {
            "query": MAP_QUERY,
            "session_id": SID,
            "aspect_ratio": "16:9",
            "image_tier": "balanced",
            "web_search": False,
            "world_mode": True,
            "session_style_anchor": STYLE,
        },
    )
    map_url = m["image_data_url"]
    save(map_url, "/tmp/ab_map.jpg")
    print(f"      map saved -> /tmp/ab_map.jpg (model={m.get('image_model')})", file=sys.stderr)

    print("[2/3] tap -> BEFORE (main :8788, pre-fix)...", file=sys.stderr)
    a = sse_generate(MAIN, tap_body(map_url))
    save(a["image_data_url"], "/tmp/ab_before.jpg")
    print(f"      before saved (model={a.get('image_model')})", file=sys.stderr)

    print("[3/3] tap -> AFTER (fix :8789)...", file=sys.stderr)
    b = sse_generate(FIX, tap_body(map_url))
    save(b["image_data_url"], "/tmp/ab_after.jpg")
    print(f"      after saved (model={b.get('image_model')})", file=sys.stderr)

    print(json.dumps({
        "map_title": m.get("page_title"),
        "before_prompt": (a.get("final_prompt") or "")[:600],
        "after_prompt": (b.get("final_prompt") or "")[:600],
    }, indent=2))
    print("DONE")


if __name__ == "__main__":
    main()
