# Cleanup #6 (defensive / fail-loud) — delta re-run 2026-06-13

Delta scope: `beedb82..HEAD` (157 commits, ~7.8k TS + ~14k Py — closeup / ladder /
POV / shared-sessions, PRs #64–#87). Standard = `docs/cleanup/07-defensive.md`
(prior verdict: **0 removals**, every handler guards a real boundary, fail-loud is
the house style). Prior reports/KEEPs treated as default.

## Assessment

The discipline held — again. **0 removals, 0 REPORT-ONLY findings, all KEEP.**
The new code is, if anything, *more* fail-loud than before: the entire new pure-logic
layer (TS: `edit-mask` / `entity-hit` / `geo-tap` / `scene-closeup` / `waterfall-segments`
/ `map-labels` / `export-build` / `cost-estimate` and 5 more; Py: `heights.py`,
`pixel_diff.py`, `geometry_checks.py`, `_common.py`, `geometry_prompt.py`, all of
`prompt_library/*`) has **zero** try/catch — errors propagate. The new render/edit
loops (`render_loop.py`, `edit_loop.py`) re-raise `CancelledError`/`BaseException`
explicitly, propagate attempt-0 render failures, and **log every degrade** with the
exception type; their keep-best degrade-on-judge-failure path is the loop's documented
design contract, not a swallow. Every handler I found sits on the same boundary classes
the prior run KEPT: network/IO (fetch/Mongo/S3/httpx/WebSocket/SSE), untrusted external
data (VLM/LLM JSON, base64 data URLs, env-var coercion, persisted localStorage), a
browser/runtime quirk (canvas taint, `video.play()`/`Image.decode()` autoplay, locale
`Date`), or observability isolation. No new catch in either language returns a
misleading success value; the error-hiding sweep (catches returning `ok:true`/`true`)
came back empty.

Only **2** genuinely-new `except` were added to the paid `llm.py` (the rest shifted
line numbers as functions moved); both are KEEP and report-only by rule anyway. The
new paid-path modules `judge.py` and `moderation.py` are fail-open-by-design with
documented rationale + logging — REPORT-ONLY territory, but unambiguously correct.

## Counts

| Bucket | TS | Python | Total |
|---|---|---|---|
| New handlers reviewed | ~22 (incl. arrow false-positives discarded) | ~30 | ~50 |
| AUTO removals | 0 | 0 | **0** |
| REPORT-ONLY (error-hiding) | 0 | 0 | **0** |
| KEEP | all | all | **all** |

## Findings — all KEEP

### TypeScript (`apps/web`)

| Sev | Verdict | File:line | Handler | Why it's justified |
|---|---|---|---|---|
| — | KEEP | `app/api/gallery/publish/route.ts:26` | body `JSON.parse` → 400 | untrusted request body |
| — | KEEP | `app/api/gallery/publish/route.ts:65` | `fetch`→Modal `/moderate-text` | documented fail-open (same posture as generate); a moderation-infra hiccup must not block a self-hoster's publish |
| — | KEEP | `app/api/models/route.ts:22` | `fetch`→Modal `/models` → 502 | network boundary |
| — | KEEP | `app/api/session/[sessionId]/events/route.ts:36,45,53,90` + `.catch` at 59,63,68 | SSE `controller.enqueue/close`, Mongo change-stream `watchSessionNodes`, `countPresence` | IO boundary; documented soft-degrade to `{type:"unsupported"}` on a standalone Mongo (no replica set); fire-and-forget presence pings |
| — | KEEP | `app/api/session/[sessionId]/presence/route.ts:29` | body `JSON.parse` → falls to 400 validation | untrusted body |
| — | KEEP | `hooks/useSharedSession.ts:79` (+`.catch` 56) | `JSON.parse` of an SSE feed frame | untrusted external data; malformed frame skipped |
| — | KEEP | `hooks/useSpeedPreset.ts:107` | `JSON.parse` of persisted `loopKnobs` localStorage | untrusted/hand-editable persisted state → default |
| — | KEEP | `hooks/useWorldMode.ts:65,74` | localStorage parse / write | untrusted persisted + private-mode quirk (mirrors prior `useStyleAnchor`) |
| — | KEEP | `components/PlayPage/SpeedPreset.tsx:63` (`.catch`) | `fetch` `/api/models` | network → `[]` |
| — | KEEP | `components/PlayPage/GeoEditPanel.tsx:71,86` | network via `onSubmit` (preview/apply) | sets `error` state for the user |
| — | KEEP | `lib/r2.ts:120,137` | S3 `GetObjectCommand` (`inlineStoredImage`/`getStoredBytes`) | documented best-effort IO; null → caller forwards original URL (the localhost-minio VLM-fetch workaround) |
| — | KEEP | `lib/image-condition.ts:171` | `cropRegionRect` → `canvas.toDataURL()` | cross-origin canvas-taint browser quirk (the documented region-crop drop) |
| — | KEEP | `lib/stream-client.ts:140` (+`.catch` 132) | `parseLTXF` of a binary WS frame + MSE append / `video.play()` | external binary data → `onError` (no retry); autoplay quirk |
| — | KEEP | `hooks/useImageMorph.ts:53` (`.catch(finish)`) | `Image().decode()` | decode-absence quirk; calls the same finish path (no-op, not a swallow) |
| — | KEEP | `components/atlas-view.tsx:889` (`fmt`) | `new Date(iso).toLocaleString()` | locale/format throw |
| — | KEEP | `app/play/page.tsx:193,226` (`persistNode`) | `fetch` `/api/nodes` + `JSON.parse` | network → null; caller tolerates a null save (prior pattern) |
| — | KEEP | `app/play/page.tsx:302` (`extractEntities`) | `fetch` `/api/extract` (Mongo merge) | documented best-effort; merge ran upstream, null → codex refetches |
| — | KEEP | `app/play/page.tsx:337` | localStorage write (`lastSession`) | private-mode quirk |
| — | KEEP | `app/play/page.tsx:1338` (`buildMaskPng`) | canvas mask pass → whole-image fallback | canvas-taint browser quirk |

*(Diff-grep also matched `page.tsx:592` and `:1161/1179` — these are arrow-function
`=>`/`e.preventDefault()` bodies, not catches. All other `page.tsx` catches predate
`beedb82` and were KEPT in the original run.)*

### Python (`apps/modal-backend`)

| Sev | Verdict | File:line | Handler | Why it's justified |
|---|---|---|---|---|
| — | KEEP | `providers/render_loop.py:67,72` | `float`/`int` of `VIEW_LOOP_*` env | env coercion → default (= obs.py:66 posture) |
| — | KEEP | `providers/render_loop.py:113` (`data_url_bytes`) | `base64.b64decode` of a data URL | untrusted external bytes → None |
| — | KEEP | `providers/render_loop.py:136-137` (`judge_concurrently`) | re-raises `BaseException` (CancelledError), collects only `Exception` | **fail-loud on cancellation** by design |
| — | KEEP | `providers/render_loop.py:192` | retry-render exception → log warn + keep-best; attempt-0 PROPAGATES | documented loop contract; logged, not hidden |
| — | KEEP | `providers/edit_loop.py:57,62` | env coercion | → default |
| — | KEEP | `providers/edit_loop.py:119` (`inside_crop_bytes`) | PIL decode of result image | untrusted image bytes → full-frame judge (documented) |
| — | KEEP | `providers/edit_loop.py:178` | retry-render exception | log warn + keep-best (attempt-0 propagates) |
| — | KEEP | `providers/edit_loop.py:196` | `changed_fraction` pixel-diff failure | log warn + stops loop (documented) |
| — | KEEP (report-only by rule) | `providers/judge.py:61` (`_parse_judgement`) | `json.loads` of VLM reply | untrusted model output; regex-score fallback is the repair ladder's point |
| — | KEEP (report-only by rule) | `providers/moderation.py:49` + `contextlib.suppress` 50 | LLM moderation call + the obs `log` inside it | **explicit fail-open** (module docstring); logs the degrade; suppress wraps only the logger |
| — | KEEP | `providers/segmenter.py:40,87` | `float()` of VLM coord/height | untrusted value → 0.0/None |
| — | KEEP | `providers/segmenter.py:151` | `json.loads` of VLM reply → `[]` | untrusted output ("tolerant parse… never raises") |
| — | KEEP | `providers/ratelimit.py:23` | `float(RATE_LIMIT_RPM)` | env coercion → off |
| — | KEEP | `providers/spend.py:98` | `float(MAX_DAILY_SPEND)` | env coercion → uncapped |
| — | KEEP (report-only by rule) | `providers/image.py:372` | PROVIDER_FALLBACK loop step | network boundary; records breaker + log warn + tries next; **`raise last_exc`** at L387 when exhausted |
| — | KEEP (report-only by rule) | `providers/image_edit.py:289` (`_dims_from_data_url`) | `base64.b64decode` | untrusted data URL → None (http URLs use caller dims) |
| — | KEEP | `providers/model_router.py:83` (`_tier_index`) | `.index()` on unknown tier → -1 | expected-input lookup tolerance |
| — | KEEP | `providers/view_estimator.py:80,85` | `float()` of VLM pitch/confidence | untrusted value → informative default |
| — | KEEP | `providers/view_estimator.py:148` (`estimate_view`) | VLM call + `json.loads` → `DEFAULT_VIEW` | network + untrusted output; documented seed-something degrade |
| — | KEEP | `providers/prompt_library/policy.py:237` | `float()` of VLM `pitch_deg` | untrusted value → default |
| — | KEEP (report-only by rule) | `providers/llm.py:290` (`_client` startup) | `obs` import + `log` on cold init | **observability must never block client init** (documented; = prior L246 posture) |
| — | KEEP (report-only by rule) | `providers/llm.py` `_safe_json` (new `except json.JSONDecodeError`) | now routes through `_coerce_json_dict` (list-wrapped reply) | **strengthens** the untrusted-JSON repair ladder |
| — | KEEP | `scripts/fetch_corpus.py:34` | urllib `HTTPError` 429-retry/backoff | network boundary; **re-raises** non-429 + on final attempt (dev corpus script) |
| — | KEEP | `scripts/verify-fal-models.py:68` | `urlopen`+`json.loads` per slug | dev-only probe script (not request path); reports + exits non-zero on failures |

`providers/geometry.py` added **no** new `except`. `heights.py`, `pixel_diff.py`,
`geometry_checks.py`, `_common.py`, `geometry_prompt.py`, `mock.py`, `breaker.py`,
and all `prompt_library/*` (besides the one VLM-coercion above) carry **zero**
try/except — pure fail-loud logic. `geometry_checks.py` is the explicit
"return-issues-NEVER-raise so the caller picks the posture (validators raise,
runtime logs)" design the brief flags as intended.

## Why nothing was removable (delta summary)

Same conclusion as the prior run, re-verified against the new surface: the REMOVE
bucket is "wraps OUR OWN deterministic logic and swallows a programming error." After
reading every new handler, **none** match. The new pure-logic core has no handlers at
all; the new loops re-raise cancellation and log every degrade; the paid-path catches
(llm/image/judge/moderation — report-only by the hard rules) each sit on an LLM/fal
SDK boundary or untrusted-JSON repair and are documented + logged + fail loud at the
end of the ladder. No AUTO removal qualifies (no existing unit test asserts any of
these should propagate — the loop tests in fact assert the *degrade* behaviour, e.g.
`test_render_loop.py` / `test_edit_loop.py`). No error-hiding to hand back to the user.
