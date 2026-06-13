# BYO Keys — running Endless Canvas yourself

## Local first (recommended)

Three steps to a first generated page — no Modal, no R2, no hosted Mongo:

```bash
cp .env.example .env          # fill FAL_KEY + OPENROUTER_API_KEY
make demo                     # → http://localhost:3000/play
```

The Docker stack runs Mongo + Minio locally and wires everything for you. Only the AI calls go to the cloud (OpenRouter + fal). See [`DOCKER.md`](./DOCKER.md) for the full compose reference.

Want the LLM local too? `make demo-local` — only `FAL_KEY` needed (Ollama handles planner + click VLM; first run pulls multi-GB models).

---

## Hosted production path

Endless Canvas has no hosted backend. To deploy to Modal + R2 yourself you need to provide:

1. **OpenRouter API key** — planning + VLM click interpretation + web search.
2. **fal API key** — image generation (nano-banana).
3. **Modal account + token** — hosts the orchestration FastAPI app (and, once step 8 lands, the LTX-2 video worker).
4. **Cloudflare R2 bucket** — blob storage for generated images.
5. **Postgres database** — metadata for the node graph. Any Postgres works (Railway, Neon, Supabase, local).

Optional for v1:

- Custom `OPENROUTER_VLM_MODEL` / `OPENROUTER_TEXT_MODEL` if you want to swap off the Gemini 3 Flash defaults (e.g. `google/gemini-3-pro-preview` for sharper click-grounding, or a direct/local provider via `LLM_PROVIDER` — see below).

## 1. Accounts & keys

| Service | Where to get it | Env var |
|---|---|---|
| OpenRouter | <https://openrouter.ai/keys> | `OPENROUTER_API_KEY` |
| fal | <https://fal.ai/dashboard/keys> | `FAL_KEY` |
| Modal | `brew install modal-cli && modal token new` | (stored on disk) |
| Cloudflare R2 | Cloudflare dash → R2 → Manage tokens. Needs *Object Read & Write*. | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| R2 public URL | Enable the R2 bucket's public dev URL, or attach a custom domain. | `R2_PUBLIC_BASE_URL` |

> **Enable CORS on the R2 bucket** (Cloudflare dash → R2 → bucket → Settings → CORS) with `AllowedOrigins` = your web origin and `AllowedMethods: [GET]`. Image conditioning crops the parent on a canvas client-side; without CORS the cross-origin image taints the canvas and the "from corners" region crop silently falls back to whole-parent conditioning. Minio (the `make demo` stack) sends CORS by default, so this only applies to the hosted R2 path.
| MongoDB | Railway → Add MongoDB (or Atlas M0 free). | `MONGODB_URI`, `MONGODB_DB` |

## 2. Set Modal secrets

Modal reads secrets at runtime from a named secret, not your local `.env`. Create one that the backend expects:

```bash
modal secret create openflipbook-secrets \
  FAL_KEY="$FAL_KEY" \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  OPENROUTER_VLM_MODEL="google/gemini-3-flash-preview" \
  OPENROUTER_TEXT_MODEL="google/gemini-3-flash-preview" \
  OPENROUTER_ENABLE_WEB_SEARCH=true
```

## 3. Deploy the Modal backend

```bash
cd apps/modal-backend
modal deploy generate.py
# → prints a URL ending in ...modal.run
```

Copy that URL into `apps/web/.env.local`:

```bash
MODAL_API_URL=https://<your-workspace>--openflipbook-generate-fastapi-ingress.modal.run
```

During development you can use `modal serve generate.py` instead — it prints a hot-reloading ephemeral URL.

## 4. Configure the web app

Create `apps/web/.env.local`:

```bash
MODAL_API_URL=...
MONGODB_URI=mongodb://...
MONGODB_DB=openflipbook
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=openflipbook
R2_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev
# Optional: WS URL from `modal deploy ltx_stream.py`.
NEXT_PUBLIC_LTX_WS_URL=
```

No DB migration step — the web app creates the `nodes` collection + indexes
on first request. See `infra/MONGO.md` for the document shape.

## 5. Run it

```bash
pnpm install
pnpm dev
# open http://localhost:3000/play
```

## Use a different LLM provider (OpenAI / Anthropic / Google / local)

By default everything routes through OpenRouter. If you'd rather use a direct
vendor key or run the models locally, set `LLM_PROVIDER` (and friends) in the
Modal secret — no code changes, no YAML. Leave it unset and nothing changes.

Every target speaks the OpenAI wire protocol, so the only things that vary are
the base URL and the key:

| `LLM_PROVIDER` | Base URL | Models to set |
|---|---|---|
| `openrouter` (default) | OpenRouter | `OPENROUTER_VLM_MODEL` / `OPENROUTER_TEXT_MODEL` |
| `openai` | `api.openai.com` | `LLM_VLM_MODEL=gpt-4o`, `LLM_TEXT_MODEL=gpt-4o-mini` |
| `google` | Gemini OpenAI-compat | `LLM_VLM_MODEL=gemini-2.5-flash` |
| `anthropic` | Anthropic OpenAI-compat | `LLM_VLM_MODEL=claude-3.5-sonnet` (runs at the `json_object` tier) |
| `custom` | your `LLM_BASE_URL` | Ollama / LM Studio / vLLM — see below |

Direct OpenAI, for example:

```bash
modal secret create openflipbook-secrets \
  FAL_KEY="$FAL_KEY" \
  LLM_PROVIDER=openai \
  LLM_API_KEY="$OPENAI_API_KEY" \
  LLM_VLM_MODEL=gpt-4o \
  LLM_TEXT_MODEL=gpt-4o-mini
```

Local via Ollama (or LM Studio on `:1234`, vLLM on `:8000`):

```bash
LLM_PROVIDER=custom
LLM_BASE_URL=http://localhost:11434/v1   # LLM_API_KEY can be blank for local
LLM_VLM_MODEL=qwen2.5vl
LLM_TEXT_MODEL=qwen2.5
```

**Honest caveat:** the whole UX rides on the click VLM grounding a tap into the
right subject, and small local VLMs are weak at structured output. The backend
detects this and walks a fallback ladder — `json_object` → forced tool-call →
prompt-with-repair — so a weak model degrades to *thinner but valid* grounding
instead of crashing. It does **not** make a 7B model ground like Gemini. Want to
know which models actually hold up? That's what the click-bench (next milestone)
is for. If your model supports JSON mode but isn't auto-detected, pin it with
`LLM_STRUCTURED_OUTPUT=json_object`.

Web search is OpenRouter-only; it's skipped on direct/local providers (the
planner still runs, just without OpenRouter-brokered grounding).

**Images** swap the same way with `IMAGE_PROVIDER` (default `fal`). Set it to
`openai` (or `custom` + `IMAGE_BASE_URL` for an OpenAI-images-compatible local
server) plus `IMAGE_API_KEY` / `IMAGE_MODEL`. fal keeps its fast/balanced/pro
tiers; non-fal backends collapse to a single `IMAGE_MODEL`, and edit-mode stays
on fal. Note fal is the expensive part of a page, so this is the bigger
cost/lock-in lever — but image quality varies a lot by model.

## Cost notes

- OpenRouter Gemini 3 Flash ($0.50/M in, $3/M out): planner ≈ $0.0005 / request, VLM ≈ $0.0015 / click resolution.
- fal nano-banana ≈ $0.02 / image (varies).
- Modal CPU container (generate.py) idles at $0; wakes for a few seconds per request.
- R2: storage is cheap, egress is free on the public dev URL.
- Railway MongoDB: hobby tier is enough to start; Mongo Atlas M0 is free.

Expected cost per "page explored": ~$0.02–0.03 of mixed spend, mostly fal.

## Future: live video toggle (step 8)

Will add a second Modal app (`ltx_stream.py`) deploying a GPU class. Costs jump to ~$2–4/GPU-hr while actively streaming — that's why it's a per-page toggle, and why the demo site only shows a prerecorded clip.
