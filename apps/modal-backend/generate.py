"""Endless Canvas — page generation service (FastAPI on Modal).

Exposes `POST /sse/generate` as an SSE stream. The Next.js web app proxies to
this endpoint. Flow:

1. If `mode == "tap"`, resolve click coords to a subject phrase via the VLM.
2. Plan the page (title, prompt, facts) via the text LLM with optional
   `:online` web search.
3. Call fal-ai nano-banana with the composed prompt.
4. Emit SSE events: `progress` (placeholder, for future progressive models)
   and `final` with the base64 JPEG and metadata.
"""

from __future__ import annotations

import asyncio as _asyncio
import base64
import contextlib
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

APP_NAME = "openflipbook-generate"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install_from_requirements("requirements.txt")
    .add_local_python_source("providers")
    .add_local_python_source("obs")
)

secrets = [
    modal.Secret.from_name(
        "openflipbook-secrets",
        required_keys=["FAL_KEY", "OPENROUTER_API_KEY"],
    )
]

app = modal.App(APP_NAME, image=image)
fastapi_app = FastAPI(title="Endless Canvas — generate")


class Click(BaseModel):
    x_pct: float = Field(ge=0.0, le=1.0)
    y_pct: float = Field(ge=0.0, le=1.0)


class WorldContextEntity(BaseModel):
    id: str
    kind: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    appearance: str
    reference_image_url: str | None = None
    state: dict[str, Any] = Field(default_factory=dict)


# Geometric world model — Pydantic mirrors of the packages/config TS shapes.
# Kept in field-parity with index.ts (the P0 schema-parity gate guards drift).
class WorldVec2(BaseModel):
    x: float
    y: float


class ObserverPose(BaseModel):
    pos: WorldVec2
    eye_height: float
    gaze: float
    fov: float


class MapCrop(BaseModel):
    x: float
    y: float
    w: float
    h: float


class SceneView(BaseModel):
    node_id: str
    level: str
    observer: ObserverPose | None = None
    map_crop: MapCrop | None = None


class ProjectedEntity(BaseModel):
    id: str
    label: str
    x_pct: float
    y_pct: float
    w_pct: float
    h_pct: float
    depth: float
    h_pos: str
    v_pos: str
    size: str


class GenerateBody(BaseModel):
    query: str
    aspect_ratio: str = "16:9"
    web_search: bool = True
    session_id: str
    current_node_id: str = ""
    mode: str = "query"
    image: str | None = None
    parent_query: str | None = None
    parent_title: str | None = None
    click: Click | None = None
    click_hint: str | None = None
    image_tier: str | None = None
    image_model: str | None = None
    edit_instruction: str | None = None
    output_locale: str | None = None
    prefetched_subject: str | None = None
    prefetched_style: str | None = None
    prefetched_subject_context: str | None = None
    # World Mode semi-autonomy already resolved the tap client-side; this carries
    # the resolver's spatial-anchor note back so the planner can keep the
    # entered place's neighbours where the parent map had them.
    prefetched_surroundings: str | None = None
    # Multi-turn refer (SAMA / MM-Conv pattern): when the user rejects a
    # resolved subject and taps again nearby, the client forwards the
    # rejected phrase so the VLM picks something different.
    prior_rejected_subject: str | None = None
    session_style_anchor: str | None = None
    # Phase 3 — world-memory continuity. Web proxy resolves a slim slice
    # of the session's registry before forwarding; planner injects each
    # entity's `appearance` into the image prompt so recurring characters
    # / places stay visually consistent across pages. Capped server-side.
    world_context: list[WorldContextEntity] = Field(
        default_factory=list, max_length=16
    )
    # Image conditioning — ordered reference data URLs (region crop → parent →
    # anchor) the generator blends so the page stays in the same world.
    # `condition_roles` labels each url in order. Built client-side. Capped.
    condition_image_urls: list[str] | None = Field(default=None, max_length=4)
    condition_roles: list[str] | None = None
    # World Mode (gated server-side by the WORLD_MODE env). When on, a tap
    # ENTERS the tapped place (scene / closer sub-map) instead of explaining a
    # topic. `render_mode` is an explicit framing override; otherwise the click
    # classifier's `enter_as` decides. `autonomy` is carried for symmetry.
    world_mode: bool = False
    autonomy: str = "auto"
    render_mode: str | None = None
    # Geometric world (GEOMETRIC_WORLD): the scene's observer pose/level + the
    # geometry engine's expected per-entity layout for this frame.
    scene_view: SceneView | None = None
    expected_layout: list[ProjectedEntity] = Field(default_factory=list)
    trace_id: str | None = None


# World Mode is gated behind an env flag (default off) so it's a no-op in prod
# until a deployer turns it on — like EXPAND_MAP_PAN / IMAGE_CONDITIONING.
def _world_mode_on(requested: bool) -> bool:
    return bool(requested) and os.environ.get("WORLD_MODE", "false").lower() in (
        "1", "true", "yes",
    )


# The click classifier's `enter_as` → the planner's render mode.
_ENTER_AS_TO_RENDER: dict[str, str] = {
    "scene": "place_scene",
    "submap": "place_submap",
    "explainer": "explainer",
}


def _sse(data: dict, trace_id: str | None = None) -> bytes:
    """Encode an SSE event. Trace ID rides on every payload so the browser
    can stamp it on its perf-HUD timeline without needing a side channel."""
    if trace_id and "trace_id" not in data:
        data = {**data, "trace_id": trace_id}
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


async def _event_stream(
    body: GenerateBody,
    trace_id: str,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[bytes]:
    import time as _time

    from obs import bind_trace, log, record_error
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm

    bind_trace(trace_id)
    started = _time.perf_counter()
    log("info", "sse.generate.start", mode=body.mode, locale=body.output_locale)

    async def _abort_if_disconnected(stage: str) -> None:
        """Raise CancelledError when the client has dropped the SSE socket.

        FastAPI exposes `Request.is_disconnected()` which polls the underlying
        asgi receive channel. Calling it between expensive stages means a
        client `AbortController.abort()` actually halts the planner / image-gen
        path instead of letting it run to completion (and burn fal credits)
        with no one listening.

        Each abort is recorded in obs so /trace/abort-stats can show how
        much wall-time (and $) we save by polling here.
        """
        if is_disconnected is None:
            return
        try:
            if await is_disconnected():
                from obs import record_abort

                elapsed_ms = (_time.perf_counter() - started) * 1000.0
                log(
                    "info",
                    "sse.generate.client_disconnect",
                    stage=stage,
                    elapsed_ms=round(elapsed_ms, 2),
                )
                record_abort(
                    stage,
                    elapsed_ms,
                    trace_id=trace_id,
                    extra={"mode": body.mode},
                )
                raise _asyncio.CancelledError()
        except _asyncio.CancelledError:
            raise
        except Exception:
            # Polling failure shouldn't block the pipeline.
            pass

    # Tap-mode disables web search by default. The planner already has the
    # parent illustration, parent title, and subject_context as constraints,
    # so an online lookup adds 500-2000ms of variance for marginal value and
    # tends to drift the page out of the parent domain. Override with
    # WEB_SEARCH_ON_TAP=true if you want the legacy behaviour back.
    web_search_on_tap = os.environ.get("WEB_SEARCH_ON_TAP", "false").lower() in (
        "1", "true", "yes",
    )
    effective_web_search = body.web_search and (body.mode != "tap" or web_search_on_tap)
    try:
        # Edit mode short-circuits the planner: we already have an image, the
        # user just wants to mutate it. Persisted as a child node so the
        # original is preserved in history + world map.
        if body.mode == "edit":
            if not body.image:
                yield _sse({"type": "error", "message": "edit mode requires an image"}, trace_id)
                return
            raw_instruction = (body.edit_instruction or body.query or "").strip()
            if not raw_instruction:
                yield _sse({"type": "error", "message": "edit mode requires an instruction"}, trace_id)
                return
            yield _sse({"type": "status", "stage": "planning"}, trace_id)
            polished = await llm.polish_edit_instruction(
                instruction=raw_instruction,
                page_title=body.parent_title,
            )
            yield _sse(
                {
                    "type": "status",
                    "stage": "generating_image",
                    "page_title": raw_instruction,
                },
                trace_id,
            )
            edit_result = await image_edit_provider.edit_image(
                image_data_url=body.image,
                instruction=polished,
                tier=body.image_tier,
                model_override=body.image_model,
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
                },
                trace_id,
            )
            return

        # Expand mode blooms the world AROUND the focal subject: propose a few
        # neighbouring subjects across scales (component/peer/container), then
        # generate their pages concurrently and stream one `neighbor` event per
        # page as it lands. Self-contained like edit — the tap/query single-
        # `final` path below is untouched.
        if body.mode == "expand":
            if not body.image:
                yield _sse(
                    {"type": "error", "message": "expand mode requires an image"},
                    trace_id,
                )
                return
            expand_style_lock = (body.session_style_anchor or "").strip() or None
            expand_world_context = [e.model_dump() for e in body.world_context]
            yield _sse({"type": "status", "stage": "planning"}, trace_id)
            await _abort_if_disconnected("pre-expand-plan")
            neighbors = await llm.propose_neighbors(
                image_data_url=body.image,
                parent_title=body.parent_title or body.query,
                parent_query=body.parent_query or body.query,
                output_locale=body.output_locale,
            )
            total = len(neighbors)
            if total == 0:
                yield _sse({"type": "expand_done", "count": 0}, trace_id)
                return

            # Image conditioning: every neighbour shares the parent's world + the
            # session anchor so the whole bloom reads as one continuous place
            # (same refs for all; directional edge-crops deferred). Flag-gated.
            expand_cond_refs: list[str] | None = None
            expand_cond_preamble = ""
            if (
                os.environ.get("IMAGE_CONDITIONING", "true").lower()
                in ("1", "true", "yes")
                and body.condition_image_urls
            ):
                expand_cond_refs = body.condition_image_urls
                expand_cond_preamble = image_provider.conditioning_preamble(
                    body.condition_roles or [], "expand"
                )

            async def _bloom_one(idx, neighbor):
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
                if plan.facts:
                    prompt += "\n\nLabels to include:\n- " + "\n- ".join(plan.facts)
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
            tasks = [
                _asyncio.create_task(_bloom_one(i, n)) for i, n in enumerate(neighbors)
            ]
            emitted = 0
            try:
                for fut in _asyncio.as_completed(tasks):
                    try:
                        idx, neighbor, plan, img = await fut
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
                for t in tasks:
                    if not t.done():
                        t.cancel()
            yield _sse({"type": "expand_done", "count": emitted}, trace_id)
            return

        # 1. Resolve click → subject phrase + style anchor (style is empty for
        #    text-only queries; only set on tap mode). When the client has
        #    already prefetched on hover, skip the VLM round-trip entirely.
        effective_query = body.query
        # Session-level style lock takes precedence over the per-hop anchor:
        # if the user pinned a page, every new page should match that style
        # regardless of what the click VLM saw on the parent.
        session_lock = (body.session_style_anchor or "").strip() or None
        style_anchor: str | None = session_lock
        # `subject_context` is the VLM's one-sentence disambiguation of what
        # the click subject IS in the parent's domain — fed to the planner
        # to prevent semantic drift on ambiguous phrases like "Memory Bank".
        subject_context: str | None = None
        # World Mode render framing: an explicit request override wins; else the
        # click classifier's `enter_as` (set below) decides; else today's
        # explainer. Empty string = "not yet decided / fall back to explainer".
        effective_world_mode = _world_mode_on(body.world_mode)
        render_mode = (body.render_mode or "").strip().lower()
        if render_mode not in ("place_scene", "place_submap", "explainer"):
            render_mode = ""
        # World Mode spatial anchor — what's around the tapped spot + directions,
        # threaded into the planner so the entered place keeps its neighbours.
        surroundings_for_plan: str | None = None
        if body.mode == "tap" and body.click and body.image:
            # Trust-but-verify on client-supplied prefetch hints. The web
            # client computes these via the same VLM the backend would call,
            # but the SSE handler will ultimately splice them into LLM
            # prompts — so cap length + strip control chars to keep prompt
            # injection / token-bomb surface small. Any rejection silently
            # falls back to in-band resolution.
            def _sanitize_hint(raw: str | None, max_len: int) -> str:
                if not raw:
                    return ""
                cleaned = "".join(
                    ch for ch in raw if ch == "\n" or ch == "\t" or ch >= " "
                ).strip()
                return cleaned[:max_len]

            cleaned_subject = _sanitize_hint(body.prefetched_subject, 160)
            cleaned_style = _sanitize_hint(body.prefetched_style, 320)
            cleaned_subject_context = _sanitize_hint(
                body.prefetched_subject_context, 400
            )
            cleaned_user_hint = _sanitize_hint(body.click_hint, 240)
            cleaned_surroundings = _sanitize_hint(body.prefetched_surroundings, 240)
            prefetched_ok = bool(cleaned_subject)
            if prefetched_ok:
                effective_query = cleaned_subject
                style_anchor = cleaned_style or None
                subject_context = cleaned_subject_context or None
                surroundings_for_plan = cleaned_surroundings or None
                yield _sse(
                    {
                        "type": "status",
                        "stage": "click_resolved",
                        "subject": effective_query,
                    },
                    trace_id,
                )
            else:
                await _abort_if_disconnected("pre-click-resolve")
                resolution = await llm.click_to_subject(
                    image_data_url=body.image,
                    x_pct=body.click.x_pct,
                    y_pct=body.click.y_pct,
                    parent_title=body.parent_title or body.query,
                    parent_query=body.parent_query or body.query,
                    output_locale=body.output_locale,
                    user_hint=cleaned_user_hint or None,
                    prior_rejected_subject=body.prior_rejected_subject,
                    world_mode=effective_world_mode,
                    # Clarifiers are surfaced client-side before this generate
                    # call, so the in-band resolve only needs the classification.
                    autonomy="auto",
                )
                # In world mode, let the classifier's read pick the framing
                # unless the request already pinned one.
                if effective_world_mode and not render_mode:
                    render_mode = _ENTER_AS_TO_RENDER.get(
                        resolution.enter_as, "explainer"
                    )
                if resolution.subject:
                    effective_query = resolution.subject
                    yield _sse(
                        {
                            "type": "status",
                            "stage": "click_resolved",
                            "subject": resolution.subject,
                            "groundable": resolution.groundable,
                            "confidence": resolution.confidence,
                            "point": (
                                {"x": resolution.point[0], "y": resolution.point[1]}
                                if resolution.point is not None
                                else None
                            ),
                            "bbox": (
                                {
                                    "x": resolution.bbox[0],
                                    "y": resolution.bbox[1],
                                    "w": resolution.bbox[2],
                                    "h": resolution.bbox[3],
                                }
                                if resolution.bbox is not None
                                else None
                            ),
                        },
                        trace_id,
                    )
                if resolution.style:
                    style_anchor = resolution.style
                if resolution.subject_context:
                    subject_context = resolution.subject_context
                if resolution.surroundings:
                    surroundings_for_plan = resolution.surroundings

            # Fold the user's free-form note into the planner query so the next
            # page reflects their angle even when the prefetched-subject path
            # short-circuited the VLM. Em dash separator keeps the subject
            # readable as the page title; planner is instructed to honour both.
            if cleaned_user_hint:
                effective_query = f"{effective_query} — {cleaned_user_hint}"

        # Session-lock always wins over per-hop derivations. Re-applied here
        # so the tap branches (which reassign style_anchor) don't clobber it.
        if session_lock:
            style_anchor = session_lock

        # 2. Plan (with optional style anchor for visual continuity, and
        #    parent + subject_context for semantic continuity — keeps an
        #    ambiguous click subject in the parent page's domain instead of
        #    drifting to whatever interpretation web search likes most).
        #    Phase 3: `world_context` carries recurring-entity appearance
        #    descriptors that the planner injects into the image prompt.
        await _abort_if_disconnected("pre-plan")
        yield _sse({"type": "status", "stage": "planning"}, trace_id)
        world_context_payload = [e.model_dump() for e in body.world_context]
        if world_context_payload:
            log(
                "info",
                "plan.world_context",
                entities=len(world_context_payload),
                first_name=world_context_payload[0].get("name"),
            )
        plan = await llm.plan_page(
            query=effective_query,
            web_search=effective_web_search,
            style_anchor=style_anchor,
            output_locale=body.output_locale,
            parent_title=body.parent_title,
            parent_query=body.parent_query,
            subject_context=subject_context,
            world_context=world_context_payload,
            render_mode=render_mode or "explainer",
            surroundings=surroundings_for_plan,
        )

        composed_prompt = plan.prompt
        if style_anchor:
            # Belt + suspenders: prepend the style anchor explicitly so the
            # image model sees it at the front of the prompt even if the
            # planner omitted it.
            composed_prompt = (
                f"Style: {style_anchor}\n\n{composed_prompt}"
            )
        if plan.facts:
            composed_prompt += "\n\nLabels to include:\n- " + "\n- ".join(plan.facts)

        await _abort_if_disconnected("pre-image-gen")
        yield _sse(
            {
                "type": "status",
                "stage": "generating_image",
                "page_title": plan.page_title,
            },
            trace_id,
        )

        # World Mode sub-map: pixel-continue the click region with a continuation
        # model (Kontext) so the closer map keeps the parent's streets/buildings
        # in place instead of re-planning a fresh image. Needs the region crop.
        region_ref: str | None = None
        if body.condition_image_urls:
            roles = body.condition_roles or []
            for i, url in enumerate(body.condition_image_urls):
                if i < len(roles) and roles[i] == "region":
                    region_ref = url
                    break
            if region_ref is None:
                region_ref = body.condition_image_urls[0]
        use_continuation = render_mode == "place_submap" and region_ref is not None
        zoom_instruction = (
            f"Zoom in and draw a closer map of {plan.page_title} — the area at the "
            "centre of this image. Keep the same hand-drawn cartographic style, "
            "palette and line work; keep the existing streets, buildings and "
            "landmarks where they are and continue them outward; label its "
            "sub-areas. A closer continuation of this map, not a new scene."
        )

        # 3. Image gen — with progressive fast-tier draft.
        #
        # When the user picked balanced/pro the cheap nano-banana model is
        # ~3-5x faster than the requested tier. Firing a fast-tier draft in
        # parallel and emitting it via the existing `progress` event lets
        # the frontend paint a usable page seconds before the final lands.
        # Disabled by env if a deployer wants to save the extra fal call.
        progressive_enabled = os.environ.get(
            "PROGRESSIVE_DRAFT", "true"
        ).lower() in ("1", "true", "yes")
        target_tier = (body.image_tier or "balanced").lower()
        wants_draft = (
            progressive_enabled
            and target_tier != "fast"
            and not body.image_model  # honour explicit model_override
            # The draft race is a fal tier optimisation (cheap fast-tier model
            # in parallel with the requested tier). Non-fal backends collapse
            # tiers to one model, so a draft would just regenerate the same
            # image — skip it.
            and image_provider.active_provider() == "fal"
            # Sub-map continuation is a single Kontext call on the region crop;
            # a nano-banana text draft would just be an unrelated preview.
            and not use_continuation
        )
        draft_task: _asyncio.Task | None = None
        if wants_draft:
            draft_task = _asyncio.create_task(
                image_provider.generate_image(
                    prompt=composed_prompt,
                    aspect_ratio=body.aspect_ratio,
                    tier="fast",
                )
            )
        # Image conditioning (final image only; the fast draft stays a quick
        # text-only preview). Blend the reference stack — region crop → parent →
        # anchor — so the page belongs to the same world. Flag-gated; no refs →
        # text-only exactly as before.
        main_prompt = composed_prompt
        cond_refs: list[str] | None = None
        if (
            os.environ.get("IMAGE_CONDITIONING", "true").lower() in ("1", "true", "yes")
            and body.condition_image_urls
        ):
            cond_refs = body.condition_image_urls
            # Entering a place reframes the region ref ("reveal the fuller place
            # within") vs. an explainer tap ("reveal what is inside").
            cond_mode = "place_scene" if render_mode == "place_scene" else body.mode
            main_prompt = (
                image_provider.conditioning_preamble(
                    body.condition_roles or [], cond_mode
                )
                + composed_prompt
            )
        if use_continuation and region_ref is not None:
            main_task = _asyncio.create_task(
                image_edit_provider.continue_image(
                    region_ref, zoom_instruction, model_override=body.image_model
                )
            )
        else:
            main_task = _asyncio.create_task(
                image_provider.generate_image(
                    prompt=main_prompt,
                    aspect_ratio=body.aspect_ratio,
                    tier=body.image_tier,
                    model_override=body.image_model,
                    reference_urls=cond_refs,
                )
            )
        # Drive both tasks to completion. If the draft finishes first, emit
        # `progress`; if the main finishes first, drop the draft.
        if draft_task is not None:
            done, _ = await _asyncio.wait(
                {draft_task, main_task}, return_when=_asyncio.FIRST_COMPLETED
            )
            if main_task in done:
                # Main beat the draft — drop the draft, the user gets the
                # final straight away.
                draft_task.cancel()
                with contextlib.suppress(Exception, _asyncio.CancelledError):
                    await draft_task
                result = main_task.result()
            else:
                # Draft finished first; surface it as a progress frame, then
                # keep waiting for main. If the draft itself errored, just
                # skip the progress and continue — main is still running.
                try:
                    draft_result = draft_task.result()
                except Exception:
                    draft_result = None
                if draft_result is not None:
                    # Encode in a thread so the event loop stays free for
                    # main_task progress. Sync b64encode of a 1-3MB JPEG
                    # otherwise stalls the loop for ~5-15ms — small per call,
                    # but it's stalls in the hot path right when the user
                    # cares most about latency.
                    draft_b64 = (
                        await _asyncio.to_thread(
                            base64.b64encode, draft_result.jpeg_bytes
                        )
                    ).decode("ascii")
                    yield _sse(
                        {
                            "type": "progress",
                            "frame_index": 0,
                            "jpeg_b64": draft_b64,
                        },
                        trace_id,
                    )
                result = await main_task
        else:
            result = await main_task
        # Final image is the largest payload (up to 3MB JPEG on the pro
        # tier); offload the b64 encode the same way as the draft so the
        # `final` SSE yield isn't gated on a sync CPU stall.
        data_url = await _asyncio.to_thread(
            image_provider.encode_data_url, result.jpeg_bytes, result.mime_type
        )

        # 4. Final event. Matches GenerateFinalEvent in packages/config.
        text_model = llm._text_model(online=effective_web_search)
        sources_payload = [
            {"url": c.url, "title": c.title}
            for c in (plan.sources or [])
        ]
        yield _sse(
            {
                "type": "final",
                "image_data_url": data_url,
                "page_title": plan.page_title,
                "image_model": result.model,
                "prompt_author_model": text_model,
                "session_id": body.session_id,
                "final_prompt": zoom_instruction if use_continuation else composed_prompt,
                "sources": sources_payload,
            },
            trace_id,
        )
        log(
            "info",
            "sse.generate.end",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
        )
    except _asyncio.CancelledError:
        # Client dropped the SSE socket — bail out cleanly without firing
        # an `error` event into the (now-dead) stream and without paging
        # Sentry. The downstream socket is already closed, so any further
        # yield would no-op anyway.
        log(
            "info",
            "sse.generate.cancelled",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
        )
        return
    except Exception as exc:
        log(
            "error",
            "sse.generate.end",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
            error=f"{type(exc).__name__}: {exc}",
        )
        record_error("sse_generate", exc)
        yield _sse({"type": "error", "message": str(exc)}, trace_id)


@fastapi_app.post("/sse/generate")
async def sse_generate(req: Request):
    from obs import TRACE_HEADER, bind_trace

    raw = await req.json()
    try:
        body = GenerateBody.model_validate(raw)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)

    return StreamingResponse(
        _event_stream(body, trace_id, is_disconnected=req.is_disconnected),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Trace-Id": trace_id,
        },
    )


class AnimateBody(BaseModel):
    image_data_url: str
    prompt: str
    duration: int = 5
    video_tier: str | None = None
    trace_id: str | None = None


@fastapi_app.post("/animate")
async def animate(req: Request, body: AnimateBody):
    """Cheap-fallback animation: delegate to fal-ai/ltx-video.

    Wraps fal errors into a JSON 502 with the original exception message so
    the frontend can surface the real cause (rate limit, payload too large,
    invalid image format) instead of a generic 500.
    """
    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider
    from providers import video as video_provider

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    img_size_kb = len(body.image_data_url) // 1024
    log(
        "info",
        "animate.request",
        prompt_len=len(body.prompt or ""),
        image_kb=img_size_kb,
        duration=body.duration,
    )
    motion_prompt = await llm_provider.rewrite_motion_prompt(
        page_title=body.prompt or "",
        image_data_url=body.image_data_url,
        duration_seconds=body.duration,
    )
    if motion_prompt and motion_prompt != body.prompt:
        log(
            "info",
            "animate.prompt_rewritten",
            orig_len=len(body.prompt or ""),
            new_len=len(motion_prompt),
        )
    try:
        clip = await video_provider.animate_image(
            image_data_url=body.image_data_url,
            prompt=motion_prompt or body.prompt,
            duration=body.duration,
            tier=body.video_tier,
        )
    except Exception as exc:
        record_error("animate", exc, image_kb=img_size_kb)
        return JSONResponse(
            {
                "error": f"{type(exc).__name__}: {exc}",
                "stage": "fal_animate",
                "image_data_url_kb": img_size_kb,
                "trace_id": trace_id,
            },
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "video_url": clip.video_url,
            "content_type": clip.content_type,
            "model": clip.model,
            "duration_seconds": clip.duration_seconds,
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class ResolveClickBody(BaseModel):
    image_data_url: str
    x_pct: float = Field(ge=0.0, le=1.0)
    y_pct: float = Field(ge=0.0, le=1.0)
    parent_title: str | None = None
    parent_query: str | None = None
    output_locale: str | None = None
    prior_rejected_subject: str | None = None
    # World Mode: ask the resolver to also classify what was tapped and (in
    # "semi") propose clarifying questions to surface before entering.
    world_mode: bool = False
    autonomy: str = "auto"
    trace_id: str | None = None


@fastapi_app.post("/resolve-click")
async def resolve_click(req: Request, body: ResolveClickBody):
    """Hover-prefetch endpoint.

    Returns the click→subject+style mapping plus groundability + bounding
    box so the frontend can: (a) warm a tap before the user commits, (b)
    render the "we think you tapped this — yes / try again" overlay, and
    (c) suppress page generation when ``groundable`` is false.
    """
    from obs import TRACE_HEADER, bind_trace, record_error
    from providers import llm as llm_provider

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    try:
        resolution = await llm_provider.click_to_subject(
            image_data_url=body.image_data_url,
            x_pct=body.x_pct,
            y_pct=body.y_pct,
            parent_title=body.parent_title or "",
            parent_query=body.parent_query or "",
            output_locale=body.output_locale,
            prior_rejected_subject=body.prior_rejected_subject,
            world_mode=_world_mode_on(body.world_mode),
            autonomy=(body.autonomy or "auto"),
        )
    except Exception as exc:
        record_error("resolve_click", exc)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "subject": resolution.subject,
            "style": resolution.style,
            "subject_context": resolution.subject_context,
            "groundable": resolution.groundable,
            "confidence": resolution.confidence,
            "point": (
                {"x": resolution.point[0], "y": resolution.point[1]}
                if resolution.point is not None
                else None
            ),
            "bbox": (
                {
                    "x": resolution.bbox[0],
                    "y": resolution.bbox[1],
                    "w": resolution.bbox[2],
                    "h": resolution.bbox[3],
                }
                if resolution.bbox is not None
                else None
            ),
            "enter_as": resolution.enter_as,
            "clarifiers": resolution.clarifiers,
            "surroundings": resolution.surroundings,
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PrecomputeBody(BaseModel):
    image_data_url: str
    parent_title: str | None = None
    parent_query: str | None = None
    output_locale: str | None = None
    # Frontend now requests 8 by default (was 4) — pairs with the tighter 3%
    # bucket grid on the client to push tap-time cache hit-rate up. Server
    # still caps at 8 to bound VLM cost.
    max_candidates: int = 8
    trace_id: str | None = None


@fastapi_app.post("/precompute-candidates")
async def precompute_candidates(req: Request, body: PrecomputeBody):
    """Pre-resolve the 3-4 most click-worthy regions on a fresh page.

    Frontend fires this once per page-render; results warm the same cache the
    hover-prefetch path uses, so the first click on a salient region skips
    the VLM round-trip entirely.
    """
    from obs import TRACE_HEADER, bind_trace, record_error
    from providers import llm as llm_provider

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    try:
        cands = await llm_provider.precompute_click_candidates(
            image_data_url=body.image_data_url,
            parent_title=body.parent_title or "",
            parent_query=body.parent_query or "",
            output_locale=body.output_locale,
            max_candidates=max(1, min(8, body.max_candidates)),
        )
    except Exception as exc:
        record_error("precompute_candidates", exc)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "candidates": [
                {
                    "x_pct": c.x_pct,
                    "y_pct": c.y_pct,
                    "subject": c.subject,
                    "style": c.style,
                    "salience": c.salience,
                }
                for c in cands
            ],
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PriorEntity(BaseModel):
    id: str | None = None
    kind: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    appearance: str = ""


class ExtractEntitiesBody(BaseModel):
    session_id: str
    node_id: str
    image_data_url: str
    # `caption` is the short page title (<= 8 words). `scene_description`
    # is the planner's full image prompt — the rich paragraph the renderer
    # produced from. The extractor needs both; a title alone is too thin.
    caption: str = ""
    scene_description: str | None = None
    # Pre-filtered slice of the current world's entities so the VLM can
    # diff. Web layer selects the relevant ones; we don't want the full
    # registry on every call. Capped server-side regardless.
    prior_entities: list[PriorEntity] = Field(default_factory=list, max_length=40)
    trace_id: str | None = None


@fastapi_app.post("/extract-entities")
async def extract_entities_endpoint(req: Request, body: ExtractEntitiesBody):
    """Run the world-memory extractor on a freshly-rendered page.

    Web-side flow: after /sse/generate emits `final` and the image is
    persisted as a node, the web layer posts here with the node id, image
    data URL, page caption, and a small slice of the existing entity
    registry. We return a diff (`added` + `updated`) which the web layer
    merges into the `world_state` Mongo collection.

    Pure read on the backend — no Mongo, no R2; the diff is just structured
    JSON. Cost: one VLM call per page (default Gemini 3 Flash). Web side
    runs this off the critical path so it doesn't block the next click.
    """
    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    img_size_kb = len(body.image_data_url) // 1024
    log(
        "info",
        "extract_entities.request",
        node_id=body.node_id,
        session_id=body.session_id,
        prior_count=len(body.prior_entities),
        caption_len=len(body.caption or ""),
        scene_desc_len=len(body.scene_description or ""),
        image_kb=img_size_kb,
    )
    try:
        result = await llm_provider.extract_entities(
            image_data_url=body.image_data_url,
            caption=body.caption,
            scene_description=body.scene_description,
            prior_entities=[e.model_dump() for e in body.prior_entities],
        )
    except Exception as exc:
        record_error("extract_entities", exc, node_id=body.node_id)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )

    def _entity_payload(e: llm_provider.ExtractedEntity) -> dict:
        return {
            "kind": e.kind,
            "name": e.name,
            "appearance": e.appearance,
            "aliases": e.aliases,
            "facts": e.facts,
            "state": e.state,
            "confidence": e.confidence,
            "bbox": e.bbox,
        }

    return JSONResponse(
        {
            "result": {
                "added": [_entity_payload(e) for e in result.added],
                "updated": [
                    {
                        "match_name": u.match_name,
                        "changes": u.changes,
                        "confidence": u.confidence,
                    }
                    for u in result.updated
                ],
            },
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


@fastapi_app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": APP_NAME}


@fastapi_app.get("/status")
async def status() -> dict:
    from obs import status_payload

    return await status_payload(APP_NAME)


@fastapi_app.get("/trace/recent")
async def trace_recent(limit: int = 50) -> dict:
    """Return the in-memory ring buffer of recent completed traces.

    Powers the /admin/trace dashboard. Buffer is bounded (TRACE_BUFFER_MAX,
    default 200) and process-local, so this is for ops/dev visibility, not
    a long-term store.
    """
    from obs import recent_traces

    clamped = max(1, min(int(limit), 200))
    return {"ok": True, "service": APP_NAME, "traces": recent_traces(clamped)}


@fastapi_app.get("/trace/abort-stats")
async def trace_abort_stats(limit: int = 100) -> dict:
    """Return aggregated stale-click stats: counts + wasted ms + $ per stage.

    The bench/audit deliverable from the Bet E plan — confirms or refutes
    the $200-400/month stale-click waste estimate by tracking every
    client-disconnect during the SSE pipeline.
    """
    from obs import abort_stats

    clamped = max(0, min(int(limit), 500))
    return {"ok": True, "service": APP_NAME, **abort_stats(clamped)}


@app.function(secrets=secrets, min_containers=0, timeout=600)
@modal.asgi_app()
def fastapi_ingress():
    return fastapi_app
