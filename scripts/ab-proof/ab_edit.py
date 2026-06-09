"""Edit-path A/B: the cleanest code-isolated test of the style fix.

The pre-fix edit branch dropped the style ENTIRELY (no style_anchor into polish,
no style ref into edit_image). The fixed branch threads both. We send the
IDENTICAL edit request (with session_style_anchor + a "style" condition ref) to
both backends; main ignores both, fix uses both. Same input, only code differs.
"""
import base64
import json
import sys

import httpx

MAIN = "http://localhost:8788/sse/generate"
FIX = "http://localhost:8789/sse/generate"
SID = "ab-edit-proof"
STYLE = (
    "hand-drawn antique engraving, sepia ink, dense cross-hatching, woodcut "
    "linework, aged paper"
)
# A drift-prone edit: a "clockwork dragon" tempts a glossy 3D/photoreal render.
INSTRUCTION = "add a colossal clockwork dragon coiled around the central tower"


def sse(url, body, timeout=240.0):
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
                raise RuntimeError(evt.get("message"))
            if evt.get("type") == "final":
                final = evt
    if not final:
        raise RuntimeError("no final")
    return final


def save(u, p):
    open(p, "wb").write(base64.b64decode(u.split(",", 1)[1]))


map_url = "data:image/jpeg;base64," + base64.b64encode(
    open("/tmp/ab_map.jpg", "rb").read()
).decode()


def edit_body():
    return {
        "query": INSTRUCTION,
        "session_id": SID,
        "aspect_ratio": "16:9",
        "image_tier": "balanced",
        "mode": "edit",
        "image": map_url,
        "edit_instruction": INSTRUCTION,
        "parent_title": "Ankh-Morpork",
        # Both sent identically; main's edit branch ignores both, fix uses both.
        "session_style_anchor": STYLE,
        "condition_image_urls": [map_url],
        "condition_roles": ["style"],
    }


print("[1/2] edit -> BEFORE (main :8788, drops style)...", file=sys.stderr)
a = sse(MAIN, edit_body())
save(a["image_data_url"], "/tmp/ab_edit_before.jpg")
print(f"      before saved; final_prompt={a.get('final_prompt')!r}", file=sys.stderr)

print("[2/2] edit -> AFTER (fix :8789, keeps style)...", file=sys.stderr)
b = sse(FIX, edit_body())
save(b["image_data_url"], "/tmp/ab_edit_after.jpg")
print(f"      after saved; final_prompt={b.get('final_prompt')!r}", file=sys.stderr)
print("DONE")
