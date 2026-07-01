"""EDIT mode SSE stream, extracted from generate._event_stream.

Mutate the supplied image per the user's instruction and stream a single
`final` frame (or an early `error`). Isolated like ascend/expand: yields its
own frames and returns, never touching the tap/query single-`final` path.
Behaviour is byte-identical to the former inline branch; generate.py's stream
helpers (`_sse`, `_abort_if_disconnected`) and its `_condition_url_for_role`
lookup are threaded in as parameters.
"""

from __future__ import annotations

import asyncio as _asyncio
import base64
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any

from _env import env_flag
from obs import log
from providers import image as image_provider
from providers import image_edit as image_edit_provider
from providers import llm, spend

if TYPE_CHECKING:
    from generate import GenerateBody
    from providers.edit_loop import EditAttempt


async def stream_edit(
    body: GenerateBody,
    trace_id: str,
    *,
    _sse: Callable[..., bytes],
    _abort_if_disconnected: Callable[[str], Awaitable[None]],
    _condition_url_for_role: Callable[[GenerateBody, str], str | None],
) -> AsyncIterator[bytes]:
    if not body.image:
        yield _sse({"type": "error", "message": "edit mode requires an image"}, trace_id)
        return
    raw_instruction = (body.edit_instruction or body.query or "").strip()
    if not raw_instruction:
        yield _sse({"type": "error", "message": "edit mode requires an instruction"}, trace_id)
        return
    yield _sse({"type": "status", "stage": "planning"}, trace_id)
    # Style consistency on edits: the web client already sends the session
    # style lock + a "style" condition ref, but the edit path used to drop
    # both. Thread the text lock into the polish and the exemplar image into
    # the edit so an edit can't drift the world's art medium.
    edit_style_lock = (body.session_style_anchor or "").strip() or None
    edit_style_ref = _condition_url_for_role(body, "style")
    # Mask-scoped judged edit (EDIT_REGION, default off): the drag
    # selection arrives as a white=edit mask PNG; flux fill repaints
    # ONLY that region (the 2026-06-10 smoke: outside-mask pixels come
    # back byte-identical) and the edit loop judges by construction —
    # outside stability is a free pixel-diff, the inside gets the
    # alignment + medium critics, one retry folds their rationales
    # back in. Flag off or no mask -> the legacy whole-image path
    # below, byte-identical to today.
    if env_flag("EDIT_REGION") and body.edit_mask:
        from providers import edit_loop, judge
        from providers import inpaint as inpaint_provider
        from providers.render_loop import data_url_bytes

        described = await llm.polish_fill_description(
            instruction=raw_instruction,
            page_title=body.parent_title,
            style_anchor=edit_style_lock,
        )
        yield _sse(
            {
                "type": "status",
                "stage": "generating_image",
                "page_title": raw_instruction,
            },
            trace_id,
        )
        edit_mask: str = body.edit_mask

        async def _render_inpaint(suffix: str) -> Any:
            instr = described if not suffix else f"{described}\n\n{suffix}"
            return await inpaint_provider.inpaint_image(
                image_data_url=body.image or "",
                mask_data_url=edit_mask,
                instruction=instr,
                model_override=body.image_model,
            )

        source_bytes = data_url_bytes(body.image)
        mask_bytes = data_url_bytes(body.edit_mask)
        region_box = (
            (
                body.edit_region.x,
                body.edit_region.y,
                body.edit_region.w,
                body.edit_region.h,
            )
            if body.edit_region
            else None
        )
        verdict: dict[str, Any] | None = None
        if (
            body.verify is False
            or source_bytes is None
            or mask_bytes is None
        ):
            # Remote refs / undecodable inputs (or the user opted out
            # of verification): a single un-judged shot (the loop's
            # no-critic rule) — the result is still mask-scoped by
            # the model.
            if body.verify is not False:
                log(
                    "warn",
                    "edit.loop.unjudged",
                    reason="source_or_mask_not_data_url",
                )
            inp_result = await _render_inpaint("")
        else:
            edit_cfg = edit_loop.edit_loop_config_from_env(body.max_attempts)
            edit_attempts: list[EditAttempt] = []
            # The alignment judge checks the inside crop against the
            # fill DESCRIPTION (the region's expected final content) —
            # a raw command like "remove the tower" isn't judgeable
            # against pixels, its described aftermath is.
            async for edit_att in edit_loop.iter_edit_attempts(
                _render_inpaint,
                source_bytes=source_bytes,
                mask_png=mask_bytes,
                region_box=region_box,
                judge_alignment=judge.score_prompt_alignment,
                judge_medium=judge.score_style_pair,
                instruction=described,
                config=edit_cfg,
                abort=_abort_if_disconnected,
            ):
                edit_attempts.append(edit_att)
                # Stream only verdict-REJECTED attempts (a correction
                # is coming); a degraded attempt is the final.
                if (
                    not edit_att.accepted
                    and edit_att.alignment is not None
                    and edit_att.index + 1 < edit_cfg.max_attempts
                ):
                    frame_b64 = (
                        await _asyncio.to_thread(
                            base64.b64encode, edit_att.image.jpeg_bytes
                        )
                    ).decode("ascii")
                    yield _sse(
                        {
                            "type": "progress",
                            "frame_index": edit_att.index,
                            "jpeg_b64": frame_b64,
                        },
                        trace_id,
                    )
            edit_loop_result = edit_loop.conclude_edit(edit_attempts)
            inp_result = edit_loop_result.image
            best = edit_loop_result.best
            verdict = {
                "alignment": best.alignment.score if best.alignment else None,
                "medium": best.medium.score if best.medium else None,
                "outside_change": best.outside_change,
                "attempts": len(edit_attempts),
                "accepted": edit_loop_result.accepted,
            }
        final_frame: dict[str, Any] = {
            "type": "final",
            "image_data_url": image_provider.encode_data_url(
                inp_result.jpeg_bytes, inp_result.mime_type
            ),
            "page_title": raw_instruction,
            "image_model": inp_result.model,
            "prompt_author_model": llm._text_model(online=False),
            "session_id": body.session_id,
            "final_prompt": described,
            "image_op": "inpaint",
            "session_spend_estimate": spend.record_generation(
                body.session_id,
                inp_result.model,
                # every loop attempt billed an inpaint; unjudged = one
                images=len(edit_attempts) if verdict is not None else 1,
            ),
        }
        if verdict is not None:
            final_frame["edit_verdict"] = verdict
        yield _sse(final_frame, trace_id)
        return
    polished = await llm.polish_edit_instruction(
        instruction=raw_instruction,
        page_title=body.parent_title,
        style_anchor=edit_style_lock,
    )
    yield _sse(
        {
            "type": "status",
            "stage": "generating_image",
            "page_title": raw_instruction,
        },
        trace_id,
    )
    # Judged whole-image edits (EDIT_JUDGE, default off — E3): the same
    # edit_loop as the mask path, minus the outside gate (no mask = no
    # confinement promise): alignment judged on the full frame against
    # the polished instruction + the medium critic vs the source, one
    # rationale-folding retry, verdict on the final frame. Undecodable
    # source (remote ref) falls through to the legacy un-judged call.
    if env_flag("EDIT_JUDGE") and body.verify is not False:
        from providers import edit_loop, judge
        from providers.render_loop import data_url_bytes

        judge_source = data_url_bytes(body.image)
        if judge_source is not None:

            async def _render_judged_edit(suffix: str) -> Any:
                instr = polished if not suffix else f"{polished}\n\n{suffix}"
                return await image_edit_provider.edit_image(
                    image_data_url=body.image or "",
                    instruction=instr,
                    tier=body.image_tier,
                    model_override=body.image_model,
                    style_ref_url=edit_style_ref,
                )

            judge_cfg = edit_loop.edit_loop_config_from_env(body.max_attempts)
            judged_attempts: list[EditAttempt] = []
            async for judged_att in edit_loop.iter_edit_attempts(
                _render_judged_edit,
                source_bytes=judge_source,
                mask_png=None,
                region_box=None,
                judge_alignment=judge.score_prompt_alignment,
                judge_medium=judge.score_style_pair,
                instruction=polished,
                config=judge_cfg,
                abort=_abort_if_disconnected,
            ):
                judged_attempts.append(judged_att)
                # Stream only verdict-REJECTED attempts (a correction
                # is coming); a degraded attempt is the final.
                if (
                    not judged_att.accepted
                    and judged_att.alignment is not None
                    and judged_att.index + 1 < judge_cfg.max_attempts
                ):
                    frame_b64 = (
                        await _asyncio.to_thread(
                            base64.b64encode, judged_att.image.jpeg_bytes
                        )
                    ).decode("ascii")
                    yield _sse(
                        {
                            "type": "progress",
                            "frame_index": judged_att.index,
                            "jpeg_b64": frame_b64,
                        },
                        trace_id,
                    )
            judged_result = edit_loop.conclude_edit(judged_attempts)
            judged_best = judged_result.best
            # The loop types images as the Rendered protocol; this is
            # the GeneratedImage our render closure returned.
            judged_image: Any = judged_result.image
            yield _sse(
                {
                    "type": "final",
                    "image_data_url": image_provider.encode_data_url(
                        judged_image.jpeg_bytes,
                        judged_image.mime_type,
                    ),
                    "page_title": raw_instruction,
                    "image_model": judged_image.model,
                    "prompt_author_model": llm._text_model(online=False),
                    "session_id": body.session_id,
                    "final_prompt": polished,
                    "session_spend_estimate": spend.record_generation(
                        body.session_id,
                        judged_image.model,
                        images=len(judged_attempts),
                    ),
                    "edit_verdict": {
                        "alignment": (
                            judged_best.alignment.score
                            if judged_best.alignment
                            else None
                        ),
                        "medium": (
                            judged_best.medium.score
                            if judged_best.medium
                            else None
                        ),
                        "outside_change": judged_best.outside_change,
                        "attempts": len(judged_attempts),
                        "accepted": judged_result.accepted,
                    },
                },
                trace_id,
            )
            return
    edit_result = await image_edit_provider.edit_image(
        image_data_url=body.image,
        instruction=polished,
        tier=body.image_tier,
        model_override=body.image_model,
        style_ref_url=edit_style_ref,
    )
    edit_data_url = image_provider.encode_data_url(
        edit_result.jpeg_bytes, edit_result.mime_type
    )
    yield _sse(
        {
            "type": "final",
            "image_data_url": edit_data_url,
            "page_title": raw_instruction,
            "image_model": edit_result.model,
            "prompt_author_model": llm._text_model(online=False),
            "session_id": body.session_id,
            "final_prompt": polished,
            "session_spend_estimate": spend.record_generation(
                body.session_id, edit_result.model
            ),
        },
        trace_id,
    )
    return
