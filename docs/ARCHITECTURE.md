# Architecture

Map of how the openflipbook codebase fits together. Read this before
adding a new file. The repo is small but the play surface is dense, and
"where does this live" answers are rarely obvious from the file tree.

## Two apps, one repo

```
apps/web/             Next.js 15 app (landing, /play, /n/:id, /atlas, /status)
apps/modal-backend/   FastAPI on Modal — SSE generate, click VLM, optional LTX worker
packages/config/      Shared TS types (GenerateEvent, GenerateRequestBody, …)
infra/                Mongo doc-shape notes
docs/                 You are here
scripts/perfbudget/   Playwright-driven perf-budget harness (label-gated CI)
scripts/record-demo/  Playwright recorder for the README demo gif
```

Web talks to the backend exclusively via SSE / JSON over `/api/*` Next
routes that proxy to `MODAL_API_URL`. There is no direct browser →
backend link beyond the optional LTX WebSocket.

## The play surface

`/play` is the only page that's grown a real internal architecture.
Everything else is a thin Next.js page.

### Layer cake

```
apps/web/app/play/page.tsx       orchestrator: wires everything together
        ↑
  ┌─────┴─────┐
  hooks/      components/PlayPage/
  state +     pure visual building blocks
  effects     (no closure capture of orchestrator state)
  ↑
  lib/
  pure helpers (trace, image-click math, layout math, i18n)
```

**Rule of thumb when adding code to `/play`:**

| It is mostly | Put it in |
| --- | --- |
| Pure JSX with props in, no React state, no hooks | `components/PlayPage/` |
| State + effects (ref shape, localStorage, listener install) | `hooks/` |
| Pure function over inputs (math, parsing, formatters) | `lib/` |
| Wiring / orchestration of multiple hooks together | `app/play/page.tsx` |

### `apps/web/hooks/`

Each hook owns one bounded concern. Hooks must not import each other —
the orchestrator (`page.tsx`) is the only place that composes them.

- `usePersistedTier` — `useImageTier`, `useVideoTier`. localStorage round-trip + first-run guard. The pro-tier console warning lives here too because it's tier-specific.
- `usePersistedLocale` — `outputLocale` + reflects `<html lang>` and `dir=rtl`.
- `usePersistedTheme` — `theme` + reflects `<html data-theme>`. First-run guard skips the post-mount write so it doesn't clobber the pre-paint attribute set by `public/theme-init.js`.
- `useStyleAnchor` — load/save the session's pinned style by `sessionId`; `togglePin(page)` owns the `/api/resolve-click` round-trip.
- `useTraceEmitter` — `bindTrace(id, {announce})` dedupes the "I just minted a new trace id" trio: push to `setLastTrace` for the HUD, optionally emit `sse:status` request marker.
- `useImageMorph` — `morphFx` state + the `Image().decode()` pre-flip effect. Caller is responsible for setting morphFx when a click fires; the hook handles `wait → reveal`.
- `usePrefetchCache` — refs + `bucketKey` (3% grid → ~1100 cells/page) + `clearTimer` + `reset`. Owns the storage shape; the orchestrator still owns the precompute / hover-debounce effects (those need `page`, `phase`, `generate` from the orchestrator).
- `useKeyboardShortcuts` — global keydown listener with one bool `anyOverlayOpen` and a flat handler interface. Modifier rule (skip on Cmd/Ctrl/Alt) keeps DevTools/copy/paste reachable.
- `useFirstRunCoach` — single-shot "have we shown the coach?" flag in localStorage.

### `apps/web/components/PlayPage/`

All pure-visual primitives for the play surface. Each takes plain
props, has no state of its own beyond UI-local refs (`Quickbar`'s focus
ref), and no closure over orchestrator data.

- `QueryToolbar` — the top bar (input, upload trigger, locale, theme, image-tier, submit + the hidden file input).
- `MorphImagePair` — the two `<img>` layers used during a scale-from-origin morph (outgoing prevImg + incoming nextImg).
- `StrokeOverlay` — dual-polyline (white halo + red) for the Shift-drag scribble. Returns null for <2 points.
- `HoverCrosshair` — custom red-on-white pointer marker over the image (replaces `cursor-none`).
- `ClickRipple` — animated focus ring at the last click coords during a generation.
- `BranchBeacons` — pill markers at click coords where a child page already exists.
- `GeneratingBanner` — bottom-of-canvas pill showing the current SSE stage.
- `EditForm` — the inline edit-mode form (instruction input + apply).
- `ImageFailedOverlay` — shown when `<img onError>` fires.
- `DragDropOverlay` — full-screen drop hint.
- `Quickbar` — `/`-keyboard quickbar (filters trail, Enter picks top match).
- `HelpOverlay` — `?` modal listing every shortcut.
- `ContextMenu` — right-click page menu (copy permalink / toggle beacons / prune branch).
- `FirstRunCoach` — bottom-of-page hint chip surfaced once per browser.

### `apps/web/lib/`

Pure helpers, easy to unit-test.

- `trace.ts` — `newTraceId`, `withTrace`, the HUD pubsub (`emit` / `on`), `mark` / `measure`. **Single-source-of-truth for tracing**; do not reimplement.
- `image-click.ts` — `normalizeClickOnImage` (letterbox math), `summarizeStroke`, `annotateClickPoint` / `annotateStroke` (canvas re-encode + crosshair / polyline).
- `i18n.ts` — locale tables, `detectLocale`, `getStrings`, `isRTL`, `resolveOutputLocale`.
- `world-layout.ts` — branching-tile layout math for the world-map view.
- `db.ts` — Mongo client; only used in `/api/*` route handlers.
- `r2.ts` — S3 client for Cloudflare R2.
- `stream-client.ts` — LTX WebSocket client (or fal-fetch fallback).
- `mse-player.ts` — Media Source Extensions playback for fragmented mp4.
- `ltxf-parser.ts` — frame parser for the custom LTXF binary protocol.
- `env.ts` — env-var validation.

### `apps/web/app/play/page.tsx`

The orchestrator. Sized to **~1,887 lines** as of the latest refactor
pass — was 2,522 before extractions started. Still owns:

1. Top-level state that crosses hook boundaries: `page`, `phase`, `history`, `error`, `quickbarOpen`, `helpOpen`, `contextMenu`, `editMode`, `streamStatus`, `clickRipple`, `hoverPos`, `imgFailed`, `progressiveDraft`, `beaconsHidden`, `viewMode`.
2. The `generate()` callback (~200 lines, SSE reader + dispatch).
3. The pointer handler effect (~170 lines, click + Shift-drag stroke + hover-prefetch tied together).
4. Stream connect/disconnect for the LTX video path.
5. Session hydration on `?continue=`.
6. Top-level JSX: composes the toolbar + the `<figure>` + map view + scrubber + HUDs + overlays.

**Why these still live here:** they read or write 4+ pieces of cross-hook state and aren't separable without first introducing a `PlayContext` reducer. That extraction (`useGenerationStream` + `PlayContext` for `{page, phase, history, error}`) is the next planned slice — it's the one big lift that's intentionally bundled with a green E2E pass for visual-diff verification.

## Backend (`apps/modal-backend/`)

```
generate.py        FastAPI app: /sse/generate, /resolve-click, /precompute-candidates,
                   /animate, /health. _event_stream is the orchestrator.
ltx_stream.py      Optional LTX-Video GPU worker (Modal H100). Deploys separately.
ltxf.py            LTXF binary frame protocol encoder/decoder.
local_server.py    uvicorn driver for `pnpm backend` (no Modal needed).
obs.py             trace_var ContextVar, span() async timer, log() to stdout JSON,
                   sentry-sdk init (no-op without SENTRY_DSN), provider health probes.
providers/         Pluggable. Each module is a small interface with env-driven slugs:
  image.py         fal-ai image gen (tier-aware: nano-banana / nano-banana-pro / seedream)
  image_edit.py    fal-ai edit models
  llm.py           OpenRouter via openai SDK; cache-control, web-search routing
  video.py         fal-ai video (LTX / Wan / LTX-2 per tier)
```

`_event_stream` is the only thing in the backend with real internal
structure. It runs:

1. (tap mode only) `click_to_subject` VLM → resolve subject phrase
2. `plan_page` → page title + image-gen prompt + facts + citations
3. Image generation — with optional progressive draft (fast tier + main tier raced; first one through wins)
4. Final SSE event with the b64 data URL

Between each stage it polls `is_disconnected()` so a client
`AbortController.abort()` actually halts fal/openrouter spend. Errors
surface via `obs.record_error` which both logs and pages Sentry.

## Tracing & observability

Every browser → backend hop carries an `x-trace-id` header. The
backend's `obs.bind_trace` puts it on a `ContextVar` so async
`span()`s log it; the frontend's `lib/trace.ts` HUD pubsub fires events
that the `WaterfallHUD` and `DebugHud` components listen to.

Sentry is wired in both apps but **does nothing without a DSN** — the
SDKs check the env at init and bail. Setting `SENTRY_DSN` enables it
with PII scrubbing on by default.

## Tests

| Layer | Runner | Files | Tests |
| --- | --- | --- | --- |
| `apps/web` lib + hooks | Vitest + happy-dom | `lib/*.test.ts` + `hooks/*.test.tsx` | 65 |
| `apps/modal-backend` providers | pytest | `tests/test_*.py` | 59 |
| `apps/web` golden paths | Playwright | `e2e/*.spec.ts` | 3 (label-gated in CI) |

Adding a new hook or component: write a test next to it in the same
folder (`Foo.tsx` ↔ `Foo.test.tsx`). The test setup file
(`tests/setup.ts`) installs an in-memory Storage shim — neither happy-dom
nor jsdom returns a real Storage in this stack.

The Playwright suite needs a running stack (`docker compose up -d`) +
real keys; it's gated behind the `e2e:run` PR label so it doesn't burn
fal/openrouter credits on every commit. Same gate exists for
`perfbudget` (label `perf:run`).

## CI

Five jobs in `.github/workflows/ci.yml`:

| Job | Trigger | Does |
| --- | --- | --- |
| `lint` | every push/PR | `pnpm lint` (max 20 warnings) |
| `typecheck` | every push/PR | `tsc --noEmit` across the workspace |
| `test-web` | every push/PR | Vitest |
| `build` | after lint + typecheck | `pnpm --filter @openflipbook/web build` |
| `python-check` | every push/PR | ruff + mypy + pytest |
| `e2e` | label `e2e:run` | docker compose + playwright |
| `perfbudget` | label `perf:run` | docker compose + scripts/perfbudget/run.ts |

Pre-commit (husky + lint-staged) runs ESLint --fix on staged TS/JS and
ruff check --fix on staged Python.

## When you add a new feature

1. Decide which layer it belongs in using the table above.
2. If it needs cross-hook state, add it to `page.tsx` for now and flag the eventual home in a comment — one of the deferred extractions (ImageCanvas, useGenerationStream, PlayContext) probably owns it long-term.
3. Write a unit test in the same folder if the layer permits (hooks/lib/tests). Skip the unit test for pure visual components if there's nothing branching to assert.
4. Run `pnpm lint && pnpm typecheck && pnpm test` locally.
5. If it touches the backend, also run `pytest` and `ruff check` from `apps/modal-backend/` against a local venv.

## Deferred work (read before starting)

These are intentionally not done — extracting them needs a green
Playwright run for visual / behavioural diff and they're tightly
coupled enough to pull in each other.

- **ImageCanvas** — the `<figure>` wrapper that today bundles the morph image pair, stroke overlay, hover crosshair, click ripple, edit form, video fallback, and the click+stroke handler effect. Probably becomes one component plus a `useAnnotationStroke` hook.
- **useGenerationStream + PlayContext** — wraps the 200-line `generate()` callback into a hook backed by `useReducer({page, phase, history, error}, action)`. This is what unblocks the rest of `page.tsx`.
- **SVG crosshair** — replace the `annotateClickPoint` canvas re-encode with an absolutely-positioned SVG overlay. Saves ~100-200ms/click but changes what the VLM sees, so needs a quality regression check.
- **Mobile gestures** — pinch to focus, two-finger tap = back. Ride along with ImageCanvas since gestures attach to the same surface.
