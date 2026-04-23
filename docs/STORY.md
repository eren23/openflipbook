# The story

## What the tweet promised

On 2026-04-22 [Zain Shah](https://x.com/zan2434/status/2046983256093163948) showed up on X with a prototype called Flipbook:

> Imagine every pixel on your screen, streamed live directly from a model. No HTML, no layout engine, no code. Just exactly what you want to see.

Then in the thread:

> To bring the imagery to life, we heavily optimized @LTXStudio's video model. Enough to stream live 1080p video at 24fps directly to your screen, connecting directly via websockets to @modal_labs serverless GPU infra.

The mental image this set up: **a browser where the page itself is a live video feed from a generative model.** Every frame drawn by a neural net. You click on a region and the video morphs into something else. No DOM. No buttons. Just pixels.

That's a paradigm worth chasing. If true, you'd finally escape the "wall of text and coloured rectangles" UI we've been stuck on since NCSA Mosaic.

## What Flipbook actually is

We opened [flipbook.page](https://flipbook.page) and ran it through Playwright + bundle inspection (the browser lab session that started this repo).

The reality is more modest:

- **Every "page" is a static image.** A single `<img src="data:image/jpeg;base64,…">` tag holds the entire UI. The image is ~1376×768 JPEG generated on demand.
- **Text inside the page is drawn as pixels by the image model.** No DOM text overlays. Occasionally rendered wrong ("HANDLEEBRS", "speds speeds"). That's an image-model quirk, not a bug — the tweet did say "no HTML".
- **Clicks drive exploration.** You tap anywhere on the image, a vision-language model resolves the point to a subject, the subject becomes the next query, a new image is generated.
- **The "live 1080p@24fps video stream"** is a **per-page toggle**, not the default. Off by default because it's resource-intensive. Their site says: "behind a toggle you can turn on and off as you wish."

So the tweet headline ("every pixel streamed live") is aspirational — it describes the video toggle, not the everyday browsing experience. The thing that actually makes Flipbook interesting is not the video: it's the **image-as-UI** paradigm plus the **click-to-navigate** via a vision model.

## How it looks on the inside

Reverse-engineered from the production site:

### Page generation — Server-Sent Events

```
POST /api/iteratively-generate-next-page
Body: {
  query: "how does a steam engine work",
  aspect_ratio: "16:9",
  web_search: true,
  session_id: "session_<uuid>",
  current_node_id: "",
  mode: "tap|edit",
  image: "<data url>",           // when tap
  parent_query, parent_title,
}
```

The response is an SSE stream. One observed request returned ~7.7 MB over ~19 s — progressive JPEG chunks as the model refined the image.

The final frame is what ends up rendered. After it lands, the browser POSTs the whole payload (including the full base64 image) to `/api/nodes`, which saves it and returns an `id`. URL flips to `/n/<id>`.

Internal codename seen in the bundle: **"Sketchapedia"**.

### Live video — custom WebSocket protocol

The toggle opens a WebSocket to:

```
wss://tmalive--ltx-stream-diffusersltx2streamingengine-streaming-app.modal.run/ws/stream
```

That tells you a lot without any docs:

- Modal workspace: `tmalive` (Zain's).
- Modal app: `ltx-stream`.
- GPU class: `DiffusersLtx2StreamingEngine` — a custom [Diffusers](https://huggingface.co/docs/diffusers) pipeline wrapping Lightricks' LTX-2 model, exposed directly over WS.

Client → server opening frame (JSON):

```json
{ "action": "start",
  "session_id": "ltx_stream_<uuid>",
  "prompt": "<page_title>",
  "width": 1920, "height": 1088,
  "num_frames": 49, "frame_rate": 24,
  "max_segments": 9999,
  "loopy_mode": true,
  "loopy_strategy": "anchor_loop",
  "start_image": "<data url>",
  "target_image": "<data url>",
  "position": 0 }
```

The `anchor_loop` strategy is how they blend between pages: each page is an "anchor frame", and the model generates an animated clip that loops seamlessly back to it.

Server → client frames use a custom binary format we've dubbed **LTXF**:

```
[0..3]   ASCII "LTXF"
[4..7]   uint32 big-endian header length n
[8..8+n] UTF-8 JSON header {media_type, sequence, is_init_segment?, final?}
[rest]   fMP4 segment bytes (moov/trak for init, moof/mdat for media)
```

The browser parses ISOBMFF boxes from the `moov`, picks the codec (observed: `avc1.640028` — H.264 High @ L4.0), opens a `MediaSource`, creates a `SourceBuffer` in `sequence` mode, and appends each payload. That's how pixels end up on a `<video>` tag without ever touching a normal video URL.

If the browser lacks MSE, they fall back to `degraded_to_image` — the static JPEG.

### Persistence

- JPEGs stored in R2. URLs look like `/api/image-proxy?…` on the site, but the underlying bucket is S3-compatible.
- Session graph via `parent_id` + `session_id` references.
- `/n/:id` permalinks rehydrate from the saved image, nothing's regenerated on reload.

## What this repo does differently

Endless Canvas replicates the paradigm and the wire protocol, but makes different choices where the original is closed:

- **BYO-keys**. Instead of a hosted service, clone the repo and plug in your own fal + OpenRouter + Modal + R2 + Mongo. No per-user billing for the maintainer.
- **Two animation paths**, not one:
  - Default: call `fal-ai/ltx-video/image-to-video` and get a 5-second MP4 for ~$0.02. No GPU infra on your side. Labelled honestly as "Animate (5s clip)" — not "stream".
  - Streaming path: the LTXF WebSocket protocol is implemented, so you *can* deploy `ltx_stream.py` on your own Modal account and get true streaming. The UI switches when `NEXT_PUBLIC_LTX_WS_URL` is set.
- **Qwen via OpenRouter instead of closed LLMs.** `qwen/qwen-2.5-vl-72b-instruct` for click resolution, `qwen/qwen-2.5-72b-instruct:online` for page planning with web search. Cheap, open-weights, swappable.
- **Seed-image uploads.** Drag any image onto `/play` (or click "Upload"). It becomes the starting page; taps on regions go through the same VLM → planner pipeline.
- **Visible status UX.** The SSE stream emits `status` events between "planning", "drawing" etc. We surface them as an overlay on the image so you can see the VLM resolve your click in real time, instead of staring at a dead image for 15 s.
- **Full Docker compose stack.** `docker compose up` brings Mongo + Python backend + Next.js up on one command, ready for a fresh laptop clone.

## Where the tweet was right, where it was ambitious

**Right:**
- The image-as-UI paradigm. Watching text render as pixels is genuinely weird and novel, typos and all.
- Click-to-explore is a more natural interaction than menus for "I want to know more about this specific thing in the illustration."
- LTX-Video running on Modal GPUs with a custom pipeline is real, and the WS protocol works.

**Ambitious:**
- "Every pixel streamed live from a model" describes the demo reel, not the default experience.
- "No HTML, no layout engine" is true for the page content. The outer chrome (search bar, share button, FAQ) is plain React.
- The video toggle is slow, expensive, and off by default.

## Why we built it anyway

Even cutting through the framing, the underlying insight — that a sufficiently-good image model can substitute for a UI toolkit — is worth playing with. If you squint, this is where "visual explainers", "interactive Wikipedia", "textbook next gen" meet. The tooling (VLM click resolution, progressive image SSE, MSE fMP4 streaming) is all commoditised now; the only reason Flipbook is closed is product strategy, not technical moat.

This repo removes that reason.
