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
import time as _time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, cast

from _env import env_flag
from obs import log, record_error
from providers import image as image_provider
from providers import image_edit as image_edit_provider
from providers import llm, model_router, spend

if TYPE_CHECKING:
    from generate import GenerateBody
    from providers.edit_loop import EditAttempt


async def stream_ascend(
    body: GenerateBody,
    trace_id: str,
    *,
    _sse: Callable[..., bytes],
    _frame_dims: Callable[[str], tuple[int, int]],
    _view_grammar_on: Callable[[], bool],
    _abort_if_disconnected: Callable[[str], Awaitable[None]],
) -> AsyncIterator[bytes]:
    if not (env_flag("SCALE_LADDER_NAV") and env_flag("SCALE_OUTWARD")):
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
    # DEFAULT = the fresh `scale_parent` container: a seamless wider view of
    # the SAME world in the SAME medium, the source as a small sub-region
    # (live-verified far more coherent than the outpaint, which leaves the
    # source a rectangle inset). The centered outpaint is opt-in
    # (SCALE_OUTWARD_OUTPAINT) for pixel-preservation, and only for a
    # same-plane hop — and now STEERS its margin with the medium so it isn't
    # photoreal. Astronomical (medium-flip) hops are always fresh.
    use_outpaint = (
        env_flag("SCALE_OUTWARD_OUTPAINT")
        and model_router.select_outward_op(from_tier, to_tier) == "outpaint_zoomout"
    )
    yield _sse({"type": "status", "stage": "rendering"}, trace_id)
    await _abort_if_disconnected("pre-ascend")
    # View grammar on the OUTWARD hop (V1 must-fix 7, split by path):
    # the pixel-preserving paths (outpaint margin / edit instruction)
    # keep the SOURCE's persisted view — coherence with the pixels they
    # extend; the fresh container is a NEW map and gets the policy's
    # deliberate top-down camera.
    src_view: dict | None = None
    if _view_grammar_on() and body.scene_view and body.scene_view.view:
        src_view = body.scene_view.view.model_dump(exclude_none=True)
    from providers.prompt_library import camera as camera_lib
    from providers.prompt_library import instructions as instructions_lib
    from providers.prompt_library import policy as view_policy
    from providers.prompt_library.types import ViewSpec as ViewSpecDict

    outward_rider = instructions_lib.outward_clause(
        cast("ViewSpecDict | None", src_view)
    )
    # DOM-labels mode: the container is a map too — render it label-free like
    # every other map path (the un-suppressed ascend hallucinated big baked
    # title lettering, e.g. "THE LAND OF IMAGINATION").
    no_lettering = ""
    if body.suppress_map_labels:
        from providers.prompt_library.style import NO_LETTERING

        no_lettering = NO_LETTERING
    render_unjudged = False
    billed_images = 1
    try:
        if use_outpaint:
            medium = style_lock or "the same hand-drawn art style as the centre"
            margin = (
                f"{medium}; extend OUTWARD into the surrounding "
                f"{to_tier.replace('_', ' ')}, drawn in the SAME style as the "
                "centre — one continuous view, NOT a photograph, no photorealism"
            )
            if outward_rider:
                margin += ". " + outward_rider
            if no_lettering:
                margin += ". " + no_lettering
            img = await image_edit_provider.expand_image_zoomout(
                body.image, 3.0, pw, ph, prompt=margin
            )
            page_title = f"The surrounding {to_tier.replace('_', ' ')}".title()
            final_prompt = f"outward outpaint: {from_tier} -> {to_tier}"
        else:
            plan = await llm.plan_page(
                query=(
                    f"the {to_tier.replace('_', ' ')} that contains "
                    f"{body.query or 'this place'}"
                ),
                web_search=False,
                style_anchor=style_lock,
                render_mode="scale_parent",
            )
            if env_flag("SCALE_OUTWARD_EDIT_REF", "true"):
                # The source ref is a no-op on the text-to-image endpoint
                # (research 01-model-bakeoff); the edit endpoint honors it, so
                # the container continues the source's medium + content instead
                # of free-styling. Default ON (kill-switch =false) — the inert
                # ref path exists only as the revert.
                medium = style_lock or "the same hand-drawn art style as the centre"
                ascend_instr = (
                    f"Zoom OUT to reveal the surrounding {to_tier.replace('_', ' ')}, "
                    f"keeping this exact view as the centre. {medium}; one continuous "
                    "view in that style, NOT a photograph, no photorealism."
                )
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
                from providers import edit_loop, judge
                from providers.render_loop import data_url_bytes

                source_bytes = data_url_bytes(body.image)
                if source_bytes is None:
                    # Remote-ref source can't feed the medium judge — render
                    # once and say so instead of pretending it was verified.
                    img = await image_edit_provider.edit_image(
                        body.image, ascend_instr
                    )
                    render_unjudged = True
                else:
                    ascend_cfg = edit_loop.edit_loop_config_from_env(
                        body.max_attempts
                    )
                    ascend_deadline = _time.monotonic() + 720.0
                    captured_instr = ascend_instr
                    source_url: str = body.image

                    async def _render_ascend(suffix: str) -> Any:
                        instr = (
                            captured_instr
                            if not suffix
                            else f"{captured_instr}\n\n{suffix}"
                        )
                        return await image_edit_provider.edit_image(
                            source_url, instr
                        )

                    ascend_attempts: list[EditAttempt] = []
                    async for asc_att in edit_loop.iter_edit_attempts(
                        _render_ascend,
                        source_bytes=source_bytes,
                        mask_png=None,
                        region_box=None,
                        judge_alignment=judge.score_prompt_alignment,
                        judge_medium=judge.score_style_pair,
                        instruction=ascend_instr,
                        config=ascend_cfg,
                        abort=_abort_if_disconnected,
                        deadline_s=ascend_deadline,
                    ):
                        ascend_attempts.append(asc_att)
                    asc_res = edit_loop.conclude_edit(ascend_attempts)
                    img = cast("Any", asc_res.best.image)
                    billed_images = max(1, len(ascend_attempts))
                    # Critic degraded (judge failure → single blind attempt):
                    # the render shipped without a verdict — flag it.
                    render_unjudged = asc_res.best.alignment is None
            else:
                # Fresh container = a NEW map: state the deliberate
                # top-down camera (None on astro rungs → legacy bytes).
                ascend_prompt = plan.prompt
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
            page_title = plan.page_title or f"The surrounding {to_tier.replace('_', ' ')}".title()
            final_prompt = plan.prompt
    except Exception as exc:
        log("warn", "ascend.failed", error=f"{type(exc).__name__}: {exc}")
        record_error("ascend", exc)
        yield _sse({"type": "error", "message": f"ascend failed: {exc}"}, trace_id)
        return
    data_url = await _asyncio.to_thread(
        image_provider.encode_data_url, img.jpeg_bytes, img.mime_type
    )
    # Spend accounting: this OUTWARD hop made real paid image calls (one per
    # judged attempt) — record them so the cap actually counts them.
    spend.record_generation(body.session_id, img.model, images=billed_images)
    ascend_payload: dict[str, Any] = {
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
