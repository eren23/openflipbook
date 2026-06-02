# Run it locally with Docker

One command brings up the whole stack — web, the Python backend, and **local
stores** (Mongo for metadata, Minio for image blobs). No Cloudflare R2, no
hosted Mongo, no Modal deploy to provision.

```bash
cp .env.example .env     # add FAL_KEY  (+ OPENROUTER_API_KEY)
make demo                # → http://localhost:3000/play
```

(`make demo` is just `docker compose up --build`.)

## What you need

| Path | Keys | What runs in the cloud |
|---|---|---|
| `make demo` | `FAL_KEY` + `OPENROUTER_API_KEY` | planner/click-VLM (OpenRouter), images (fal) |
| `make demo-local` | `FAL_KEY` only | images (fal) — the LLM runs locally on Ollama |

Put the keys in the repo-root `.env` (copy `.env.example`). Everything else —
Mongo URI, Minio credentials, bucket, public URLs — is wired to the local
containers with working defaults, so you don't have to set anything else.

**The images caveat.** fal is the one piece that stays in the cloud even with
`make demo-local`: there's no local model that matches nano-banana, so a
`FAL_KEY` is needed for image generation. Want fully offline? Point the M1 image
seam at a local OpenAI-Images-compatible server (`IMAGE_PROVIDER=custom` +
`IMAGE_BASE_URL`, see `docs/BYO-KEYS.md`) — expect a quality drop. And small
local VLMs ground clicks noticeably worse than Gemini; the backend's capability
ladder degrades them to thinner-but-valid output instead of crashing. Both are
fine for kicking the tyres, weaker than the hosted path.

## Services

| Service | Container | Port | Purpose |
|---|---|---|---|
| `mongo` | `openflipbook-mongo` | 27017 | node metadata |
| `minio` | `openflipbook-minio` | 9000 / 9001 | S3-compatible blob store (local R2); 9001 = console |
| `minio-setup` | `openflipbook-minio-setup` | — | one-shot: creates the bucket + makes it public-readable, then exits |
| `backend` | `openflipbook-backend` | 8787 | Python FastAPI (off Modal, via `local_server.py`) |
| `web` | `openflipbook-web` | 3000 | Next.js |
| `ollama` | `openflipbook-ollama` | 11434 | local LLM/VLM — **only with `make demo-local`** |

The web container writes blobs to Minio over the internal network
(`R2_ENDPOINT=http://minio:9000`, path-style) and the browser loads image URLs
from the published port (`R2_PUBLIC_BASE_URL=http://localhost:9000/openflipbook`,
served anonymously). Both hostnames are intentional: server-write vs
browser-read.

## Commands

```bash
make demo          # cloud AI + local stores
make demo-local    # + Ollama (local LLM), first run pulls multi-GB models (CPU-slow)
make demo-down     # stop + remove containers (keeps data volumes)
make demo-clean    # + wipe volumes (fresh DB, blob store, models)
make demo-logs     # tail logs
```

Then open <http://localhost:3000>:

- `/play` — start a session
- `/status` — live env check (green/red per var)
- Minio console at <http://localhost:9001> (login = `MINIO_ROOT_USER` /
  `MINIO_ROOT_PASSWORD`, default `openflipbook` / `openflipbook-local`).

## Overrides

Everything overridable lives in `.env` (compose auto-loads it). A few examples:

```bash
# different bucket / Minio creds
R2_BUCKET=demo MINIO_ROOT_PASSWORD=hunter2 make demo

# pin different Ollama models
LLM_VLM_MODEL=llama3.2-vision LLM_TEXT_MODEL=llama3.2 make demo-local

# use a real cloud store instead of Minio: set R2_ENDPOINT to your S3 endpoint
# (or unset it + provide R2_ACCOUNT_ID for Cloudflare) in .env
```

Rebuild a single service:

```bash
docker compose build web && docker compose up -d --no-deps web
```

## Notes

- Next.js uses `output: "standalone"` with `outputFileTracingRoot` at the repo
  root so pnpm workspace symlinks resolve inside the image.
- The backend image is Python 3.12 slim running the same `requirements.txt` as
  `local_server.py` — the standalone `fastapi_app` from `generate.py`, no Modal.
- Mongo and Minio run unauthenticated / with demo credentials on the internal
  network. This is a local demo — don't expose 27017 / 9000 publicly.
- The Modal deploy stays the production path (`docs/BYO-KEYS.md`); nothing here
  changes it.

## Debug

| Symptom | Check |
|---|---|
| `up` hangs at `web Waiting` | a dependency healthcheck is failing — `docker compose ps`. |
| images 403 / don't load | `minio-setup` didn't run — `docker compose logs minio-setup`; it must print "bucket … ready". |
| `/play` 503 from generate | backend can't reach fal/OpenRouter (or Ollama) — `docker compose logs backend`. |
| `make demo-local` slow / times out first request | models still downloading — `docker compose logs ollama-pull`. |
| `/api/nodes` 500 | blob upload failed — check `R2_*` in the web service + `docker compose logs minio`. |
