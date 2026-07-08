# record-demo

Playwright driver that records the demo clip embedded on the landing page and in the README. The raw capture is a couple of minutes (each generation hop takes real time); ffmpeg then applies a 4x speedup so the final clip lands around 30-40 s.

## Prerequisites

- The full stack running on `http://localhost:3000` with real keys (fal, OpenRouter, R2, MongoDB, Modal). `docker compose up -d --build` from the repo root is the easiest path.
- `ffmpeg` on `PATH` (used to transcode Playwright's WebM to a compact H.264 MP4 and extract a poster JPEG).

## Run

From the repo root:

```bash
pnpm record-demo
```

This is a thin wrapper around:

```bash
cd scripts/record-demo
pnpm install            # also triggers `playwright install chromium`
pnpm start              # runs record.ts
```

## Output

- `scripts/record-demo/artifacts/*.webm` — Playwright's raw capture. Gitignored.
- `apps/web/public/demo.mp4` — H.264 MP4 served by the web app. Committed.
- `apps/web/public/demo-poster.jpg` — poster frame rendered before the user plays the clip. Committed.

## Notes

- Headless Chromium by default. Set `DEMO_BASE_URL=https://your-host` to record against a remote deploy.
- If fal / OpenRouter calls take longer than 90 s per hop, bump the `*_TIMEOUT_MS` constants in `record.ts`.
- If the MP4 comes out over ~8 MB, increase the `-crf` argument (24 → 26) in `record.ts`.
- To skip the speedup and preserve real-time cadence, set `SPEEDUP_PTS` to `1` in `record.ts`.

## Feature studies (`record-features.ts`)

A config-driven sibling recorder: one **study** per shipped feature, each a
self-contained walkthrough that drives the real app (real mouse, real
generations) and sequences on real signals — image-settled (waits for the
*final*, not a stable draft), node-changed, and per-response resolver verdicts.
Every study records its own clip so it can be **audited frame-by-frame before
anyone trusts it** (the PR #129 "error-infested video" lesson).

**Extend it:** add one entry to the `STUDIES` array in `record-features.ts`.
That is the whole contract — `{ name, run(page, helpers) }`.

```bash
cd scripts/record-demo
DEMO_BASE_URL=http://localhost:3001 ./node_modules/.bin/tsx record-features.ts          # all
DEMO_BASE_URL=http://localhost:3001 ./node_modules/.bin/tsx record-features.ts wander    # one
./encode-studies.sh                    # WebM → MP4 (1.6x) + 1 fps audit frames
```

Output (gitignored, under `studies/`):
- `studies/<name>.mp4` — the clip.
- `studies/frames/<name>/*.jpg` — 1 fps audit frames.
- `studies/raw/<name>/*.webm` — raw capture + `console-errors.json`.

Notes:
- Runs against `:3001` too (pass `DEMO_BASE_URL`) — handy when another project
  holds `:3000`. Bring the world stack up with the port override in the repo root.
- Studies burn **real** fal/OpenRouter spend — one page per hop. Record
  individually (`… record-features.ts <name>`) to keep any one run off a stack
  that a long batch has bogged down, and watch the fal balance.
