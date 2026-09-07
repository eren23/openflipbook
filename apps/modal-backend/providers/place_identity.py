"""Opt-in identity verification. No unjudged or keep-best output is publishable."""
from __future__ import annotations

import asyncio
import io
import math
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from PIL import Image

from providers import judge
from providers.generate_modes._events import ViewVerdict
from providers.image import GeneratedImage, encode_data_url
from providers.render_budget import RenderBudget
from providers.render_loop import data_url_bytes


def floor(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except (ValueError, TypeError):
        return default
    return value if math.isfinite(value) and 0 < value <= 10 else default


def reference_crop(data_url: str, box: Any) -> bytes:
    raw = data_url_bytes(data_url)
    values = (box.x_pct, box.y_pct, box.w_pct, box.h_pct)
    if raw is None or len(raw) > 20 * 1024 * 1024 or not all(math.isfinite(v) for v in values):
        raise ValueError("Invalid place reference")
    x, y, w, h = values
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1 or y + h > 1:
        raise ValueError("Invalid place reference crop")
    with Image.open(io.BytesIO(raw)) as source:
        if source.width * source.height > 40_000_000:
            raise ValueError("Place reference is too large")
        bounds = (int(x * source.width), int(y * source.height), math.ceil((x + w) * source.width), math.ceil((y + h) * source.height))
        crop = source.crop(bounds).convert("RGB")
        out = io.BytesIO()
        crop.save(out, format="PNG")
        return out.getvalue()


@dataclass
class VerifiedRender:
    image: GeneratedImage
    verdict: ViewVerdict
    grounding: dict[str, Any] | None
    reason: str

    def rejection(self) -> dict[str, Any]:
        return {
            "type": "error",
            "message": f"{self.reason} Your world is unchanged.",
            "candidate_image_data_url": encode_data_url(self.image.jpeg_bytes, self.image.mime_type),
            "view_verdict": self.verdict,
        }


async def verify_and_render(
    render: Callable[[str, int], Awaitable[GeneratedImage]],
    *,
    budget: RenderBudget,
    reference: bytes,
    label: str,
    visual: str,
    projection: str,
    facts: list[str],
    abort: Callable[[str], Awaitable[None]],
    interior: bool = False,
    zoom: bool = False,
    map_zoom: bool = False,
    outward: bool = False,
    grounding: Callable[[GeneratedImage], Awaitable[dict[str, Any] | None]] | None = None,
) -> VerifiedRender:
    limits = {
        "same_place": floor("WORLD_IDENTITY_ACCEPT_PLACE", 7),
        "medium": floor("WORLD_IDENTITY_ACCEPT_MEDIUM", 7),
        "conformance": floor("WORLD_IDENTITY_ACCEPT_CONFORMANCE", 7),
        "detail": floor("TAP_ZOOM_DETAIL_ACCEPT" if map_zoom else "VIEW_LOOP_ACCEPT_DETAIL", 6),
        "interior": floor("INTERIOR_ACCEPT", 6),
    }
    best: VerifiedRender | None = None
    best_score = -1.0
    suffix = ""
    for index in range(budget.limit):
        if budget.attempts >= budget.limit or time.monotonic() >= budget.deadline:
            break
        await abort("strict-render")
        try:
            image = await render(suffix, index)
        except Exception:
            if best is None:
                raise
            break
        await abort("strict-verify")
        calls: dict[str, Awaitable[Any]] = {
            "medium": judge.score_style_pair(reference, image.jpeg_bytes),
            "conformance": judge.score_view_conformance(image.jpeg_bytes, projection),
        }
        if outward:
            calls["same_place"] = judge.score_outward_place(reference, image.jpeg_bytes)
        elif interior:
            calls["interior"] = judge.score_interior(reference, image.jpeg_bytes)
        else:
            calls["same_place"] = judge.score_entity_consistency(label, visual, reference, image.jpeg_bytes)
        if not outward:
            calls["detail"] = judge.score_map_legibility(image.jpeg_bytes) if map_zoom else judge.score_feature_articulation(image.jpeg_bytes, label, facts)
        if zoom:
            calls["direction"] = judge.score_step_in(reference, image.jpeg_bytes)
        if grounding:
            calls["spatial"] = grounding(image)
        # All judges review these exact final bytes. No corrective edit runs
        # after this gate; a retry is a new attempt through the entire gate.
        results = await asyncio.gather(*(
            asyncio.wait_for(call, timeout=max(0.01, min(75.0, budget.deadline - time.monotonic())))
            for call in calls.values()
        ), return_exceptions=True)
        scores: dict[str, float | None] = {}
        report = None
        failures: list[str] = []
        for axis, result in zip(calls, results, strict=True):
            if axis == "spatial":
                report = result if isinstance(result, dict) else None
                value = report.get("score") if report else None
                ok = report is not None and isinstance(value, (int, float)) and math.isfinite(value) and 0.7 <= value <= 1 and not report.get("missing")
                if not ok:
                    failures.append("Spatial layout could not be verified")
                continue
            value = getattr(result, "score", None)
            score = float(value) if isinstance(value, (float, int)) and math.isfinite(value) and 0 <= value <= 10 else None
            scores[axis] = score
            if score is None or score < limits.get(axis, limits["same_place"]):
                failures.append(f"{axis.replace('_', ' ').capitalize()}: {getattr(result, 'rationale', 'judge unavailable')[:180]}")
        if zoom:
            values = [scores.get("conformance"), scores.get("direction")]
            present = [v for v in values if v is not None]
            scores["conformance"] = min(present) if len(present) == 2 else None
        receipt: ViewVerdict = {
            "same_place": scores.get("same_place"), "conformance": scores.get("conformance"),
            "medium": scores.get("medium"), "detail": scores.get("detail"), "interior": scores.get("interior"),
            "attempts": max(index + 1, budget.attempts), "accepted": not failures,
        }
        candidate = VerifiedRender(image, receipt, report, "Quality checks did not pass." if failures else "")
        score = min((v if v is not None else -1) for v in scores.values())
        if not failures:
            return candidate
        if best is None or score > best_score:
            best, best_score = candidate, score
        suffix = "The previous attempt failed verification. Correct these issues without changing the established place: " + "; ".join(failures)
        if budget.deadline - time.monotonic() < 45:
            break
    if best is None:
        raise RuntimeError("No verified image could be produced within the limit")
    best.verdict["attempts"] = max(best.verdict["attempts"], budget.attempts)
    return best
