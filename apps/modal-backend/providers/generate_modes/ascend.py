"""OUTWARD / zoom-out (`ascend`) SSE stream, extracted from generate._event_stream.

Synthesize the CONTAINER that holds the current root and stream it back as
`ascend_ready` — the web /ascend route persists the reparent. Isolated like
edit/expand: yields its own frames and returns, never touching the tap/query
single-`final` path. Behaviour is byte-identical to the former inline branch;
generate.py's stream helpers (`_sse`, `_frame_dims`, `_view_grammar_on`,
`_abort_if_disconnected`) are threaded in as parameters.
"""

from __future__ import annotations

import asyncio as _asyncio
import dataclasses
import math
import os
import time as _time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, cast

from _env import env_flag
from obs import log, record_error
from providers import image as image_provider
from providers import image_edit as image_edit_provider
from providers import llm, model_router, spend
from providers.generate_modes._events import GenerateAscendReadyEvent

if TYPE_CHECKING:
    from generate import GenerateBody
    from providers.edit_loop import EditAttempt
    from providers.image import GeneratedImage
    from providers.prompt_library.types import ViewSpec as ViewSpecDict


_GENERIC_SOURCE_LABELS = {
    "",
    "uploaded image",
    "uploaded map",
    "image upload",
    "untitled image",
    "untitled map",
}


def _clean_text(value: str | None, limit: int = 800) -> str:
    text = " ".join((value or "").split())
    if limit > 3 and len(text) > limit:
        return text[: limit - 3].rstrip() + "..."
    return text


def _is_generic_source_label(value: str | None) -> bool:
    return _clean_text(value).lower() in _GENERIC_SOURCE_LABELS


def _outward_world_context(body: GenerateBody) -> list[dict[str, Any]]:
    """Planner-ready source entities, capped before they hit prompt text."""

    out: list[dict[str, Any]] = []
    for entity in body.world_context[:8]:
        data = entity.model_dump(exclude_none=True)
        name = _clean_text(str(data.get("name", "")), 120)
        if not name or _is_generic_source_label(name):
            continue
        data["name"] = name
        out.append(data)
    return out


def _source_entity_names(world_context: list[dict[str, Any]]) -> list[str]:
    def _kind(entry: dict[str, Any]) -> str:
        return _clean_text(str(entry.get("kind", ""))).lower()

    names: list[str] = []
    for entry in [
        *(e for e in world_context if _kind(e) == "place"),
        *(e for e in world_context if _kind(e) != "place"),
    ]:
        name = _clean_text(str(entry.get("name", "")), 120)
        if not name or _is_generic_source_label(name):
            continue
        key = name.lower()
        if any(existing.lower() == key for existing in names):
            continue
        names.append(name)
        if len(names) >= 8:
            break
    return names


def _outward_source_label(
    body: GenerateBody, world_context: list[dict[str, Any]], source_identity: str
) -> str:
    label = _clean_text(body.query, 160)
    if label and not _is_generic_source_label(label):
        return label
    names = _source_entity_names(world_context)
    if names:
        return f"the established source map of {names[0]}"
    if source_identity:
        return "this established source map"
    return "this place"


def _outward_identity_clause(
    body: GenerateBody, world_context: list[dict[str, Any]]
) -> str:
    parts: list[str] = []
    outward_context = _clean_text(body.outward_context, 1000)
    if outward_context:
        parts.append(outward_context)
    names = _source_entity_names(world_context)
    if names:
        summary = f"Known source entities: {', '.join(names)}."
        if summary.lower() not in outward_context.lower():
            parts.append(summary)
    if not parts:
        return ""
    parts.append(
        "The wider container MUST contain this exact source at its centre "
        "and must not rename it as a different world."
    )
    return " ".join(parts)


async def _judge_ascend(
    render: Callable[[str], Awaitable[GeneratedImage]],
    source_url: str,
    instruction: str,
    max_attempts: int | None,
    abort: Callable[[str], Awaitable[None]],
) -> tuple[GeneratedImage, bool, bool, int]:
    """Return the final image, unjudged/rejected flags, and billed attempts."""
    from providers import edit_loop, judge
    from providers.render_loop import data_url_bytes

    source_bytes = data_url_bytes(source_url)
    if source_bytes is None:
        return await render(""), True, False, 1
    cfg = edit_loop.edit_loop_config_from_env(max_attempts)
    try:
        floor = float(os.environ.get("SCALE_OUTWARD_ACCEPT_MEDIUM", 7.0))
    except (TypeError, ValueError):
        floor = 7.0
    if not math.isfinite(floor) or not 0 <= floor <= 10:
        floor = 7.0
    cfg = dataclasses.replace(cfg, accept_medium=floor)
    attempts: list[EditAttempt] = []
    async for attempt in edit_loop.iter_edit_attempts(
        render,
        source_bytes=source_bytes,
        mask_png=None,
        region_box=None,
        judge_alignment=judge.score_prompt_alignment,
        judge_medium=judge.score_style_pair,
        instruction=instruction,
        config=cfg,
        abort=abort,
        deadline_s=_time.monotonic() + 720.0,
    ):
        attempts.append(attempt)
    best = edit_loop.conclude_edit(attempts).best
    unjudged = best.alignment is None or best.medium is None
    rejected = (
        best.alignment is not None
        and (not math.isfinite(best.alignment.score) or not cfg.accept_alignment <= best.alignment.score <= 10)
    ) or (
        best.medium is not None
        and (not math.isfinite(best.medium.score) or not cfg.accept_medium <= best.medium.score <= 10)
    )
    return cast("GeneratedImage", best.image), unjudged, rejected, len(attempts)


async def stream_ascend(
    body: GenerateBody,
    trace_id: str,
    *,
    _sse: Callable[..., bytes],
    _frame_dims: Callable[[str], tuple[int, int]],
    _view_grammar_on: Callable[[], bool],
    _abort_if_disconnected: Callable[[str], Awaitable[None]],
) -> AsyncIterator[bytes]:
    if not (env_flag("SCALE_LADDER_NAV", "true") and env_flag("SCALE_OUTWARD", "true")):
        yield _sse(
            {"type": "error", "message": "OUTWARD disabled (SCALE_LADDER_NAV+SCALE_OUTWARD)"},
            trace_id,
        )
        return
    if not body.image:
        yield _sse(
            {"type": "error", "message": "ascend mode requires an image"}, trace_id
        )
        return
    from_tier = (body.scene_view.scale_tier if body.scene_view else None) or "city"
    to_tier = model_router.coarser_tier(from_tier)
    if to_tier is None:
        yield _sse(
            {"type": "error", "message": f"no coarser rung above '{from_tier}'"},
            trace_id,
        )
        return
    pw, ph = _frame_dims(body.aspect_ratio)
    style_lock = (body.session_style_anchor or "").strip() or None
    outward_world_context = _outward_world_context(body)
    source_identity = _outward_identity_clause(body, outward_world_context)
    outward_source_label = _outward_source_label(
        body, outward_world_context, source_identity
    )
    # DEFAULT = the fresh `scale_parent` container: a seamless wider view of
    # the SAME world in the SAME medium, the source as a small sub-region
    # (live-verified far more coherent than the outpaint, which leaves the
    # source a rectangle inset). The centered outpaint is opt-in
    # (SCALE_OUTWARD_OUTPAINT) for pixel-preservation, and only for a
    # same-plane hop — and now STEERS its margin with the medium so it isn't
    # photoreal. Astronomical (medium-flip) hops are always fresh.
    # Multi-hop drift guard (chain_runner.py: even the style-anchored OUTWARD
    # path loses delicate media by ~hop 2 because each hop conditions on the
    # DRIFTING previous container). Past SCALE_OUTWARD_MAX_HOPS consecutive
    # ascends, re-anchor: drop the previous-image conditioning (outpaint pixels /
    # edit ref) and render fresh from the ORIGINAL style text. Default 0 = OFF,
    # so nothing changes until it's flipped on.
    _max_hops = int(os.environ.get("SCALE_OUTWARD_MAX_HOPS", "0") or 0)
    outward_refresh = _max_hops > 0 and body.outward_depth >= _max_hops
    same_plane = model_router.select_outward_op(from_tier, to_tier) == "outpaint_zoomout"
    preserve_source = env_flag("SCALE_OUTWARD_PRESERVE_SOURCE") and same_plane
    use_outpaint = same_plane and (
        preserve_source or (env_flag("SCALE_OUTWARD_OUTPAINT") and not outward_refresh)
    )
    yield _sse({"type": "status", "stage": "rendering"}, trace_id)
    await _abort_if_disconnected("pre-ascend")
    # View grammar on the OUTWARD hop (V1 must-fix 7, split by path):
    # the pixel-preserving paths (outpaint margin / edit instruction)
    # keep the SOURCE's persisted view — coherence with the pixels they
    # extend; the fresh container is a NEW map and gets the policy's
    # deliberate top-down camera.
    src_view: ViewSpecDict | None = None
    if _view_grammar_on() and body.scene_view and body.scene_view.view:
        # model_dump() erases the static type; the Pydantic ViewSpec wire model
        # dumps to exactly the provider-side TypedDict (parity-locked).
        src_view = cast(
            "ViewSpecDict", body.scene_view.view.model_dump(exclude_none=True)
        )
    from providers.prompt_library import camera as camera_lib
    from providers.prompt_library import instructions as instructions_lib
    from providers.prompt_library import policy as view_policy

    outward_rider = instructions_lib.outward_clause(src_view)
    # DOM-labels mode: the container is a map too — render it label-free like
    # every other map path (the un-suppressed ascend hallucinated big baked
    # title lettering, e.g. "THE LAND OF IMAGINATION").
    no_lettering = ""
    if body.suppress_map_labels:
        from providers.prompt_library.style import NO_LETTERING

        no_lettering = NO_LETTERING
    render_unjudged = True
    render_rejected = False
    billed_images = 1
    try:
        if use_outpaint:
            medium = style_lock or "the same hand-drawn art style as the centre"
            margin = (
                f"{medium}; extend OUTWARD into the surrounding "
                f"{to_tier.replace('_', ' ')}, drawn in the SAME style as the "
                "centre — one continuous view, NOT a photograph, no photorealism"
            )
            if source_identity:
                margin += ". SOURCE IDENTITY LOCK: " + source_identity
            if outward_rider:
                margin += ". " + outward_rider
            if no_lettering:
                margin += ". " + no_lettering
            if preserve_source:
                margin += (
                    ". One continuous flat chart, with matching palette, linework and scale "
                    "across the original image boundary. Continue roads, rivers and terrain "
                    "across that boundary. No inset, frame, poster, desk, photograph, "
                    "or visible rectangular seam."
                )
            source_url = body.image

            def _record_outpaint(model: str) -> None:
                spend.record_generation(body.session_id, model)

            async def _render_outpaint(suffix: str) -> GeneratedImage:
                prompt = margin if not suffix else f"{margin}\n\n{suffix}"
                if preserve_source:
                    # 2x leaves 25% source area, above BRIA's recommended 15%.
                    return await image_edit_provider.expand_image_zoomout(
                        source_url, 2.0, pw, ph, prompt=prompt, preserve_source=True,
                        on_generated=_record_outpaint,
                    )
                return await image_edit_provider.expand_image_zoomout(
                    source_url, 3.0, pw, ph, prompt=prompt
                )

            img, render_unjudged, render_rejected, billed_images = await _judge_ascend(
                _render_outpaint, source_url, margin, body.max_attempts, _abort_if_disconnected
            )
            # The preservation experiment must not publish unreviewed seams.
            render_rejected |= preserve_source and render_unjudged
            page_title = f"The surrounding {to_tier.replace('_', ' ')}".title()
            final_prompt = margin
        else:
            plan_query = (
                f"the {to_tier.replace('_', ' ')} that contains "
                f"{outward_source_label}"
            )
            if source_identity:
                plan_query += ". " + source_identity
            plan = await llm.plan_page(
                query=plan_query,
                web_search=False,
                style_anchor=style_lock,
                world_context=outward_world_context or None,
                render_mode="scale_parent",
            )
            if env_flag("SCALE_OUTWARD_EDIT_REF", "true") and not outward_refresh:
                # The source ref is a no-op on the text-to-image endpoint
                # (research 01-model-bakeoff); the edit endpoint honors it, so
                # the container continues the source's medium + content instead
                # of free-styling. Default ON (kill-switch =false) — the inert
                # ref path exists only as the revert. `outward_refresh` (past the
                # hop cap) skips it too: the drifting previous hop is exactly what
                # we must NOT condition on — fall through to the fresh text render.
                medium = style_lock or "the same hand-drawn art style as the centre"
                # #252: the container is ALWAYS a wider top-down MAP continuing a
                # map source, but the generic "same art style" let nano-banana
                # crayon-restyle it (style judge medium 4.5, accepted at the
                # 6.0 floor). Demand cartographic continuity + the no-inset
                # framing (A/B on the Ankh map: 4.5 -> 7.5). NOT gated on a map
                # scene_view: uploaded-map roots carry scene_view=null (verified
                # in Mongo), so a map-level guard would skip the exact demo
                # case. Kill-switch SCALE_OUTWARD_STYLE_LOCK=false = pre-#252.
                if env_flag("SCALE_OUTWARD_STYLE_LOCK", "true"):
                    # This exact wording is A/B-chosen. The composition clause
                    # ("ONE SINGLE continuous chart", no-inset/no-desk) is robust
                    # across renders; the explicit "its exact palette" holds
                    # COLOR better than the canonical medium_lock() helper, which
                    # went monochrome (medium 6.0 vs this wording's 7.5) — output
                    # beats code-reuse here. The raised floor below retries any
                    # palette dip regardless.
                    ascend_instr = (
                        "Zoom OUT / pull the camera back to reveal the surrounding "
                        f"{to_tier.replace('_', ' ')} around this map, as ONE SINGLE "
                        "continuous hand-inked cartographer's chart at one consistent "
                        "scale on one sheet. The original walled place stays at the "
                        "EXACT CENTRE — same shape and same labels — now drawn smaller "
                        "and ringed by its surrounding lands. Keep the source's exact "
                        f"style ({medium}): the same inked linework, lettering and "
                        "palette. This is a FLAT top-down map only: do NOT draw a "
                        "map-within-a-map or an inset, no desk or table, no hand, no "
                        "photo border, NOT a photograph, no soft watercolor."
                    )
                else:
                    ascend_instr = (
                        f"Zoom OUT to reveal the surrounding {to_tier.replace('_', ' ')}, "
                        f"keeping this exact view as the centre. {medium}; one continuous "
                        "view in that style, NOT a photograph, no photorealism."
                    )
                if source_identity:
                    ascend_instr += " SOURCE IDENTITY LOCK: " + source_identity
                if outward_rider:
                    ascend_instr += " " + outward_rider
                if no_lettering:
                    ascend_instr += " " + no_lettering
                # The container hop IS a whole-image judged edit: nano-banana
                # edit follows refs loosely, and the un-judged ascend shipped
                # a full medium break (painterly session → antique chart).
                # Same harness as EDIT_REGION's whole-image arm: alignment
                # (did it zoom out as asked) + medium (same hand as the
                # source), keep-best, critic feedback folded into the retry,
                # deadline mirroring generate.INGRESS_TIMEOUT_S - 180s.
                source_url = body.image

                async def _render_ascend(suffix: str) -> GeneratedImage:
                    instr = ascend_instr if not suffix else f"{ascend_instr}\n\n{suffix}"
                    return await image_edit_provider.edit_image(source_url, instr)

                img, render_unjudged, render_rejected, billed_images = await _judge_ascend(
                    _render_ascend, source_url, ascend_instr, body.max_attempts, _abort_if_disconnected
                )
            else:
                # Fresh container = a NEW map: state the deliberate
                # top-down camera (None on astro rungs → legacy bytes).
                ascend_prompt = plan.prompt
                if source_identity:
                    ascend_prompt += "\n\nSOURCE IDENTITY LOCK: " + source_identity
                if no_lettering:
                    ascend_prompt += f"\n\n{no_lettering}"
                if _view_grammar_on():
                    asc_view = view_policy.default_view(
                        render_mode="scale_parent",
                        world_mode=True,
                        scale_tier=to_tier,
                    )
                    cam = camera_lib.camera_clause(
                        asc_view, medium=style_lock or None
                    )
                    if cam:
                        ascend_prompt += "\n\n" + cam
                img = await image_provider.generate_image(
                    ascend_prompt, body.aspect_ratio, reference_urls=[body.image]
                )
            # A degenerate plan (salvaged/failed reply) falls back to the RAW
            # query — which for OUTWARD is the whole identity clause. A page
            # title is a label, not a prompt: anything implausibly long takes
            # the tier default instead (live-caught: a 500-char breadcrumb).
            page_title = plan.page_title
            if not page_title or len(page_title) > 90:
                page_title = f"The surrounding {to_tier.replace('_', ' ')}".title()
            final_prompt = plan.prompt
    except Exception as exc:
        log("warn", "ascend.failed", error=f"{type(exc).__name__}: {exc}")
        record_error("ascend", exc)
        # Same friendly mapping as the main funnel — the raw fal body echoes
        # the whole prompt back, which must not reach the browser. Function-
        # local import: generate imports this module at call time, so a
        # module-level import would be circular.
        from generate import _friendly_error

        if env_flag("FRIENDLY_ERRORS", "true"):
            msg, detail = _friendly_error(exc)
            yield _sse({"type": "error", "message": msg, "detail": detail}, trace_id)
        else:
            yield _sse(
                {"type": "error", "message": f"ascend failed: {exc}"}, trace_id
            )
        return
    # Spend accounting: this OUTWARD hop made real paid image calls (one per
    # judged attempt) — record them so the cap actually counts them.
    if not preserve_source:
        spend.record_generation(body.session_id, img.model, images=billed_images)
    if render_rejected:
        yield _sse(
            {
                "type": "error",
                "message": "The wider view did not pass the quality checks. Your world is unchanged.",
            },
            trace_id,
        )
        return
    data_url = await _asyncio.to_thread(
        image_provider.encode_data_url, img.jpeg_bytes, img.mime_type
    )
    ascend_payload: GenerateAscendReadyEvent = {
        "type": "ascend_ready",
        "page_title": page_title,
        "image_data_url": data_url,
        "image_model": img.model,
        "prompt_author_model": "",
        "final_prompt": final_prompt,
        "scale_tier": to_tier,
        "from_tier": from_tier,
        "session_id": body.session_id,
    }
    if render_unjudged:
        # Additive: present only when the critics could not gate this render
        # (judge failure / remote-ref source) — the UI shows an "unverified
        # render" chip instead of letting flap-era drift ship silently.
        ascend_payload["render_unjudged"] = True
    yield _sse(ascend_payload, trace_id)
    return
