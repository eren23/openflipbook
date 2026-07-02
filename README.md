# openflipbook

> **An open-source [flipbook.page](https://flipbook.page) clone, image-is-the-UI.** Every page is an AI-generated illustration. Tap anywhere on the image and a vision model resolves what you tapped, turns it into the next page, and keeps going. Seed from a text query or drop in any image. Bring your own API keys; clone, run, hack.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/eren23/openflipbook?style=social)](https://github.com/eren23/openflipbook/stargazers)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-Modal-009688.svg)](https://modal.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

## Demo

![openflipbook demo — tap any region of an AI-generated page; a vision model resolves what you tapped and renders the next page](apps/web/public/demo.gif)

Sped up 4×: landing → `"how does a steam engine work"` deeplink → two click-to-explore hops. [Full-quality MP4 with audio](https://github.com/eren23/openflipbook/raw/main/apps/web/public/demo.mp4). Recorded with the Playwright driver under [`scripts/record-demo/`](scripts/record-demo/) — run `pnpm record-demo` to re-capture against your own stack.

## Why this exists

[flipbook.page](https://flipbook.page) is fun but closed. I wanted the same loop — one image per page, tap to explore — on a stack I actually own: my keys, my storage, my backend. This is that, MIT-licensed, with every piece swappable behind small provider interfaces in `apps/modal-backend/providers/`.

## TL;DR

- **One image per page**, rendered by fal (default balanced tier: [`nano-banana-pro`](https://fal.ai/models/fal-ai/nano-banana-pro)). Text inside the page is pixels, not DOM.
- **Click → next page.** [`google/gemini-3-flash-preview`](https://openrouter.ai/google/gemini-3-flash-preview) via OpenRouter resolves the clicked region to a phrase; the same model family plans the page with web-search grounding.
- **Seed from your own image.** Upload / drag-and-drop works as a starting point.
- **Optional animation toggle.**
  - Default: one-shot 5s MP4 from `fal-ai/ltx-video/image-to-video`. Cheap (~$0.02/clip), no GPU on your side.
  - Streaming: the same LTXF binary WebSocket protocol Flipbook uses, deployed to your own Modal account — true fragmented-MP4 streaming into a `<video>` tag via Media Source Extensions.
- **Permalinks.** `/n/:id` hydrates from Mongo + R2 without regenerating.
- **Pin a style.** Hit the 📌 on any page and every new page in the session inherits that look (palette, line work, perspective). Persists across reload.
- **Citations.** When the planner runs with `:online`, the source URLs ride through to a tiny `📎` chip in the corner of the page — one click, you can see what it actually read.
- **Shift-drag to circle a region.** Freehand stroke on the image, release, and the next page focuses on what you scribbled. Same VLM as the click path, just more pointed.
- **Time-scrubber (`T`).** Linear film-strip of every page in your trail; drag the scrubber to time-travel through your own exploration.
- **Faster clicks.** As soon as a page renders, the VLM precomputes the 3–4 most clickable regions in the background, so most taps skip the resolve round-trip.
- **Progressive render.** On the balanced/pro tiers the cheap fast model paints a draft in parallel, so you get something on screen seconds before the final lands. Toggle off with `PROGRESSIVE_DRAFT=false` if you'd rather save the extra fal call.
- **Edit a page in place.** Describe a change and the page revises itself instead of spawning a child. With `EDIT_REGION` on you drag the exact region, the mask rides the edit, and a judge scores the result — verdict chip + one-click revert included.
- **World Mode (off by default).** Flip `WORLD_MODE` and pages become places: tap a glowing region to *enter* it as a scene, go deeper, ascend back out, or pan to a logical neighbour — all rungs on one metric scale ladder. Every page gets its entities and camera extracted into a live geo overlay and a persistent world map, so revisiting a place brings back *that* place.
- **Critic loop.** Long renders (entering a scene, masked edits) are judged by a panel of VLM critics — wrong camera, wrong place, or wrong art medium gets rejected and retried with the critic's rationale folded into the prompt. You watch it self-correct instead of staring at a spinner.
- **BYO keys.** No hosted backend. Clone it, run it, pay your own bills.

```
   ┌────────────────────────┐                  ┌─────────────────────────┐
   │  type query / drop img │                  │  illustrated page       │
   └─────────┬──────────────┘                  └─────────┬───────────────┘
             │                                           │ tap on a region
             ▼                                           ▼
    ┌───────────────────┐   plan page    ┌──────────────────────────┐
    │  OpenRouter Gemini │ ─────────────▶ │  fal nano-banana-pro      │
    │  3 Flash (+ search)│                │  renders labelled image   │
    └───────────────────┘                └──────────────┬───────────┘
             ▲                                          │
             │  subject phrase                          │
             │                                          ▼
    ┌────────┴──────────┐    click +    ┌──────────────────────────┐
    │ OpenRouter Gemini 3  image ◀── │ next page conditioning    │
    │ Flash (VLM)          │               └──────────────────────────┘
                                                       │
                                                       ▼
                               ┌────────────────────────────────────┐
                               │  optional: Animate toggle          │
                               │  ├─ default: fal-ai/ltx-video clip │
                               │  └─ streaming: Modal LTX-2 via WS  │
                               │     with custom LTXF fMP4 framing  │
                               └────────────────────────────────────┘

                            persistence: Cloudflare R2 + MongoDB
```

**Read the backstory:** [`docs/STORY.md`](docs/STORY.md) — what we hoped Flipbook would be, what it actually is, and how the internals look once you crack the bundle open.

## Quickstart

The fastest path — Docker, local Mongo + blob storage, cloud AI (two keys):

```bash
git clone https://github.com/eren23/openflipbook
cd openflipbook

cp .env.example .env          # fill FAL_KEY + OPENROUTER_API_KEY
make demo                     # → http://localhost:3000/play
```

That's it. Mongo, Minio, backend, and web all come up wired together. Open [`/status`](http://localhost:3000/status) for a live env check. Full compose reference: [`docs/DOCKER.md`](docs/DOCKER.md).

**Images-only cloud:** `make demo-local` runs the planner + click VLM on local Ollama — only `FAL_KEY` needed (first run pulls multi-GB models; CPU-slow).

**Without Docker:** see [`docs/LOCAL_DEV.md`](docs/LOCAL_DEV.md).

### Hosted setup (Modal + R2)

If you want to deploy the backend to Modal and store blobs on Cloudflare R2 instead of the local stack, you'll also need Mongo/R2 credentials and a Modal token. Walkthrough: [`docs/BYO-KEYS.md`](docs/BYO-KEYS.md).

## What you need (local demo)

| Service | Used for | Variable |
|---|---|---|
| [fal](https://fal.ai/dashboard/keys) | image gen + optional animate | `FAL_KEY` |
| [OpenRouter](https://openrouter.ai/keys) | planning + click VLM + web search | `OPENROUTER_API_KEY` |

Mongo + blob storage run locally in Docker — no cloud accounts required for `make demo`.

## What you need (hosted)

| Service | Used for | Variable |
|---|---|---|
| [fal](https://fal.ai/dashboard/keys) | image gen (nano-banana) + optional animate fallback | `FAL_KEY` |
| [OpenRouter](https://openrouter.ai/keys) | planning + click VLM + web search | `OPENROUTER_API_KEY` |
| [Cloudflare R2](https://dash.cloudflare.com/?to=/:account/r2) | generated-image storage | `R2_*` + `R2_PUBLIC_BASE_URL` |
| MongoDB | node graph + session metadata | `MONGODB_URI`, `MONGODB_DB` |
| [Modal](https://modal.com) | Python backend host; optional GPU worker for streaming | `modal token new` |

Full setup walkthrough: [`docs/BYO-KEYS.md`](docs/BYO-KEYS.md).

## Repo layout

```
apps/
  web/                Next.js 15 app (landing, /play, /n/:id, /status)
  modal-backend/      FastAPI — SSE page gen, click VLM, optional LTX GPU worker
packages/
  config/             Shared TS types (GenerateEvent, LTXStreamStartMessage, …)
infra/
  MONGO.md            Document shape + hosting notes
docs/
  STORY.md            What we hoped Flipbook was, vs. what it is
  BYO-KEYS.md         Full credential walkthrough
  DOCKER.md           Compose stack docs
  LOCAL_DEV.md        Running without Docker
```

## Further reading

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — code layout, where things live, how the play surface is split into hooks vs components vs lib.
- **[docs/STORY.md](docs/STORY.md)** — the backstory + reverse-engineered LTXF protocol.
- **[docs/BYO-KEYS.md](docs/BYO-KEYS.md)** — credential + deploy walkthrough.
- **[docs/DOCKER.md](docs/DOCKER.md)** — compose stack reference.
- **[docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)** — running without Docker.
- **[docs/TESTING.md](docs/TESTING.md)** — the free gates + the paid eval benches (scenario lab, layout/style A/Bs, reconstruction bench).
- **[infra/MONGO.md](infra/MONGO.md)** — document shape + index layout.

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for ground rules (BYO-keys stays BYO-keys, one image per page, no vendored Flipbook source) and local setup. Security issues: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Eren Akbulut.

## Credits

The original paradigm, `anchor_loop` trick, and LTX-2 streaming engine are the work of [Zain Shah](https://x.com/zan2434), [Eddie Jiao](https://x.com/eddiejiao_obj), and [Drew Carr](https://x.com/drewocarr) on Flipbook. This repo is an independent open-source re-implementation written from public bundle inspection — no Flipbook source code is used.
