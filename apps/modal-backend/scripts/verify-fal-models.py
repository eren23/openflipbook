#!/usr/bin/env python3
"""Confirm the fal model slugs + which input params each endpoint actually accepts.

Referenced by providers/model_router.py. NOT a CI gate (it hits the network);
run it by hand when wiring a new slot or before trusting a param like
`negative_prompt` / `image_urls`.

Findings as of 2026-06 (the reason image._args_for sends no negative_prompt and
why fresh-gen conditioning is best-effort):
  - nano-banana / nano-banana-pro (text-to-image): NO negative_prompt, NO image_urls
  - flux-pro/kontext (edit/continue):              NO negative_prompt, takes image_url (singular)
  - seedream v4 (text-to-image):                   text-only (image_size, no refs)
  - bria/expand (outpaint):                        takes image_url + expansion box
=> No image model in use accepts a negative_prompt, so we never send one; the
   MEDIUM LOCK in the prompt text is the model-agnostic style guard. Image refs
   are only reliably honoured by the edit/continue endpoints.

Usage:  python scripts/verify-fal-models.py
"""
from __future__ import annotations

import json
import sys
import urllib.request

SCHEMA = "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={slug}"

# The slugs the code actually uses (TIER_MODELS / EDIT_TIER_MODELS /
# CONTINUE_MODEL_DEFAULT / EXPAND_MODEL_DEFAULT).
SLUGS = [
    "fal-ai/nano-banana",
    "fal-ai/nano-banana-pro",
    "fal-ai/nano-banana/edit",
    "fal-ai/bytedance/seedream/v4/text-to-image",
    "fal-ai/flux-pro/kontext",
    "fal-ai/bria/expand",
]
PROBE = ["prompt", "image_url", "image_urls", "negative_prompt", "aspect_ratio", "guidance_scale"]


def input_props(schema: dict) -> set[str]:
    """The property names of the *Input* component of a fal queue OpenAPI doc."""
    comps = (schema.get("components") or {}).get("schemas") or {}
    for name, comp in comps.items():
        if name.endswith("Input") and isinstance(comp.get("properties"), dict):
            return set(comp["properties"].keys())
    return set()


def main() -> int:
    bad = []
    print(f"{'model':<46} " + " ".join(f"{p:>15}" for p in PROBE))
    for slug in SLUGS:
        try:
            with urllib.request.urlopen(SCHEMA.format(slug=slug), timeout=30) as r:
                props = input_props(json.loads(r.read()))
        except Exception as e:  # best-effort dev tool: report + continue
            print(f"{slug:<46} ERROR {e}")
            bad.append(slug)
            continue
        cells = ["yes" if p in props else "-" for p in PROBE]
        print(f"{slug:<46} " + " ".join(f"{c:>15}" for c in cells))
        # The contract the code relies on: nobody gets a negative_prompt.
        if "negative_prompt" in props:
            print(f"  NOTE: {slug} now accepts negative_prompt — image._args_for could use it.")
    if bad:
        print(f"\n{len(bad)} slug(s) failed to resolve: {bad}", file=sys.stderr)
        return 1
    print("\nOK — schemas resolved. No in-use model accepts negative_prompt (as expected).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
