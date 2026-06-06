"""Open-vocabulary entity detection for the grounding loop.

Primary path: the VLM (Gemini) returns boxes for the requested labels — available
now, no new fal slug. A dedicated open-vocab detector (Grounding-DINO / OWLv2 via
FAL_DETECTOR_MODEL) is a future cross-check to harden against VLM hallucination;
its slug needs verifying first. Boxes are centre-based, 0..1
{label, x_pct, y_pct, w_pct, h_pct, score} to match ProjectedEntity + grounding.diff.
"""
from __future__ import annotations

import base64
import json
import os
from typing import Any


def _detector_model() -> str:
    return os.environ.get(
        "WORLD_BENCH_JUDGE_MODEL",
        os.environ.get("OPENROUTER_VLM_MODEL", "google/gemini-3-flash-preview"),
    )


def _clamp01(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, f))


def parse_detections(payload: Any) -> list[dict[str, Any]]:
    """Coerce a VLM detection reply into centre-based boxes. Tolerant: a box
    missing a coordinate or with a blank label is dropped (never raises)."""
    if isinstance(payload, dict):
        payload = payload.get("detections") or payload.get("entities") or []
    if not isinstance(payload, list):
        return []
    out: list[dict[str, Any]] = []
    for d in payload:
        if not isinstance(d, dict):
            continue
        label = str(d.get("label", "")).strip()
        if not label or not all(k in d for k in ("x", "y", "w", "h")):
            continue
        out.append(
            {
                "label": label,
                "x_pct": _clamp01(d["x"]),
                "y_pct": _clamp01(d["y"]),
                "w_pct": _clamp01(d["w"]),
                "h_pct": _clamp01(d["h"]),
                "score": _clamp01(d.get("score", 1.0)),
            }
        )
    return out


async def detect(image_bytes: bytes, labels: list[str]) -> list[dict[str, Any]]:
    """Detect the given labels in the image; returns centre-based boxes for the
    ones actually present (the VLM is told NOT to invent absent labels)."""
    from providers import llm

    b64 = base64.b64encode(image_bytes).decode("ascii")
    system = (
        "You are an object detector. Given target labels and an image, return — "
        "for EACH label actually visible — one bounding box. Boxes are CENTRE-"
        "based, normalized 0..1: {label, x (centre), y (centre), w, h, score 0..1}. "
        "OMIT labels that are absent; do NOT invent them. Return JSON exactly: "
        '{"detections":[{"label":..,"x":..,"y":..,"w":..,"h":..,"score":..}]}.'
    )
    user = "Target labels: " + ", ".join(labels) + ". Detect them in the image."
    model = _detector_model()
    client = llm._client()
    messages: list[Any] = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
                },
            ],
        },
    ]
    resp = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.0,
        max_tokens=700,
        **llm._maybe_response_format(model),
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        payload = json.loads(raw[raw.find("{") : raw.rfind("}") + 1])
    except Exception:
        return []
    return parse_detections(payload)
