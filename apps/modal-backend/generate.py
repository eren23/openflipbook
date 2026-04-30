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

import json
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


def _sse(data: dict) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def _event_stream(body: GenerateBody) -> AsyncIterator[bytes]:
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm

    try:
        # Edit mode short-circuits the planner: we already have an image, the
        # user just wants to mutate it. Persisted as a child node so the
        # original is preserved in history + world map.
        if body.mode == "edit":
            if not body.image:
                yield _sse({"type": "error", "message": "edit mode requires an image"})
                return
            raw_instruction = (body.edit_instruction or body.query or "").strip()
            if not raw_instruction:
                yield _sse({"type": "error", "message": "edit mode requires an instruction"})
                return
            yield _sse({"type": "status", "stage": "planning"})
            polished = await llm.polish_edit_instruction(
                instruction=raw_instruction,
                page_title=body.parent_title,
            )
            yield _sse(
                {
                    "type": "status",
                    "stage": "generating_image",
                    "page_title": raw_instruction,
                }
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
                }
            )
            return

        # 1. Resolve click → subject phrase + style anchor (style is empty for
        #    text-only queries; only set on tap mode). When the client has
        #    already prefetched on hover, skip the VLM round-trip entirely.
        effective_query = body.query
        style_anchor: str | None = None
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
            cleaned_user_hint = _sanitize_hint(body.click_hint, 240)
            prefetched_ok = bool(cleaned_subject)
            if prefetched_ok:
                effective_query = cleaned_subject
                style_anchor = cleaned_style or None
                yield _sse(
                    {
                        "type": "status",
                        "stage": "click_resolved",
                        "subject": effective_query,
                    }
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
                        }
                    )
                if resolution.style:
                    style_anchor = resolution.style

            # Fold the user's free-form note into the planner query so the next
            # page reflects their angle even when the prefetched-subject path
            # short-circuited the VLM. Em dash separator keeps the subject
            # readable as the page title; planner is instructed to honour both.
            if cleaned_user_hint:
                effective_query = f"{effective_query} — {cleaned_user_hint}"

        # 2. Plan (with optional style anchor for visual continuity).
        yield _sse({"type": "status", "stage": "planning"})
        plan = await llm.plan_page(
            query=effective_query,
            web_search=body.web_search,
            style_anchor=style_anchor,
            output_locale=body.output_locale,
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
            }
        )

        # 3. Image gen.
        result = await image_provider.generate_image(
            prompt=composed_prompt,
            aspect_ratio=body.aspect_ratio,
            tier=body.image_tier,
            model_override=body.image_model,
        )
        data_url = image_provider.encode_data_url(result.jpeg_bytes, result.mime_type)

        # 4. Final event. Matches GenerateFinalEvent in packages/config.
        text_model = llm._text_model(online=body.web_search)
        yield _sse(
            {
                "type": "final",
                "image_data_url": data_url,
                "page_title": plan.page_title,
                "image_model": result.model,
                "prompt_author_model": text_model,
                "session_id": body.session_id,
                "final_prompt": composed_prompt,
            }
        )
    except Exception as exc:  # noqa: BLE001
        yield _sse({"type": "error", "message": str(exc)})


@fastapi_app.post("/sse/generate")
async def sse_generate(req: Request):
    raw = await req.json()
    try:
        body = GenerateBody.model_validate(raw)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)

    return StreamingResponse(
        _event_stream(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


class AnimateBody(BaseModel):
    image_data_url: str
    prompt: str
    duration: int = 5
    video_tier: str | None = None


@fastapi_app.post("/animate")
async def animate(body: AnimateBody):
    """Cheap-fallback animation: delegate to fal-ai/ltx-video.

    Wraps fal errors into a JSON 502 with the original exception message so
    the frontend can surface the real cause (rate limit, payload too large,
    invalid image format) instead of a generic 500.
    """
    import logging
    import traceback

    from providers import llm as llm_provider
    from providers import video as video_provider

    logger = logging.getLogger("openflipbook.animate")
    img_size_kb = len(body.image_data_url) // 1024
    logger.info(
        "animate request: prompt_len=%d image_data_url_kb=%d duration=%d",
        len(body.prompt or ""),
        img_size_kb,
        body.duration,
    )
    motion_prompt = await llm_provider.rewrite_motion_prompt(
        page_title=body.prompt or "",
        image_data_url=body.image_data_url,
        duration_seconds=body.duration,
    )
    if motion_prompt and motion_prompt != body.prompt:
        logger.info(
            "animate prompt rewritten: orig_len=%d new_len=%d",
            len(body.prompt or ""),
            len(motion_prompt),
        )
    try:
        clip = await video_provider.animate_image(
            image_data_url=body.image_data_url,
            prompt=motion_prompt or body.prompt,
            duration=body.duration,
            tier=body.video_tier,
        )
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc(limit=4)
        logger.error("animate failed: %s\n%s", exc, tb)
        return JSONResponse(
            {
                "error": f"{type(exc).__name__}: {exc}",
                "stage": "fal_animate",
                "image_data_url_kb": img_size_kb,
            },
            status_code=502,
        )
    return {
        "video_url": clip.video_url,
        "content_type": clip.content_type,
        "model": clip.model,
        "duration_seconds": clip.duration_seconds,
    }


class ResolveClickBody(BaseModel):
    image_data_url: str
    x_pct: float = Field(ge=0.0, le=1.0)
    y_pct: float = Field(ge=0.0, le=1.0)
    parent_title: str | None = None
    parent_query: str | None = None
    output_locale: str | None = None


@fastapi_app.post("/resolve-click")
async def resolve_click(body: ResolveClickBody):
    """Hover-prefetch endpoint.

    Returns just the click→subject+style mapping so the frontend can warm a
    tap before the user commits, then forward `prefetched_subject` /
    `prefetched_style` into `/sse/generate` to skip the VLM step there.
    """
    import logging

    from providers import llm as llm_provider

    logger = logging.getLogger("openflipbook.resolve_click")
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
        logger.error("resolve-click failed: %s", exc)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}"}, status_code=502
        )
    return {"subject": resolution.subject, "style": resolution.style}


@fastapi_app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": APP_NAME}


@app.function(secrets=secrets, min_containers=0, timeout=600)
@modal.asgi_app()
def fastapi_ingress():
    return fastapi_app
