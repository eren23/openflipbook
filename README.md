# Endless Canvas

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> An open-source take on [flipbook.page](https://flipbook.page). Every page is an AI-generated image. Click anywhere on the image and a vision model resolves what you tapped, turns it into the next page, and keeps going. Seed from a text query or drop in any image.

## Demo

![openflipbook demo](apps/web/public/demo.gif)

Sped up 4x: landing → "how does a steam engine work" deeplink → two click-to-explore hops. [Full-quality MP4 with audio](https://github.com/eren23/openflipbook/raw/main/apps/web/public/demo.mp4). Recorded with the Playwright driver under [`scripts/record-demo/`](scripts/record-demo/) — run `pnpm record-demo` to re-capture against your own stack.

**Read the backstory:** [`docs/STORY.md`](docs/STORY.md) — what we hoped Flipbook would be, what it actually is, and how the internals look once you crack the bundle open.

```
   ┌────────────────────────┐                  ┌─────────────────────────┐
   │  type query / drop img │                  │  illustrated page       │
   └─────────┬──────────────┘                  └─────────┬───────────────┘
             │                                           │ tap on a region
             ▼                                           ▼
    ┌───────────────────┐   plan page    ┌──────────────────────────┐
    │  OpenRouter Qwen  │ ─────────────▶ │  fal-ai/nano-banana       │
    │  (text + :online) │                │  renders labelled image   │
    └───────────────────┘                └──────────────┬───────────┘
             ▲                                          │
             │  subject phrase                          │
             │                                          ▼
    ┌────────┴──────────┐    click +    ┌──────────────────────────┐
    │ OpenRouter Qwen 2.5 VL  image ◀── │ next page conditioning    │
    └───────────────────┘               └──────────────────────────┘
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

## TL;DR

- **One image per page**, rendered by [`fal-ai/nano-banana`](https://fal.ai/models/fal-ai/nano-banana) (Gemini 2.5 Flash Image). Text inside the page is pixels, not DOM.
- **Click → next page.** [`qwen/qwen-2.5-vl-72b-instruct`](https://openrouter.ai/qwen/qwen-2.5-vl-72b-instruct) via OpenRouter resolves the clicked region to a phrase; [`qwen/qwen-2.5-72b-instruct:online`](https://openrouter.ai/qwen/qwen-2.5-72b-instruct) plans the page with web-search grounding.
- **Seed from your own image.** Upload / drag-and-drop works as a starting point.
- **Optional animation toggle.**
  - Default: one-shot 5s MP4 from `fal-ai/ltx-video/image-to-video`. Cheap (~$0.02/clip), no GPU on your side.
  - Streaming: the same LTXF binary WebSocket protocol Flipbook uses, deployed to your own Modal account — true fragmented-MP4 streaming into a `<video>` tag via Media Source Extensions.
- **Permalinks.** `/n/:id` hydrates from Mongo + R2 without regenerating.
- **BYO keys.** No hosted backend. Clone it, run it, pay your own bills.

## Quickstart

```bash
git clone https://github.com/eren23/openflipbook
cd openflipbook

# Prereqs
brew install pnpm modal-cli uv      # or your equivalents
docker --version                    # for docker compose path

# Python backend deps
cd apps/modal-backend
uv venv --python 3.12 --seed && source .venv/bin/activate
uv pip install -r requirements.txt
cp .env.example .env                # fill FAL_KEY + OPENROUTER_API_KEY
cd ../..

# Web env
cp .env.example apps/web/.env.local
# fill: MONGODB_URI, MONGODB_DB, R2_*, MODAL_API_URL (=http://backend:8787 if using compose)

# Dev loop
docker compose up -d --build        # one-command E2E: mongo + backend + web
open http://localhost:3000/play
```

Open `/status` in the browser for a live env check with green/red badges per missing variable.

## What you need

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

- **[docs/STORY.md](docs/STORY.md)** — the backstory + reverse-engineered LTXF protocol.
- **[docs/BYO-KEYS.md](docs/BYO-KEYS.md)** — credential + deploy walkthrough.
- **[docs/DOCKER.md](docs/DOCKER.md)** — compose stack reference.
- **[docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)** — running without Docker.
- **[infra/MONGO.md](infra/MONGO.md)** — document shape + index layout.

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for ground rules (BYO-keys stays BYO-keys, one image per page, no vendored Flipbook source) and local setup. Security issues: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Eren Akbulut.

## Credits

The original paradigm, `anchor_loop` trick, and LTX-2 streaming engine are the work of [Zain Shah](https://x.com/zan2434), [Eddie Jiao](https://x.com/eddiejiao_obj), and [Drew Carr](https://x.com/drewocarr) on Flipbook. This repo is an independent open-source re-implementation written from public bundle inspection — no Flipbook source code is used.
