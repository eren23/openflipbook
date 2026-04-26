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


def _sse(data: dict) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def _event_stream(body: GenerateBody) -> AsyncIterator[bytes]:
    from providers import image as image_provider
    from providers import llm

    try:
        # 1. Resolve click → subject phrase + style anchor (style is empty for
        #    text-only queries; only set on tap mode).
        effective_query = body.query
        style_anchor: str | None = None
        if body.mode == "tap" and body.click and body.image:
            resolution = await llm.click_to_subject(
                image_data_url=body.image,
                x_pct=body.click.x_pct,
                y_pct=body.click.y_pct,
                parent_title=body.parent_title or body.query,
                parent_query=body.parent_query or body.query,
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

        # 2. Plan (with optional style anchor for visual continuity).
        yield _sse({"type": "status", "stage": "planning"})
        plan = await llm.plan_page(
            query=effective_query,
            web_search=body.web_search,
            style_anchor=style_anchor,
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


@fastapi_app.post("/animate")
async def animate(body: AnimateBody):
    """Cheap-fallback animation: delegate to fal-ai/ltx-video."""
    from providers import video as video_provider

    clip = await video_provider.animate_image(
        image_data_url=body.image_data_url,
        prompt=body.prompt,
        duration=body.duration,
    )
    return {
        "video_url": clip.video_url,
        "content_type": clip.content_type,
        "model": clip.model,
        "duration_seconds": clip.duration_seconds,
    }


@fastapi_app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": APP_NAME}


@app.function(secrets=secrets, min_containers=0, timeout=600)
@modal.asgi_app()
def fastapi_ingress():
    return fastapi_app
