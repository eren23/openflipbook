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

import base64
import json
import os
from typing import AsyncIterator

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
    session_style_anchor: str | None = None
    trace_id: str | None = None


def _sse(data: dict, trace_id: str | None = None) -> bytes:
    """Encode an SSE event. Trace ID rides on every payload so the browser
    can stamp it on its perf-HUD timeline without needing a side channel."""
    if trace_id and "trace_id" not in data:
        data = {**data, "trace_id": trace_id}
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def _event_stream(body: GenerateBody, trace_id: str) -> AsyncIterator[bytes]:
    import time as _time
    from obs import bind_trace, log, record_error
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm

    bind_trace(trace_id)
    started = _time.perf_counter()
    log("info", "sse.generate.start", mode=body.mode, locale=body.output_locale)
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
            prefetched_ok = bool(cleaned_subject)
            if prefetched_ok:
                effective_query = cleaned_subject
                style_anchor = cleaned_style or None
                subject_context = cleaned_subject_context or None
                yield _sse(
                    {
                        "type": "status",
                        "stage": "click_resolved",
                        "subject": effective_query,
                    },
                    trace_id,
                )
            else:
                resolution = await llm.click_to_subject(
                    image_data_url=body.image,
                    x_pct=body.click.x_pct,
                    y_pct=body.click.y_pct,
                    parent_title=body.parent_title or body.query,
                    parent_query=body.parent_query or body.query,
                    output_locale=body.output_locale,
                    user_hint=cleaned_user_hint or None,
                )
                if resolution.subject:
                    effective_query = resolution.subject
                    yield _sse(
                        {
                            "type": "status",
                            "stage": "click_resolved",
                            "subject": resolution.subject,
                        },
                        trace_id,
                    )
                if resolution.style:
                    style_anchor = resolution.style
                if resolution.subject_context:
                    subject_context = resolution.subject_context

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
        yield _sse({"type": "status", "stage": "planning"}, trace_id)
        plan = await llm.plan_page(
            query=effective_query,
            web_search=body.web_search,
            style_anchor=style_anchor,
            output_locale=body.output_locale,
            parent_title=body.parent_title,
            parent_query=body.parent_query,
            subject_context=subject_context,
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

        yield _sse(
            {
                "type": "status",
                "stage": "generating_image",
                "page_title": plan.page_title,
            },
            trace_id,
        )

        # 3. Image gen — with progressive fast-tier draft.
        #
        # When the user picked balanced/pro the cheap nano-banana model is
        # ~3-5x faster than the requested tier. Firing a fast-tier draft in
        # parallel and emitting it via the existing `progress` event lets
        # the frontend paint a usable page seconds before the final lands.
        # Disabled by env if a deployer wants to save the extra fal call.
        import asyncio as _asyncio

        progressive_enabled = os.environ.get(
            "PROGRESSIVE_DRAFT", "true"
        ).lower() in ("1", "true", "yes")
        target_tier = (body.image_tier or "balanced").lower()
        wants_draft = (
            progressive_enabled
            and target_tier != "fast"
            and not body.image_model  # honour explicit model_override
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
        main_task = _asyncio.create_task(
            image_provider.generate_image(
                prompt=composed_prompt,
                aspect_ratio=body.aspect_ratio,
                tier=body.image_tier,
                model_override=body.image_model,
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
                try:
                    await draft_task
                except (Exception, _asyncio.CancelledError):  # noqa: BLE001
                    pass
                result = main_task.result()
            else:
                # Draft finished first; surface it as a progress frame, then
                # keep waiting for main. If the draft itself errored, just
                # skip the progress and continue — main is still running.
                try:
                    draft_result = draft_task.result()
                except Exception:  # noqa: BLE001
                    draft_result = None
                if draft_result is not None:
                    draft_b64 = base64.b64encode(
                        draft_result.jpeg_bytes
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
        data_url = image_provider.encode_data_url(result.jpeg_bytes, result.mime_type)

        # 4. Final event. Matches GenerateFinalEvent in packages/config.
        text_model = llm._text_model(online=body.web_search)
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
                "final_prompt": composed_prompt,
                "sources": sources_payload,
            },
            trace_id,
        )
        log(
            "info",
            "sse.generate.end",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
        )
    except Exception as exc:  # noqa: BLE001
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
    from obs import bind_trace, TRACE_HEADER

    raw = await req.json()
    try:
        body = GenerateBody.model_validate(raw)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)

    return StreamingResponse(
        _event_stream(body, trace_id),
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
    except Exception as exc:  # noqa: BLE001
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
    trace_id: str | None = None


@fastapi_app.post("/resolve-click")
async def resolve_click(req: Request, body: ResolveClickBody):
    """Hover-prefetch endpoint.

    Returns just the click→subject+style mapping so the frontend can warm a
    tap before the user commits, then forward `prefetched_subject` /
    `prefetched_style` into `/sse/generate` to skip the VLM step there.
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
        )
    except Exception as exc:  # noqa: BLE001
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
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PrecomputeBody(BaseModel):
    image_data_url: str
    parent_title: str | None = None
    parent_query: str | None = None
    output_locale: str | None = None
    max_candidates: int = 4
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
    except Exception as exc:  # noqa: BLE001
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


@fastapi_app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": APP_NAME}


@fastapi_app.get("/status")
async def status() -> dict:
    from obs import status_payload

    return await status_payload(APP_NAME)


@app.function(secrets=secrets, min_containers=0, timeout=600)
@modal.asgi_app()
def fastapi_ingress():
    return fastapi_app
