"""Layout-fidelity scoring for the P3 eval.

A VLM judge (Gemini-default, NOT qwen) scores a rendered image against an
EXPECTED layout (named entities with intended position/size bins + depth order).
The aggregation (judge dict → 0..1 score) is pure and free-tested; the judge call
is live. Used by layout_runner (the with/without-clause A/B) and the gated
test_layout_fidelity gate.
"""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from typing import Any


def judge_model() -> str:
    return os.environ.get(
        "WORLD_BENCH_JUDGE_MODEL",
        os.environ.get("OPENROUTER_VLM_MODEL", "google/gemini-3-flash-preview"),
    )


def _image_block(image_bytes: bytes) -> dict[str, object]:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
    }


@dataclass(frozen=True)
class LayoutFidelity:
    score: float  # 0..1 overall
    presence_rate: float  # fraction of expected entities present
    per_entity: dict[str, float]  # label → 0..1


def _clamp10(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(10.0, f))


def aggregate_layout_fidelity(judge: dict[str, Any]) -> LayoutFidelity:
    """Fold a judge reply into 0..1 scores. Tolerant: missing/garbage → 0."""
    ents = judge.get("entities") if isinstance(judge, dict) else None
    if not isinstance(ents, list) or not ents:
        return LayoutFidelity(0.0, 0.0, {})
    per: dict[str, float] = {}
    present = 0
    for e in ents:
        if not isinstance(e, dict):
            continue
        label = str(e.get("label", "?"))
        is_present = bool(e.get("present"))
        if is_present:
            present += 1
        pos = _clamp10(e.get("position_ok"))
        size = _clamp10(e.get("size_ok"))
        per[label] = (0.5 * pos + 0.3 * size + 0.2 * (10.0 if is_present else 0.0)) / 10.0
    if not per:
        return LayoutFidelity(0.0, 0.0, {})
    entity_mean = sum(per.values()) / len(per)
    depth = _clamp10(judge.get("depth_order_ok")) / 10.0
    return LayoutFidelity(
        score=0.85 * entity_mean + 0.15 * depth,
        presence_rate=present / len(ents),
        per_entity=per,
    )


def _layout_text(expected: list[dict[str, Any]]) -> str:
    return "; ".join(
        f"{e.get('label', '?')} (should be {e['size']}, {e['h_pos']} {e['v_pos']})"
        for e in expected
    )


async def judge_layout_fidelity(
    image_bytes: bytes, expected: list[dict[str, Any]]
) -> dict[str, Any]:
    """Ask the VLM to score the render against the expected layout. Returns the
    raw judge dict (feed to aggregate_layout_fidelity); {} on a malformed reply."""
    from providers import llm

    system = (
        "You are a strict scene-layout judge. You are given an EXPECTED layout "
        "(named entities with an intended horizontal bin far-left..far-right, a "
        "vertical bin top/mid/bottom, and a size bin tiny..huge) and a rendered "
        "image. For EACH expected entity decide if it is present and how well its "
        "screen position and size match the intent; also judge the front-to-back "
        "(depth) order. Return JSON exactly: "
        '{"entities":[{"label":"<name>","present":true,"position_ok":<0-10>,'
        '"size_ok":<0-10>}],"depth_order_ok":<0-10>}. No prose.'
    )
    user_text = (
        f"EXPECTED LAYOUT: {_layout_text(expected)}.\n\n"
        "Score the rendered image against this layout."
    )
    model = judge_model()
    client = llm._client()
    messages: list[Any] = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [{"type": "text", "text": user_text}, _image_block(image_bytes)],
        },
    ]
    resp = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.0,
        max_tokens=500,
        **llm._maybe_response_format(model),
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        return json.loads(raw[raw.find("{") : raw.rfind("}") + 1])
    except Exception:
        return {}
