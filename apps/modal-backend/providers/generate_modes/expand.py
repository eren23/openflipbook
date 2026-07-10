"""Expand-mode SSE stream, extracted from generate._event_stream.

Bloom the world AROUND the focal subject by proposing neighbouring subjects or,
when EXPAND_MAP_PAN is enabled, by outpainting the current world in four
directions. Behaviour is byte-identical to the former inline branch;
generate.py's stream helpers are threaded in as parameters.
"""

from __future__ import annotations

import asyncio as _asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING

from _env import env_flag
from obs import log, record_error
from providers import image as image_provider
from providers import image_edit as image_edit_provider
from providers import llm, spend

if TYPE_CHECKING:
    from generate import GenerateBody
    from providers.image import GeneratedImage
    from providers.llm import Neighbor, PagePlan


async def stream_expand(
    body: GenerateBody,
    trace_id: str,
    *,
    _sse: Callable[..., bytes],
    _frame_dims: Callable[[str], tuple[int, int]],
    _view_grammar_on: Callable[[], bool],
    _abort_if_disconnected: Callable[[str], Awaitable[None]],
) -> AsyncIterator[bytes]:
    if not body.image:
        yield _sse(
            {"type": "error", "message": "expand mode requires an image"},
            trace_id,
        )
        return

    # Map-pan (flag-gated): instead of blooming neighbour SUBJECTS,
    # outpaint the parent OUTWARD in four directions so "expand" pans the
    # same continuous world — like moving across a map (BRIA, bakeoff
    # winner). Reuses the neighbor/expand_done stream + abort handling;
    # flag off → the subject bloom below, unchanged.
    if os.environ.get("EXPAND_MAP_PAN", "false").lower() in ("1", "true", "yes"):
        yield _sse({"type": "status", "stage": "planning"}, trace_id)
        _dirs = [
            ("west", "Westward"),
            ("east", "Eastward"),
            ("north", "Northward"),
            ("south", "Southward"),
        ]
        pw, ph = _frame_dims(body.aspect_ratio)
        total = len(_dirs)
        parent_image = body.image  # non-None (checked above); narrows for the closure

        async def _pan_one(idx: int, direction: str) -> tuple[int, str, GeneratedImage]:
            img = await image_edit_provider.expand_image(parent_image, direction, pw, ph)
            return idx, direction, img

        await _abort_if_disconnected("pre-pan")
        pan_tasks = [_asyncio.create_task(_pan_one(i, d[0])) for i, d in enumerate(_dirs)]
        emitted = 0
        try:
            for pan_fut in _asyncio.as_completed(pan_tasks):
                try:
                    idx, direction, img = await pan_fut
                except Exception as exc:
                    log(
                        "warn",
                        "expand.pan_failed",
                        error=f"{type(exc).__name__}: {exc}",
                    )
                    record_error("expand_pan", exc)
                    continue
                data_url = await _asyncio.to_thread(
                    image_provider.encode_data_url, img.jpeg_bytes, img.mime_type
                )
                # Spend accounting: each map-pan tile is a real paid image
                # edit — record it so the cap counts these concurrent calls.
                spend.record(body.session_id, spend.estimate_image(img.model))
                emitted += 1
                yield _sse(
                    {
                        "type": "neighbor",
                        "subject": _dirs[idx][1],
                        "scale": "peer",
                        "page_title": _dirs[idx][1],
                        "image_data_url": data_url,
                        "image_model": img.model,
                        "prompt_author_model": "",
                        "final_prompt": f"map-pan {direction}",
                        "session_id": body.session_id,
                        "index": idx,
                        "total": total,
                    },
                    trace_id,
                )
        finally:
            for pan_task in pan_tasks:
                if not pan_task.done():
                    pan_task.cancel()
        yield _sse(
            {"type": "expand_done", "count": emitted, "failed": total - emitted},
            trace_id,
        )
        return

    expand_style_lock = (body.session_style_anchor or "").strip() or None
    expand_world_context = [e.model_dump() for e in body.world_context]
    yield _sse({"type": "status", "stage": "planning"}, trace_id)
    await _abort_if_disconnected("pre-expand-plan")
    around_on = env_flag("SCALE_AROUND_LOGICAL")
    neighbors = await llm.propose_neighbors(
        image_data_url=body.image,
        parent_title=body.parent_title or body.query,
        parent_query=body.parent_query or body.query,
        output_locale=body.output_locale,
        known_neighbors=body.known_neighbors if around_on else None,
        scale_tier=body.around_tier if around_on else None,
    )
    total = len(neighbors)
    if total == 0:
        yield _sse({"type": "expand_done", "count": 0, "failed": 0}, trace_id)
        return

    # Image conditioning: every neighbour shares the parent's world + the
    # session anchor so the whole bloom reads as one continuous place
    # (same refs for all; directional edge-crops deferred). Flag-gated.
    expand_cond_refs: list[str] | None = None
    expand_cond_preamble = ""
    if env_flag("IMAGE_CONDITIONING", "true") and body.condition_image_urls:
        expand_cond_refs = body.condition_image_urls
        expand_cond_preamble = image_provider.conditioning_preamble(
            body.condition_roles or [], "expand"
        )

    async def _bloom_one(
        idx: int, neighbor: Neighbor
    ) -> tuple[int, Neighbor, PagePlan, GeneratedImage]:
        plan = await llm.plan_page(
            query=neighbor.subject,
            web_search=False,
            style_anchor=expand_style_lock,
            output_locale=body.output_locale,
            parent_title=body.parent_title,
            parent_query=body.parent_query,
            world_context=expand_world_context,
        )
        prompt = plan.prompt
        if expand_style_lock:
            prompt = f"Style: {expand_style_lock}\n\n{prompt}"
        if plan.facts and not body.suppress_map_labels:
            prompt += "\n\nLabels to include:\n- " + "\n- ".join(plan.facts)
        if body.suppress_map_labels:
            from providers.prompt_library.style import NO_LETTERING

            prompt += f"\n\n{NO_LETTERING}"
        if expand_cond_preamble:
            prompt = expand_cond_preamble + prompt
        img = await image_provider.generate_image(
            prompt=prompt,
            aspect_ratio=body.aspect_ratio,
            tier=body.image_tier,
            model_override=body.image_model,
            reference_urls=expand_cond_refs,
        )
        return idx, neighbor, plan, img

    # Last gate before we spend on ~4 concurrent fal jobs: if the client
    # dropped during propose_neighbors, bail before launching any.
    await _abort_if_disconnected("pre-bloom")
    tasks = [_asyncio.create_task(_bloom_one(i, n)) for i, n in enumerate(neighbors)]
    emitted = 0
    try:
        for bloom_fut in _asyncio.as_completed(tasks):
            try:
                idx, neighbor, plan, img = await bloom_fut
            except Exception as exc:
                # One neighbour failing shouldn't sink the whole bloom,
                # but a systematic failure (quota, bad style lock) should
                # still surface in Sentry rather than vanish into a warn.
                log(
                    "warn",
                    "expand.neighbor_failed",
                    error=f"{type(exc).__name__}: {exc}",
                )
                record_error("expand_neighbor", exc)
                continue
            # Offload the sync base64 of a multi-MB JPEG so it doesn't
            # stall the event loop between yields (matches the tap path).
            data_url = await _asyncio.to_thread(
                image_provider.encode_data_url, img.jpeg_bytes, img.mime_type
            )
            # Spend accounting: each bloom neighbour is a real plan+image
            # generation — record it so the cap counts the concurrent fan-out.
            spend.record_generation(body.session_id, img.model)
            emitted += 1
            yield _sse(
                {
                    "type": "neighbor",
                    "subject": neighbor.subject,
                    "scale": neighbor.scale,
                    "page_title": plan.page_title,
                    "image_data_url": data_url,
                    "image_model": img.model,
                    "prompt_author_model": llm._text_model(online=False),
                    "final_prompt": plan.prompt,
                    "session_id": body.session_id,
                    "index": idx,
                    "total": total,
                },
                trace_id,
            )
    finally:
        # Client disconnect / early exit cancels any in-flight pages so
        # we don't keep burning fal credits with no one listening.
        for bloom_task in tasks:
            if not bloom_task.done():
                bloom_task.cancel()
    yield _sse(
        {"type": "expand_done", "count": emitted, "failed": total - emitted},
        trace_id,
    )
    return
