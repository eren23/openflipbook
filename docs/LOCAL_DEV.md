# Local Development And Self-Hosting

OpenFlipbook can run with local MongoDB and Minio. Modal, Cloudflare R2 and a
hosted database are optional. Real generation still needs configured model
providers; mock output verifies application behavior, not generative quality.

## Local Docker Stack

Prerequisites: Docker with Compose v2. Run commands from the repository root.
The default stack uses ports 3000 (web), 8787 (backend), 27017 (Mongo), and
9000/9001 (Minio). Its container names are fixed. Do not run it over an existing
installation or delete existing volumes to resolve a port conflict. Use the
isolated check below when another stack is already running.

For a new installation only, create `.env` from `.env.example`. Do not overwrite
an existing configuration. For zero-key testing, set:

```dotenv
MOCK_PROVIDERS=1
NEXT_PUBLIC_WORLD_SCENES=1
NEXT_PUBLIC_SKETCH_ENABLED=1
SKETCH_ENABLED=1
SHARED_TOKEN=replace-with-a-random-secret
```

Generate a local shared secret with `openssl rand -hex 32`. The web, backend and
worker must use the same value. Keep structured paid-generation flags disabled
until their providers and reservations are configured.

```sh
docker compose --profile world-build up --build
```

Open <http://localhost:3000/> for My Worlds, New 3D World, New Sketch and Import
World; <http://localhost:3000/play> retains image-first exploration. `/status`
shows configuration and service health. The optional `world-build` profile adds
the independent generation worker. Without it, the image-first app still runs,
but structured generation cannot accept work that requires an active worker.

The `NEXT_PUBLIC_*` flags are compiled into the client. Changing `.env` requires
rebuilding the web image, not just restarting it. Sketch and structured-world
entry points remain opt-in in production; enabling their UI does not enable a
paid provider.
The backend separately requires `SKETCH_ENABLED=1` for sketch rendering, even
with mock providers. See [Sketch configuration](SKETCH.md).

Compose initializes a single-node Mongo replica set for transactions and a
Minio bucket for assets. Their named volumes survive container restarts and
ordinary `docker compose down`. **Do not use `down --volumes` on a real
installation unless you intentionally want to delete its stored data.**

This Compose stack is for a trusted local machine, not a hardened public
deployment: its ports are published, Mongo has no authentication, and the asset
bucket permits anonymous reads. Change credentials, network exposure and asset
access policy before considering multi-user hosting. A private world/API is not
a promise of private blob URLs under this default storage configuration.

## Real Generation

Remove `MOCK_PROVIDERS=1` before expecting real model output. Configure providers
in `.env`; the default image-first setup uses `FAL_KEY` and
`OPENROUTER_API_KEY`. See `.env.example` for compatible provider overrides.
Verify current provider availability and cost before enabling paid work.

Structured layout, mesh, material and illustrated-view generation have separate
capability flags and reservation amounts. Zero or missing required reservations
disable those paths. Follow their configuration sections:

- [Place builds and worker recovery](PLACE_BUILDS.md).
- [Mesh generation and import](GENERATIVE_3D.md).
- [Generated materials](GENERATED_MATERIALS.md).
- [Saved-camera illustrations](PLACE_ILLUSTRATIONS.md).

Start with explicit, small generation requests and inspect the queue and actual
provider receipts. Reservations are conservative allocations, not guaranteed
provider invoice limits. Do not change provider/database configuration while
jobs are in flight. Saved content, export/import and replay must not submit new
model work.

`docker-compose.local.yml` optionally adds Ollama for the LLM/VLM. It does not by
itself make image or mesh generation local, and its models need downloading.

## Isolated Production Check

This opt-in check builds the real production images, creates a fresh private
Docker network and fresh Mongo/Minio volumes, and exercises the browser against
loopback-only random ports. It does not read application environment files or
copy provider keys. The image backend is mocked and structured paid generation
is disabled. Manual architecture and a labelled imported texture/mesh fixture
test persistence, not AI output quality.

Host prerequisites: Node 22 or newer, pnpm and Playwright Chromium, in addition
to Docker. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openflipbook/web exec playwright install chromium
node --test scripts/selfhost/check.test.mjs
node scripts/selfhost/check.mjs
```

On a Mac that may sleep, run the last command with `caffeinate -is` while on AC.
Linux CI may also need Playwright's system dependencies. Docker image builds
and dependency installation require network access even though the test makes
no paid generation calls.

The browser check covers image-first mock creation, manual building edits,
textured GLB import, camera capture, ZIP export/import, web/worker restart,
restored 3D pixels, walking input, cross-owner denial, and Sketch drawing plus
mock generation/save/reopen. Desktop and narrow Chromium viewports are not
physical-device certification. This is not the fresh AI-generated district
acceptance test, nor a full disaster-recovery test.

Receipts live in `apps/web/test-results/selfhost-*`. A successful run writes
`result.json`; `environment.json` alone is not a passing result. Screenshots,
failure traces and service logs are retained. The generated `compose.json`
contains ephemeral local credentials; keep it private. Normal completion and
test failure remove only the check's own containers, network and volumes.
A forcibly killed runner can leave its resources behind: inspect its receipt
and exact `ofb-check-*` project before any manual cleanup. Never substitute the
ordinary project when cleaning test resources.

To reuse images from a prior run that built all three images, provide its tag:

```sh
node scripts/selfhost/check.mjs --image-tag ofb-check-012345abcdef
```

Set `E2E_SELFHOST_VIDEO=1` before the runner command to retain silent browser
videos with slower actions and brief inspection holds. This changes recording
pace only, not provider mode or accepted geometry. These are fixture-based
workflow recordings, not a finished generative-world demonstration.

Use an actual locally built tag from the build output. Rebuild after product,
Dockerfile or build-time flag changes; an old image does not test new source.

## Host Development Processes

For hot reload, keep storage in Docker and run Python, Next and the optional
worker on the host. Use only free ports and an explicitly selected database.
Do not accidentally point tests at a real world's database.

For a new environment, install workspace dependencies with
`pnpm install --frozen-lockfile`. In `apps/modal-backend`, create a Python 3.12
virtual environment with `uv venv --python 3.12 --seed`, then install
`requirements.txt` into it. Configure its `.env` with the intended provider or
mock settings and matching shared token.

Set `apps/web/.env.local` for host networking, using the actual chosen ports:

```dotenv
MODAL_API_URL=http://127.0.0.1:8787
MONGODB_URI=mongodb://127.0.0.1:27017/?directConnection=true
MONGODB_DB=openflipbook
R2_ENDPOINT=http://127.0.0.1:9000
R2_BUCKET=openflipbook
R2_ACCESS_KEY_ID=openflipbook
R2_SECRET_ACCESS_KEY=openflipbook-local
R2_PUBLIC_BASE_URL=http://127.0.0.1:9000/openflipbook
SHARED_TOKEN=the-same-local-secret
NEXT_PUBLIC_WORLD_SCENES=1
NEXT_PUBLIC_SKETCH_ENABLED=1
```

These Minio credentials are the local Compose defaults, not recommended public
credentials. Match any changes you made. `directConnection=true` is needed for
host clients because the replica set advertises its Docker hostname `mongo`.

Run these in separate terminals:

```sh
# From apps/modal-backend
PORT=8787 .venv/bin/python local_server.py
```

```sh
# From apps/web; choose a different port if 3000 is occupied
pnpm exec next dev --port 3003
```

```sh
# From apps/web; the worker does not implicitly load .env.local
node --env-file=.env.local --import tsx scripts/place-build-worker.ts
```

Open <http://localhost:3003/> for the example development command above. Keep
the worker's database, storage endpoint, backend and token aligned with Next.
The Docker web image uses Node 22; test host tooling on a compatible runtime.

## Persistence And Troubleshooting

Use world ZIP export and My Worlds > Import World for supported scene/archive
round trips. Import validates dependencies, previews the archive and creates a
new private world on explicit confirmation. It is not a complete database/blob
backup: external video bytes, some drafts/reference assets and private-note backup
are still unfinished. [Operator-mediated ownership recovery](OWNER_RECOVERY.md)
is available and tested separately from content import. Retain your existing stores
and browser ownership credentials; do not use a successful world import as
justification to erase an installation.

| Symptom | Check |
| --- | --- |
| Missing New Sketch or New 3D World | Set the relevant build-time flag and rebuild web. |
| Generation unavailable | Inspect `/status`, backend capabilities, reservations and worker heartbeat. |
| Backend request rejected | Match `SHARED_TOKEN` across web, worker and backend. |
| Save or transaction failure | Check Mongo connectivity and replica-set initialization. |
| Image/mesh fails to load | Check both the internal storage endpoint and browser-facing public base URL. |
| A queued job stops progressing | Inspect the independent worker logs; do not blindly resubmit ambiguous work. |
| Docker startup fails | Check occupied ports, existing fixed container names, and service logs. |

Use `docker compose --profile world-build logs --tail 100 web backend place-worker`
for your ordinary local stack. For an isolated check, use its retained service
log instead. Logs and receipts can contain user prompts and private identifiers;
review before sharing.
