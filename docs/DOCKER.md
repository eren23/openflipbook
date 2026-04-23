# Docker end-to-end

Three-container stack for full local E2E testing.

| Service | Container name | Port | Purpose |
|---|---|---|---|
| `mongo` | `openflipbook-mongo` | 27017 | Node metadata (replaces Railway Mongo locally) |
| `backend` | `openflipbook-backend` | 8787 | Python FastAPI (OpenRouter + fal orchestration) |
| `web` | `openflipbook-web` | 3000 | Next.js |

The web container reaches the backend via Docker's internal DNS
(`http://backend:8787`), and reaches mongo via `mongodb://mongo:27017`.
R2 stays external — keys passed through via `apps/web/.env.local`.

## Prereqs

- Docker 25+ with Compose v2.
- `apps/modal-backend/.env` with `FAL_KEY` + `OPENROUTER_API_KEY` (copy from `.env.example`).
- `apps/web/.env.local` with the `R2_*` vars. `MONGODB_*` and `MODAL_API_URL`
  are injected by compose so you can leave them out (or override).

Both env files are loaded as `required: false`, so compose won't bark if
they are missing — you'll just get 503s when the app tries to call fal /
R2.

## Run

```bash
# one shot: build + up, detached
docker compose up -d --build

# watch logs
docker compose logs -f

# tear down (keeps mongo volume)
docker compose down

# nuke everything including mongo data
docker compose down -v
```

Then open <http://localhost:3000>:

- `/` — landing
- `/play` — search bar
- `/status` — live env check (green/red per var)

## Overrides

Pass a different image backend or WS URL at `docker compose up` time:

```bash
# point web at a Modal-deployed streaming worker instead of the cheap path
NEXT_PUBLIC_LTX_WS_URL=wss://... docker compose up -d --build

# different mongo db name
MONGODB_DB=ec_staging docker compose up -d
```

## Rebuild just one service

```bash
docker compose build web
docker compose up -d --no-deps web
```

## Notes

- Next.js uses `output: "standalone"` with `outputFileTracingRoot` pointing
  at the repo root so pnpm workspace symlinks resolve cleanly inside the
  image.
- The backend image is Python 3.12 slim + the same `requirements.txt` used
  by `local_server.py`.
- Mongo runs unauthenticated on the internal network. Do NOT expose port
  27017 publicly.
- Web container runs as an unprivileged `nextjs` user (uid 1001); backend
  runs as `backend` (uid 1001) — both have no sudo.

## Debug

| Symptom | Check |
|---|---|
| `docker compose up` hangs at `web Waiting` | Backend or mongo healthcheck failing. `docker compose ps` to see which. |
| `/play` returns 503 from `/api/generate-page` | Backend can't reach fal/OpenRouter. `docker compose logs backend`. |
| `/api/nodes` 503 | R2 creds not in `apps/web/.env.local`. |
| Web container exits immediately | Next.js crash. `docker compose logs web`. |
