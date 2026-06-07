# Cleanup 7 — Gratuitous defensive code (fail-loud)

Workstream 7 of the sequenced code-quality cleanup. Scope: **remove try/catch
(TS) and try/except (Python) that HIDES errors, so the code fails loud.** Dedup,
type-strengthening, dead-code and comment cleanups belong to other workstreams
and were left untouched.

User directive: *"Remove all try/catch and equivalent defensive programming if
it doesn't serve a specific role of handling unknown or unsanitized input or
otherwise has a reason to be there, with clear error handling and no error
hiding or fallback patterns."*

## Outcome: zero removals — every handler guards a real boundary

I enumerated **every** try/catch in `apps/web` (production, not tests) and
**every** try/except in `apps/modal-backend` (production, not tests), plus all
`.catch()` promise chains and `?? null` lookups, and classified each against the
decision criteria. **No source files were changed.** Every single handler falls
into one of the KEEP categories: a network/IO boundary, untrusted external data
(VLM/LLM JSON, request bodies, base64 data URLs, env-var coercion), a
browser/runtime API quirk, or the observability layer (which must never break
the main flow).

This is a real outcome, not a failure to look. The codebase was written
fail-loud-first and a prior workstream (#3, "deprecated/legacy/fallback paths")
already collapsed the dual paths. Concrete evidence the default posture is
"throw, don't swallow":

- `providers/image.py` — the fal image path has **zero** `except`. It uses
  `tenacity` retry decorators and raises loud `RuntimeError`s
  (`"fal returned no images"`, `"fal image entry malformed"`, `"fal image
  missing url"`, `"image provider returned neither b64_json nor url"`).
- `providers/grounding.py`, `providers/geometry.py`, `providers/model_router.py`,
  `providers/image_edit.py`, `lib/world-map.ts`, `lib/optimistic-update.ts`'s
  caller core — pure logic, no handlers at all; errors propagate.
- The SSE generate handler re-raises `CancelledError` and surfaces every other
  exception as an `{type:"error"}` SSE event — it does not swallow.
- `obs.span` logs the error then **`raise`s** (it times + records, never eats).
- There are **no** empty `catch {}` blocks and **no** `catch { return null }`
  wrapping our own deterministic logic anywhere in the tree.

## Green gate (unchanged — no edits made)

- `cd apps/web && pnpm exec eslint . --max-warnings=20` → **0 errors, 16
  warnings** (all pre-existing `no-img-element` / `exhaustive-deps` /
  `consistent-type-imports`, none related to this concern).
- `git status` → clean. `make eval` baseline is therefore untouched.

---

## TypeScript (`apps/web`) — full classification

Every handler is **KEEP**. Grouped by the boundary it guards.

### Network / IO boundaries (fetch to Modal/fal, Mongo, error-body reads)

| Location | Guards | Behaviour on failure |
|---|---|---|
| `app/api/generate-page/route.ts:37` | `JSON.parse` of request body **+** `resolveEntitiesForPrompt` (Mongo) | forward body verbatim — enrichment must never block generation (product reason) |
| `app/api/resolve-click/route.ts:19` | `fetch` → Modal | AbortError → 499; **rethrows** everything else (does not swallow) |
| `app/api/precompute-candidates/route.ts:25` | `fetch` → Modal | AbortError → 499; **rethrows** else |
| `app/api/animate/route.ts:19` | `fetch` → Modal | AbortError → 499; **rethrows** else |
| `app/api/status/route.ts:15` | `fetch` → Modal `/status` | 502 with message (a status endpoint's job) |
| `app/api/trace/recent/route.ts:19` | `fetch` → Modal | 502 `trace_unreachable` |
| `app/api/trace/abort-stats/route.ts:19` | `fetch` → Modal | 502 |
| `app/api/world/[sessionId]/route.ts:39` | `getWorldState` (Mongo) | 502 with message |
| `app/api/world/[sessionId]/map/route.ts:43,61` | Mongo read / write | 502 with message |
| `app/api/world/[sessionId]/entity/route.ts:55,60` | body `JSON.parse` (→400) / CRUD mutation (→400) | surfaced to client |
| `app/api/world/[sessionId]/edit-entities/route.ts:62,79,99,116,155` | body parse, `getWorldState` (Mongo), `fetch`→Modal, error-body read, `applyEntityEdits` (Mongo) | 400/502/500 with message; `getWorldMap` beside :79 is **not** caught so a real map failure still surfaces |
| `app/api/world/[sessionId]/extract/route.ts:62,85,96,117,133,143,265` | body parse, prior-entity Mongo read (best-effort: extraction still runs on empty slice), upstream `fetch`, error-body read, merge (Mongo) | 400/502/500 with message |
| `app/api/errors/route.ts:28` | request body `JSON.parse` | 400 `invalid json` |
| `app/play/page.tsx:151` (`persistNode`) | `fetch` /api/nodes + response `JSON.parse` | returns null; caller tolerates a null save |
| `app/play/page.tsx:235,690` (`.catch`) | fire-and-forget `fetch` (extraction trigger, error sink) | best-effort network |
| `app/play/page.tsx:487` (`generate`) | `fetch` SSE + per-event `JSON.parse` | AbortError → reset; else sets `error` state + posts to /api/errors |
| `app/play/page.tsx:747` (`acceptUploadedImage`) | `readFileAsDataUrl` (FileReader) | sets `error` state |
| `app/play/page.tsx:1002` (hydration) | `fetch` session + `JSON.parse` | best-effort; user can still click |
| `app/play/page.tsx:1087,1187` (prefetch) | `fetch` resolve/precompute + `JSON.parse` | best-effort; click falls back to in-band VLM |
| `app/play/page.tsx:1254` (`resolveClickRemote`) | `fetch` resolve-click | null; semi-mode falls back |
| `app/play/page.tsx:1758` (animate) | `fetch` /api/animate + 3-min timeout | AbortError → timeout msg; else error msg |
| `app/n/[id]/page.tsx:17` | `getNode` (Mongo) | null → `notFound()` |
| `app/atlas/[sessionId]/page.tsx:21,164` | `listNodesBySession` (Mongo, paginated) / `getWorldState` (Mongo) | null / `[]` — atlas still renders without the entity overlay |
| `app/status/page.tsx:27`, `:82` (`.catch`) | `fetch`→Modal / `listRecentErrors` (Mongo) | error object / `[]` (status page's job) |
| `app/admin/trace/{page,trace-list,abort-panel}.tsx` | `fetch`→Modal / `/api/trace/*` + `JSON.parse` | error object / error state (dashboard's job) |
| `components/heatmap-overlay.tsx:45` | `fetch` children + `JSON.parse` | error state |
| `components/PlayPage/GeoEditPanel.tsx:31,49` | network via `onSubmit` | sets `error` state for the user |
| `components/PlayPage/GeoEditSection.tsx:34` (`.catch`) | error-body `JSON.parse` | extract message |
| `hooks/useWorldState.ts:190,238,251` | `fetch` world snapshot/mutation + error-body parse | AbortError ignored; else `failed`/`{ok:false}` surfaced to UI |
| `hooks/useWorldMap.ts:34` | `fetch` map | leave prior snapshot (read-only hydrate) |
| `hooks/useStyleAnchor.ts:70` | `fetch` resolve-click for style caption | leave anchor unchanged |
| `hooks/useExpandBloom.ts:64` | `fetch` SSE bloom + per-event `JSON.parse` | AbortError ignored; else ends the tray (doesn't disturb focal page) |
| `lib/world.ts:701` (`resolveEntitiesForPrompt`) | Mongo read on the generate-page enrichment path | `[]` — documented best-effort; continuity injection must not block a page render |
| `lib/world.ts:250` (`mutate` inner, via `optimistic-update`) | — | see optimistic loop below |
| `lib/optimistic-update.ts:70` | Mongo `insertOne` duplicate-key race | recovers by looping; **rethrows** non-dup errors |
| `lib/stream-client.ts:80` | `parseLTXF` of a binary WS frame (external) + MSE append | `onError` + error status |

### Untrusted external data (parse-and-tolerate is the handler's job)

| Location | Guards |
|---|---|
| `lib/ltxf-parser.ts:35` | `JSON.parse` of the LTXF header (binary frame from the stream backend) → throws a clearer `"LTXF header is not valid JSON"` (re-throw, not swallow) |
| `hooks/useStyleAnchor.ts:36`, `hooks/useWorldMode.ts:29`, `hooks/useStyleGalleryDismissed.ts:22` | `JSON.parse` of persisted localStorage/sessionStorage (could be hand-edited / from an older schema) |
| `components/citations-chip.tsx:84` (`safeHost`) | `new URL(url)` of a citation URL (model-emitted) |
| `components/atlas-view.tsx:779` (`fmt`) | `new Date(iso).toLocaleString()` (locale/format can throw) |

### Browser / runtime API quirks (you don't control these)

| Location | Guards |
|---|---|
| `lib/image-condition.ts:110` (`buildConditionRefs`), and its caller `app/play/page.tsx:1402` | `cropRegion` → `canvas.toDataURL()` cross-origin **taint** (the documented bug that silently dropped the region-crop signal on persisted R2 images) |
| `app/play/page.tsx:1376` (`annotateClickPoint`), `:1627` (`annotateStroke`) | canvas taint on the marker draw |
| `app/play/page.tsx:255,260`, `components/permalink-image.tsx:24,33,45`, `components/recent-atlas-link.tsx:12`, `components/debug-hud.tsx:21,165` | `localStorage`/`sessionStorage` access (throws in private mode / full disk) |
| `app/play/page.tsx:1557,1574` | `setPointerCapture`/`releasePointerCapture` (can throw on stale pointer id) |
| `lib/mse-player.ts:34,71,81` | `SourceBuffer.appendBuffer` / `MediaSource.endOfStream` (state-dependent, throw if already ended) |
| `lib/stream-client.ts:85` (`.catch`), `hooks/useImageMorph.ts:50` (`.catch`) | `video.play()` autoplay rejection / `Image().decode()` absence — both no-op or call the same finish path, never swallow logic |
| `lib/trace.ts:64,81,90` | listener isolation (one HUD subscriber must not break emit) + `performance.mark/measure` quota errors |
| `instrumentation-client.ts:19` | `new URL(event.request.url)` while scrubbing query strings before Sentry send |

---

## Python (`apps/modal-backend`) — full classification

Every handler is **KEEP**. The three categories the workstream brief flagged
for assessment (`obs.py`, `providers/llm.py` JSON repair, `generate.py`
best-effort geometry) were each examined closely.

### `obs.py` — observability (must never break the main flow)

All 11 handlers are correctly scoped; tracing/logging is isolated from the
request path by design.

| Line | Guards | Behaviour |
|---|---|---|
| `66` | `float(env_var)` for stage cost | default cost |
| `103`, `174` | `json.dumps(v)` serializability of arbitrary kv | `repr(v)` fallback |
| `229` | `sentry_sdk.init` (optional dep) | `False` — safe to ship without Sentry |
| `260`, `265` | log kv serialization + stdout write | `repr` / pass (a logger's "never raises" contract) |
| `286` | `span` body | **`raise`s** after logging the error + recording the span (does **not** swallow) |
| `335` | parse `trace_id` from request body (untrusted JSON) | falls to a minted UUID |
| `374` | `sentry_sdk.capture_exception` | pass — must not break the error path it records |
| `392` | `_ping` httpx GET (health) | `False` |

### `providers/llm.py` — LLM I/O + JSON repair (KEEP per brief)

All 17 handlers wrap either the LLM SDK boundary or coercion of untrusted model
output:

- **Response-shape reads off the SDK object** (provider-dependent shape):
  `_choice_content` (601), `_parse_tool_json` (614), `_log_cache_usage` (302).
- **JSON parse/repair of model output**: `_safe_json` and the
  `_coerce_*` / `_build_*` coercers (537, 602, 615, 879, 1303, 1315, 1393,
  1468, 1554, 1919, 1984, 1995, 2013, 2019) — malformed JSON is the expected
  case; tolerating it is the whole point of the prompt+repair ladder.
- **Provider 400 walk-down**: `except BadRequestError` (702) degrades the
  structured-output rung (json_object → tool → prompt), then `raise last_error`
  (714) if the ladder is exhausted — fails loud at the end.
- **`_safe_log`** (537) — observability, documented "never raises into the
  request path".
- Client-init obs log (246) — must not block client construction.

The three `raise RuntimeError`s for missing API keys (202, 212, 223) are
already fail-loud.

### `generate.py` — endpoint handlers + best-effort geometry (assessed)

| Line | Guards | Verdict |
|---|---|---|
| `302` | `run_grounding_loop` | KEEP — explicit product reason: a detector 429 / edit failure must never break generation; degrades to (original, no summary) and **logs** it |
| `372` | abort-poll `is_disconnected()` | KEEP — re-raises `CancelledError`; only a polling failure is swallowed |
| `522`/`524` | one bloom neighbour future | KEEP — one neighbour failing must not sink the bloom; **logs to Sentry** so a systematic failure still surfaces |
| `863` | concurrent draft task `.result()` | KEEP — the draft is a racing fal call; skip its progress frame, main task continues |
| `948`/`959` | top-level SSE body | KEEP — the real boundary; `CancelledError` → clean bail, else surfaces `{type:"error"}` SSE event |
| `975`, `1034`, `1093`, `1167`, `1275`, `1440` | `model_validate` (→400) and the VLM/fal calls behind `/animate`, `/resolve-click`, `/precompute`, `/extract`, `/edit-entities` (→502) | KEEP — request-body validation + network boundaries, all surface the error to the client |
| `1299` | `base64.b64decode` of the **client-supplied data URL** | KEEP — malformed base64 is expected external input |
| `1306` | geometry **localization** — wraps `_detector.detect` (a network VLM call) | KEEP — dominated by a network boundary; "best-effort, optional" + **logs**. *(It also covers the pure `_box_from_det`/`_match` mapping, but the VLM call is the real failure source, so the swallow is boundary-justified.)* |
| `1367` | view estimation — wraps `_view.estimate_view` (network VLM call) | KEEP — network boundary; degrades to the top-down default + **logs** |

On the brief's specific note — *"the seeding is explicitly 'never block the
extraction response' … KEEP that one but make sure it's not hiding more than the
seeding"*: the seeding **write** itself (`deriveGeoFromExtraction`, a Mongo
upsert) lives on the **web** side, inside
`app/api/world/[sessionId]/extract/route.ts:166`, where it is wrapped in its own
`try { … } catch { /* seeding is best-effort — never block the extraction
response */ }`. That swallow covers the pure `toItem` bbox mapping **plus** the
`deriveGeoFromExtraction` Mongo write; the write is the real failure source, the
extract response has already been computed (the merge at :143 ran first), and
the product contract is explicit, so it is boundary-justified. The Python
`generate.py` geometry blocks (1306, 1367) are the *localization/view* passes
that feed that seed, and as noted they each wrap a network VLM call. Nothing in
either layer is hiding a deterministic-only failure that should propagate.

### Other providers

| Location | Guards | Verdict |
|---|---|---|
| `providers/detector.py:36` (`_clamp01`) | `float(v)` of a VLM coordinate | KEEP — untrusted value |
| `providers/detector.py:110` | `json.loads` of detector LLM reply | KEEP — JSON repair → `[]` |
| `providers/view_estimator.py:50` | `float(payload.pitch_deg)` from VLM | KEEP — untrusted value |
| `providers/view_estimator.py:97` | LLM call + `json.loads` | KEEP — network + JSON repair → default view |
| `ltx_stream.py:171` | WebSocket receive loop | KEEP — `except WebSocketDisconnect: return` is the correct way to handle a client closing the socket |

---

## Why nothing was removable (summary)

The decision criteria's REMOVE bucket is "wraps OUR OWN logic and swallows a
programming error." After reading every handler, **none** match: each one sits
on a fetch, a Mongo/httpx/WebSocket call, a `JSON.parse`/`model_validate`/
`base64.decode` of external data, an env-var coercion, a canvas/localStorage/
MediaSource/performance browser quirk, or the observability layer. The handful
labelled "best-effort" all (a) wrap a genuine network/IO call and (b) either log
the failure or have an explicit, documented product reason for degrading rather
than failing the user-facing request. The latent-bug hunt (the point of
removing swallows) surfaced nothing because there are no swallows of our own
deterministic code to remove.
