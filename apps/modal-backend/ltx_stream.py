"""Self-hosted LTX-Video streaming worker (Modal GPU).

This is the "full streaming clone" path. It runs the Lightricks/LTX-Video
pipeline on an H100, generates a short image-to-video clip per request, and
streams it to the browser over WebSocket using the LTXF framing from
`ltxf.py`.

**Status:** functional scaffold. Emits each clip as one init segment + one
media segment (fragmented MP4). A future upgrade can switch to true
multi-segment chunked emission as frames are produced, which would lower
time-to-first-byte from ~clip-duration to ~single-segment.

Deploy separately from `generate.py`:

    modal deploy ltx_stream.py

The printed WS URL goes into `apps/web/.env.local` as
`NEXT_PUBLIC_LTX_WS_URL`. When that env var is set the web app uses this WS
path; otherwise it falls back to the cheap `POST /animate` → fal path.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
from typing import TYPE_CHECKING

import modal
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

if TYPE_CHECKING:
    pass

APP_NAME = "openflipbook-ltx-stream"
GPU_TYPE = os.environ.get("LTX_STREAM_GPU", "H100")
MODEL_REPO = os.environ.get("LTX_STREAM_MODEL", "Lightricks/LTX-Video")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.5.1",
        "diffusers>=0.32",
        "transformers>=4.46",
        "accelerate>=1.1",
        "safetensors>=0.4",
        "sentencepiece",
        "imageio[ffmpeg]>=2.36",
        "av>=13.1",
        "pillow>=11",
        "fastapi>=0.115",
        "websockets>=13",
    )
    .add_local_python_source("ltxf")
)

volume = modal.Volume.from_name(
    "openflipbook-ltx-weights", create_if_missing=True
)
VOLUME_MOUNT = "/weights"

app = modal.App(APP_NAME, image=image)
fastapi_app = FastAPI(title="Endless Canvas — LTX stream")


def _parse_data_url(data_url: str) -> tuple[str, bytes]:
    m = re.match(r"^data:([^;]+);base64,(.*)$", data_url, flags=re.I)
    if not m:
        raise ValueError("not a base64 data URL")
    return m.group(1), base64.b64decode(m.group(2))


@app.cls(
    gpu=GPU_TYPE,
    volumes={VOLUME_MOUNT: volume},
    timeout=600,
    scaledown_window=300,
    min_containers=0,
)
class LTXStreamingEngine:
    """Lazy-loaded LTX image-to-video pipeline."""

    @modal.enter()
    def _load(self):
        import torch
        from diffusers import LTXImageToVideoPipeline

        self._torch = torch
        self._pipeline = LTXImageToVideoPipeline.from_pretrained(
            MODEL_REPO,
            torch_dtype=torch.bfloat16,
            cache_dir=VOLUME_MOUNT,
        ).to("cuda")
        # Memory-efficient attention where available.
        try:
            self._pipeline.enable_model_cpu_offload()  # type: ignore[attr-defined]
        except Exception:
            pass

    @modal.method()
    def generate_clip(
        self,
        *,
        prompt: str,
        start_image_data_url: str,
        width: int,
        height: int,
        num_frames: int,
        frame_rate: int,
    ) -> bytes:
        """Generate a fragmented MP4 (init+media) from an image+prompt."""
        import io
        import av
        import torch
        from PIL import Image

        mime, start_bytes = _parse_data_url(start_image_data_url)
        start_image = Image.open(io.BytesIO(start_bytes)).convert("RGB")
        if (start_image.width, start_image.height) != (width, height):
            start_image = start_image.resize((width, height))

        generator = torch.Generator(device="cuda").manual_seed(42)
        result = self._pipeline(
            prompt=prompt,
            image=start_image,
            width=width,
            height=height,
            num_frames=num_frames,
            num_inference_steps=30,
            guidance_scale=3.0,
            generator=generator,
        )
        frames = result.frames[0]  # list[PIL.Image]

        out_buf = io.BytesIO()
        container = av.open(
            out_buf,
            mode="w",
            format="mp4",
            options={
                "movflags": "frag_keyframe+empty_moov+default_base_moof",
                "brand": "mp42",
            },
        )
        stream = container.add_stream("h264", rate=frame_rate)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.options = {"profile": "main", "crf": "20", "preset": "veryfast"}

        for frame in frames:
            vframe = av.VideoFrame.from_image(frame)
            for packet in stream.encode(vframe):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
        container.close()
        return out_buf.getvalue()


@fastapi_app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket):
    from ltxf import encode as ltxf_encode
    from ltxf import split_fmp4

    await websocket.accept()
    session_id = ""
    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            action = message.get("action")

            if action == "stop":
                await websocket.close(code=1000, reason="client stop")
                return

            if action != "start":
                await websocket.send_text(
                    json.dumps({"error": f"unknown action {action!r}"})
                )
                continue

            session_id = str(message.get("session_id") or "")
            prompt = str(message.get("prompt") or "")
            start_image = str(message.get("start_image") or "")
            width = int(message.get("width") or 1280)
            height = int(message.get("height") or 720)
            num_frames = int(message.get("num_frames") or 49)
            frame_rate = int(message.get("frame_rate") or 24)

            engine = LTXStreamingEngine()
            fmp4_bytes = await engine.generate_clip.aio(  # type: ignore[attr-defined]
                prompt=prompt,
                start_image_data_url=start_image,
                width=width,
                height=height,
                num_frames=num_frames,
                frame_rate=frame_rate,
            )
            init_seg, media_seg = split_fmp4(fmp4_bytes)

            await websocket.send_bytes(
                ltxf_encode(
                    {
                        "media_type": "video/mp4",
                        "codecs": "avc1.640028",
                        "sequence": 0,
                        "is_init_segment": True,
                        "session_id": session_id,
                    },
                    init_seg,
                )
            )
            await websocket.send_bytes(
                ltxf_encode(
                    {
                        "media_type": "video/mp4",
                        "sequence": 1,
                        "final": True,
                        "session_id": session_id,
                    },
                    media_seg,
                )
            )
    except WebSocketDisconnect:
        return


@fastapi_app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": APP_NAME, "model": MODEL_REPO}


@app.function(timeout=600)
@modal.asgi_app()
def streaming_app():
    return fastapi_app
