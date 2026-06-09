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
from typing import TYPE_CHECKING, Any, cast

import modal

if TYPE_CHECKING:
    # Type-only — the providers are imported lazily at the call sites (Modal cold
    # start cost), but mypy needs the shapes to check the geometry boundary. The
    # geometry TypedDict is aliased to avoid clashing with this module's Pydantic
    # `ProjectedEntity` wire model (same shape; model_dump() yields the TypedDict).
    from providers.detector import Detection
    from providers.geometry import ProjectedEntity as ProjectedEntityDict
    from providers.view_estimator import ViewEstimate
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from _env import env_flag

APP_NAME = "openflipbook-generate"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install_from_requirements("requirements.txt")
    .add_local_python_source("providers")
    .add_local_python_source("obs")
    .add_local_python_source("_env")
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
    # Mirrors EntityState in packages/config: a key/value bag whose values are
    # primitives only (door=open, lantern=lit, mira_present=true). The tightened
    # union (not dict[str, Any]) keeps the TS<->Py schema-parity check meaningful.
    state: dict[str, str | int | float | bool] = Field(default_factory=dict)
    # FIX C: optional geometric size carried from the entity's WorldEntityGeo so
    # the planner can keep recurring entities at a consistent relative scale.
    # Mirrors the TS `footprint?: {w,d}` / `height?` (schema-parity gated).
    footprint: dict[str, float] | None = None
    height: float | None = None


# Geometric world model — Pydantic mirrors of the packages/config TS shapes.
# Must stay in field-parity with index.ts; the schema-parity check guards drift.
class WorldVec2(BaseModel):
    x: float
    y: float


class ObserverPose(BaseModel):
    pos: WorldVec2
    eye_height: float
    gaze: float
    pitch: float = 0.0
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
    # The entity you ENTERED to get here (the tapped place's geo id). geo-tap.ts
    # sets it and the extract route reads it to anchor the child frame; without
    # it the field was silently dropped on validation, breaking the round-trip.
    focus_id: str | None = None


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
    # World-memory continuity. Web proxy resolves a slim slice of the session's
    # registry before forwarding; planner injects each entity's `appearance`
    # into the image prompt so recurring characters / places stay visually
    # consistent across pages. Capped server-side.
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
    return bool(requested) and env_flag("WORLD_MODE")


def _geometric_world_on() -> bool:
    """Master gate for the geometric world (GEOMETRIC_WORLD). Off → the geo
    endpoints (e.g. /edit-entities) are disabled and behave as if absent."""
    return env_flag("GEOMETRIC_WORLD")


def _world_geometry_gen_on() -> bool:
    """Geometry steers generation (WORLD_GEOMETRY_GEN). Off → no layout clause."""
    return env_flag("WORLD_GEOMETRY_GEN")


def _condition_url_for_role(body: GenerateBody, role: str) -> str | None:
    """The first condition image URL tagged with `role` (e.g. "style"), or None.
    Lets the edit path pull the style exemplar the client already sends in the
    condition stack (condition_image_urls / condition_roles, same index)."""
    urls = body.condition_image_urls or []
    roles = body.condition_roles or []
    for u, r in zip(urls, roles, strict=False):
        if r == role and u:
            return u
    return None


def _layout_clause_for(body: GenerateBody) -> str:
    """The geometry layout-constraint clause for this request, or "" when the
    geometry-gen flag is off or no expected layout was sent."""
    if not _world_geometry_gen_on() or not body.expected_layout:
        return ""
    from providers import geometry_prompt

    # model_dump() erases the static type, but a ProjectedEntity Pydantic model
    # dumps to exactly the ProjectedEntity TypedDict shape the prompt consumes.
    return geometry_prompt.layout_constraints(
        cast("list[ProjectedEntityDict]", [e.model_dump() for e in body.expected_layout])
    )


def _topdown_clause_for(body: GenerateBody) -> str:
    """Force a flat top-down map render (WORLD_TOPDOWN_MAPS). A genuine overhead
    map makes bbox→world geometry EXACT (the box IS the footprint) instead of
    guessing an oblique camera — the metric path. Only applies to MAP renders (a
    fresh world or an explicit map_crop view); a scene/observer render is left
    alone. Off (default) keeps the model's usual, often-2.5D, map aesthetic."""
    if not env_flag("WORLD_TOPDOWN_MAPS"):
        return ""
    sv = body.scene_view
    is_map = sv is None or (sv.observer is None and sv.level == "map")
    if not is_map:
        return ""
    return (
        "Render this as a FLAT TOP-DOWN overhead map — orthographic, looking "
        "straight down, NO perspective or isometric tilt — so every place sits "
        "at an unambiguous map position."
    )


def _vlm_grounding_on() -> bool:
    """Verify the rendered frame against the expected layout (VLM_GROUNDING).
    Off → no detector call, `final` carries no grounding summary."""
    return env_flag("VLM_GROUNDING")


def _vlm_grounding_repair_on() -> bool:
    """Let the grounding loop attempt a corrective edit (VLM_GROUNDING_REPAIR).
    Off → verify-only: report the diff, never mutate the image."""
    return env_flag("VLM_GROUNDING_REPAIR")


def _grounding_summary(
    report: Any, *, repaired: bool, iterations: int
) -> dict[str, Any]:
    """The compact grounding payload attached to the `final` event. `repaired`
    means the returned image IS a kept corrective edit (not merely that one was
    attempted) — a discarded / no-improvement repair reports False."""
    return {
        "score": round(report.score, 3),
        "mean_iou": round(report.mean_iou, 3),
        "matched": [m.label for m in report.matched],
        "missing": list(report.missing),
        "extra": list(report.extra),
        "repaired": repaired,
        "iterations": iterations,
    }


async def _run_grounding(
    result: Any,
    expected: list[ProjectedEntityDict],
    *,
    repair_on: bool,
    abort: Callable[[str], Awaitable[None]],
    accept_threshold: float = 0.7,
) -> tuple[Any, dict[str, Any] | None]:
    """Verify the render against the expected layout (and optionally repair it),
    returning the best image + a summary. Fully best-effort: ANY failure (detector
    error/429, edit error) degrades to (original image, None) so grounding can
    never break generation. The bounded loop itself is unit-tested in
    test_repair_loop.py; this wires the live detector + edit into it."""
    from providers import detector, geometry_prompt, grounding
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider

    labels = [
        lbl
        for lbl in dict.fromkeys(
            str(e.get("label") or e.get("id") or "") for e in expected
        )
        if lbl
    ]
    if not labels:
        return result, None

    async def _verify(img: Any) -> Any:
        observed = await detector.detect(img.jpeg_bytes, labels)
        return grounding.diff(expected, observed)

    async def _repair(img: Any, report: Any) -> Any | None:
        misplaced = [m.label for m in report.matched if not m.pos_ok]
        instruction = geometry_prompt.repair_instruction(
            expected, list(report.missing), misplaced
        )
        if not instruction:
            return None
        await abort("grounding-repair")
        data_url = image_provider.encode_data_url(img.jpeg_bytes, img.mime_type)
        return await image_edit_provider.edit_image(data_url, instruction)

    # Verify-only ⇒ inpaint_budget=0 so the loop never even calls the edit model
    # (no fal spend, iterations stays 0). Repair-on uses the default budget.
    budget = grounding.Budget() if repair_on else grounding.Budget(inpaint_budget=0)
    try:
        loop_res = await grounding.run_grounding_loop(
            result,
            verify=_verify,
            repair=_repair,
            accept_threshold=accept_threshold,
            budget=budget,
        )
    except Exception as exc:
        # Grounding is strictly best-effort — a detector 429 or edit failure must
        # never break generation, so any error degrades to (original, no summary).
        from obs import log

        log("info", "grounding.failed", error=f"{type(exc).__name__}: {exc}")
        return result, None
    # `repaired` = the kept image differs from what we rendered (a corrective edit
    # actually survived), not merely that a repair was attempted.
    return loop_res.image, _grounding_summary(
        loop_res.report,
        repaired=loop_res.image is not result,
        iterations=loop_res.iterations,
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
    from providers import llm, model_router

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
    web_search_on_tap = env_flag("WEB_SEARCH_ON_TAP")
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
            # Style consistency on edits: the web client already sends the session
            # style lock + a "style" condition ref, but the edit path used to drop
            # both. Thread the text lock into the polish and the exemplar image into
            # the edit so an edit can't drift the world's art medium.
            edit_style_lock = (body.session_style_anchor or "").strip() or None
            edit_style_ref = _condition_url_for_role(body, "style")
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

            # Map-pan (flag-gated): instead of blooming neighbour SUBJECTS,
            # outpaint the parent OUTWARD in four directions so "expand" pans the
            # same continuous world — like moving across a map (BRIA, bakeoff
            # winner). Reuses the neighbor/expand_done stream + abort handling;
            # flag off → the subject bloom below, unchanged.
            if os.environ.get("EXPAND_MAP_PAN", "false").lower() in (
                "1", "true", "yes"
            ):
                yield _sse({"type": "status", "stage": "planning"}, trace_id)
                _dirs = [
                    ("west", "Westward"),
                    ("east", "Eastward"),
                    ("north", "Northward"),
                    ("south", "Southward"),
                ]
                _dims = {
                    "16:9": (1600, 900),
                    "9:16": (900, 1600),
                    "1:1": (1024, 1024),
                    "4:3": (1280, 960),
                    "3:4": (960, 1280),
                }
                pw, ph = _dims.get(body.aspect_ratio, (1600, 900))
                total = len(_dirs)
                parent_image = body.image  # non-None (checked above); narrows for the closure

                async def _pan_one(idx: int, direction: str):
                    img = await image_edit_provider.expand_image(
                        parent_image, direction, pw, ph
                    )
                    return idx, direction, img

                await _abort_if_disconnected("pre-pan")
                pan_tasks = [
                    _asyncio.create_task(_pan_one(i, d[0]))
                    for i, d in enumerate(_dirs)
                ]
                emitted = 0
                try:
                    for fut in _asyncio.as_completed(pan_tasks):
                        try:
                            idx, direction, img = await fut
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
                    for t in pan_tasks:
                        if not t.done():
                            t.cancel()
                yield _sse({"type": "expand_done", "count": emitted}, trace_id)
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
            if env_flag("IMAGE_CONDITIONING", "true") and body.condition_image_urls:
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
        #    `world_context` carries recurring-entity appearance descriptors
        #    that the planner injects into the image prompt.
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
        # Stepping INSIDE a place is an immersive scene, not a diagram — rendering
        # the facts as on-image "Labels to include" turns the interior into an
        # annotated diagram (floating captions), breaking the seamless step-in.
        # The scene still carries that content via plan.prompt; maps/explainers
        # keep their labels.
        if plan.facts and render_mode != "place_scene":
            composed_prompt += "\n\nLabels to include:\n- " + "\n- ".join(plan.facts)
        # Geometric world: append the engine's deterministic placement clause so
        # the model aims entities at their projected positions. Flag-gated → "".
        layout_clause = _layout_clause_for(body)
        if layout_clause:
            composed_prompt += "\n\n" + layout_clause
            log("info", "geo.layout_steered", entities=len(body.expected_layout))
        # Top-down map lever (WORLD_TOPDOWN_MAPS) — a flat overhead map makes the
        # seeded geometry exact. Flag-gated, map renders only → "" otherwise.
        topdown_clause = _topdown_clause_for(body)
        if topdown_clause:
            composed_prompt += "\n\n" + topdown_clause

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
        # The model router owns the op decision (same result as before: a
        # place_submap entry with a region crop zoom-continues, else fresh gen).
        use_continuation = (
            model_router.select_operation(render_mode, region_ref is not None)
            == "zoom_continue"
        )
        # The Kontext zoom keeps the crop's LOOK faithful; feed it the system's
        # KNOWLEDGE too — the planner's named sub-areas (plan.facts) + the
        # geometry placement clause — so it ELABORATES the place in finer detail
        # instead of a dumb pixel-zoom. The crop is the reference; this enhances
        # it through the world model and geometry.
        zoom_instruction = image_edit_provider.build_zoom_instruction(
            plan.page_title, plan.facts, layout_clause
        )

        # 3. Image gen — with progressive fast-tier draft.
        #
        # When the user picked balanced/pro the cheap nano-banana model is
        # ~3-5x faster than the requested tier. Firing a fast-tier draft in
        # parallel and emitting it via the existing `progress` event lets
        # the frontend paint a usable page seconds before the final lands.
        # Disabled by env if a deployer wants to save the extra fal call.
        progressive_enabled = env_flag("PROGRESSIVE_DRAFT", "true")
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
        if env_flag("IMAGE_CONDITIONING", "true") and body.condition_image_urls:
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

        # 3b. Geometric grounding (VLM_GROUNDING): verify the render against the
        # expected layout and — when VLM_GROUNDING_REPAIR is also on — attempt one
        # bounded corrective edit, keeping the best-scoring image. Best-effort +
        # flag-gated, so off (the default) is byte-identical to before.
        grounding_summary: dict | None = None
        if _vlm_grounding_on() and body.expected_layout:
            await _abort_if_disconnected("pre-grounding")
            yield _sse(
                {
                    "type": "status",
                    "stage": "verifying",
                    "page_title": plan.page_title,
                },
                trace_id,
            )
            result, grounding_summary = await _run_grounding(
                result,
                cast(
                    "list[ProjectedEntityDict]",
                    [e.model_dump() for e in body.expected_layout],
                ),
                repair_on=_vlm_grounding_repair_on(),
                abort=_abort_if_disconnected,
            )

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
        final_payload: dict[str, Any] = {
            "type": "final",
            "image_data_url": data_url,
            "page_title": plan.page_title,
            "image_model": result.model,
            "prompt_author_model": text_model,
            "session_id": body.session_id,
            "final_prompt": zoom_instruction if use_continuation else composed_prompt,
            "sources": sources_payload,
        }
        # Geometric grounding summary rides on `final` only when produced (flag
        # off → key absent → unchanged wire shape).
        if grounding_summary is not None:
            final_payload["grounding"] = grounding_summary
        yield _sse(final_payload, trace_id)
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


class GeoEntityRef(BaseModel):
    """The trimmed geo state the NL editor may target (mirrors the web's
    EditEntitiesRequestBody.entities slice)."""
    id: str
    entity_id: str | None = None
    label: str = ""
    pos: WorldVec2
    height: float = 0.0
    footprint: dict[str, float] = Field(default_factory=dict)
    visual: str = ""


class EditEntitiesBody(BaseModel):
    session_id: str
    instruction: str
    entities: list[GeoEntityRef] = Field(default_factory=list, max_length=120)
    # geo-id → node ids that show it; lets us compute the blast-radius here.
    references: dict[str, list[str]] = Field(default_factory=dict)
    scene_view: SceneView | None = None
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

    # Localize the catalogued entities so the world map can seed and the overlay
    # can draw. The extractor's bbox is best-effort and often empty on dense
    # images; the purpose-built detector reliably returns one box per label.
    # Detector boxes are centre-based → store top-left for the EntityBBox shape.
    # Gated + best-effort: a failure here never blocks the extract response.
    # Decode the image once for both geometry passes (localize + view-estimate).
    geo_img_bytes = b""
    if _geometric_world_on():
        try:
            _, _, _gb64 = body.image_data_url.partition(",")
            geo_img_bytes = base64.b64decode(_gb64) if _gb64 else b""
        except Exception:
            geo_img_bytes = b""

    if geo_img_bytes and (result.added or result.updated):
        try:
            from providers import detector as _detector

            def _box_from_det(d: Detection) -> dict[str, float]:
                # Centre-based → top-left, clipped to the frame on all four edges.
                # A naive `max(0, c - s/2)` leaves w/h unclipped, so an edge box
                # overflows past 1.0 or shifts its recomputed centre.
                cx, cy = float(d["x_pct"]), float(d["y_pct"])
                bw, bh = float(d["w_pct"]), float(d["h_pct"])
                x1, y1 = max(0.0, cx - bw / 2.0), max(0.0, cy - bh / 2.0)
                x2, y2 = min(1.0, cx + bw / 2.0), min(1.0, cy + bh / 2.0)
                return {
                    "x_pct": x1,
                    "y_pct": y1,
                    "w_pct": max(0.0, x2 - x1),
                    "h_pct": max(0.0, y2 - y1),
                }

            # Localize NEW *and* recurring entities: a re-appearance must keep a
            # per-node box or it drops out of geometry + the overlay every time
            # it's seen again. One detector call covers both lists.
            need_added = [e for e in result.added if not e.bbox]
            need_updated = [u for u in result.updated if not u.bbox]
            labels = [e.name for e in need_added] + [
                u.match_name for u in need_updated
            ]
            if labels:
                dets = await _detector.detect(geo_img_bytes, labels)
                by_label = {str(d.get("label", "")).lower().strip(): d for d in dets}

                def _match(name: str) -> dict[str, float] | None:
                    key = name.lower().strip()
                    d = by_label.get(key) or next(
                        (v for k, v in by_label.items() if k and (k in key or key in k)),
                        None,
                    )
                    return _box_from_det(d) if d else None

                for e in need_added:
                    box = _match(e.name)
                    if box:
                        e.bbox = box
                for u in need_updated:
                    box = _match(u.match_name)
                    if box:
                        u.bbox = box
            log(
                "info",
                "extract.localized",
                located=sum(1 for e in result.added if e.bbox)
                + sum(1 for u in result.updated if u.bbox),
                total=len(result.added) + len(result.updated),
            )
        except Exception as exc:  # best-effort — geometry localization is optional
            log("info", "extract.localize_failed", error=f"{type(exc).__name__}: {exc}")

    # Estimate the camera instead of assuming top-down (maps are often 2.5D).
    # Returned on the response so the web side can store it on the node and
    # back-project the localized boxes at the right angle. Best-effort.
    view: ViewEstimate | None = None
    if geo_img_bytes:
        try:
            from providers import view_estimator as _view

            view = await _view.estimate_view(geo_img_bytes, body.caption)
            log(
                "info",
                "extract.view",
                view_level=view["level"],
                projection=view["projection"],
                pitch_deg=view["pitch_deg"],
            )
        except Exception as exc:
            log("info", "extract.view_failed", error=f"{type(exc).__name__}: {exc}")

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
                        "bbox": u.bbox,
                    }
                    for u in result.updated
                ],
            },
            "view": view,
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


@fastapi_app.post("/edit-entities")
async def edit_entities_endpoint(req: Request, body: EditEntitiesBody):
    """Turn an NL instruction into structured geo edits + a blast-radius (P5).

    Gated by GEOMETRIC_WORLD (403 when off → behaves as if absent). The web
    layer applies the returned edits to the world_map and surfaces the
    blast-radius as a "restage N scenes?" confirm. One text-LLM call; no
    Mongo/R2 here — the edits are just structured JSON.
    """
    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    if not _geometric_world_on():
        return JSONResponse(
            {"error": "geometric world disabled (set GEOMETRIC_WORLD=1)", "trace_id": trace_id},
            status_code=403,
            headers={"X-Trace-Id": trace_id},
        )
    log(
        "info",
        "edit_entities.request",
        session_id=body.session_id,
        instruction_len=len(body.instruction or ""),
        entity_count=len(body.entities),
    )
    try:
        plan = await llm_provider.edit_entities_nl(
            instruction=body.instruction,
            entities=[e.model_dump() for e in body.entities],
            references=body.references,
            scene_view=body.scene_view.model_dump() if body.scene_view else None,
        )
    except Exception as exc:
        record_error("edit_entities", exc, session_id=body.session_id)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "plan": {"edits": plan.edits, "blast_radius": plan.blast_radius},
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PlanWorldBody(BaseModel):
    session_id: str
    description: str
    answers: list[str] = Field(default_factory=list, max_length=8)
    trace_id: str | None = None


@fastapi_app.post("/plan-world")
async def plan_world_endpoint(req: Request, body: PlanWorldBody):
    """Describe a place -> a logical object world (B1, WORLD_FROM_DESCRIPTION).

    Parse the description into a SceneGraph (one text-LLM call), then run the pure
    deterministic solver server-side. Returns {graph, solved, trace_id}: `solved`
    is the WorldEntityGeo[] ready for upsertEntityGeos, or null when the graph is
    BLOCKED (hard contradiction / over-pack / empty-region collision) -> the
    client must ASK first. Gated by WORLD_FROM_DESCRIPTION (403 when off). One LLM
    call + pure CPU; no Mongo/R2 here.
    """
    import time
    from dataclasses import asdict

    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider
    from providers.layout_solver import solve_layout

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    if not env_flag("WORLD_FROM_DESCRIPTION"):
        return JSONResponse(
            {"error": "describe-a-place disabled (set WORLD_FROM_DESCRIPTION=1)", "trace_id": trace_id},
            status_code=403,
            headers={"X-Trace-Id": trace_id},
        )
    log("info", "plan_world.request", session_id=body.session_id,
        description_len=len(body.description or ""), answers=len(body.answers))
    try:
        graph = await llm_provider.plan_world_from_description(body.description, body.answers or None)
        result = solve_layout(graph)
    except Exception as exc:
        record_error("plan_world", exc, session_id=body.session_id)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    # Union the solver's mechanical questions (Layer B, blocking-first) with the
    # planner's (Layer A), deduped + capped at 2.
    questions = list(dict.fromkeys([*result.clarifiers, *graph.clarifiers]))[:2]
    graph_dict = asdict(graph)
    graph_dict["clarifiers"] = questions
    solved = None
    if not result.blocked:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        solved = [{**g, "updated_at": now} for g in result.geos]
    return JSONResponse(
        {"graph": graph_dict, "solved": solved, "trace_id": trace_id},
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
