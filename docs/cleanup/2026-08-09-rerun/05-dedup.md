# Concern 05 — DEDUP / DRY — research (rerun 2026-08-09, delta 83e3262..HEAD, branch chore/cleanup-rerun-2026-08-09)

Standard: docs/cleanup/05-dedup.md + docs/cleanup/2026-06-13-rerun/05-dedup.md (+ 00 summaries,
07-defensive `_clamp01` KEEP). Charter: value/logic duplication within a language; DRY only where
the diff shrinks net complexity. Zero behavior change; gate = `make eval` (pytest not-paid, ruff,
mypy providers obs.py generate.py, vitest, tsc, madge).

Delta context: 325 files, +31k/-6k — interiors #161–166, tap=enter #167–173, coverage #174–186,
§4 pose-recovery #189–209. Also relevant: PR #99 ("ponytail-audit cuts — dead code, dup hooks,
shared clamp") created `apps/web/lib/clamp.ts` — it post-dates the Jun-13 KEEP on TS clamps and
changes that precedent's premise.

---

## Findings

### F1 — `data_url_from_bytes` duplicates `encode_data_url`, and has zero production callers

- **file:line**: `apps/modal-backend/providers/video.py:133` (`data_url_from_bytes`) ≡
  `apps/modal-backend/providers/image.py:418` (`encode_data_url`)
- **claim**: byte-identical body modulo parameter names (`base64.b64encode(b).decode("ascii")` →
  `f"data:{mime};base64,{b64}"`, same `"image/jpeg"` default). The video copy has **no callers
  anywhere in the repo** — not even inside video.py; its only references are its own tests
  (`tests/test_video.py:141-143`, added by the #178 zero-coverage sweep). `encode_data_url` has
  30+ callers (generate.py:751, all four generate_modes, 12+ bench/test runners, monkeypatch
  seams in tests/descent_bench).
- **evidence**: `grep -rn "encode_data_url\|data_url_from_bytes" --include="*.py" .` from
  apps/modal-backend → video.py:133 def + tests/test_video.py only, vs the 30+ encode_data_url
  sites. `git log -S data_url_from_bytes` → born in the initial commit, test added by #178
  (2a54a8d); never grew a caller. video.py already imports from `.image`
  (`from .image import _fal_subscribe`, video.py:24), so there was never an import barrier.
- **confidence**: high (byte-level + exhaustive caller grep).
- **verdict**: **safe-auto** — delete `data_url_from_bytes` (3 lines) + its test block
  (`tests/test_video.py:138-143`). Do NOT move `encode_data_url` to `_common.py` (the brief's
  suggested home): with the video copy dead there is nothing to consolidate INTO a shared home,
  and moving would churn 30+ call sites plus the descent_bench monkeypatch seam
  (`monkeypatch.setattr(image_provider, "encode_data_url", ...)`) for zero benefit.
  `image.encode_data_url` stays canonical where it is. (This finding straddles concern 01
  unused-code; the dedup framing is "the duplicate is the dead one".)
- **re-verify**: `grep -rn "data_url_from_bytes" apps/modal-backend --include="*.py"` → must show
  only the def + test before, nothing after; then `pytest apps/modal-backend/tests/test_video.py`
  + `make eval`. Coverage floor: removes 3 covered lines + their test — neutral.

### F2 — two leftover private `clamp(v, lo, hi)` copies in components; lib/clamp.ts is the declared home

- **file:line**: `apps/web/components/world-map.tsx:388-392` and
  `apps/web/components/atlas-view.tsx:872-876`; home = `apps/web/lib/clamp.ts:5`
- **claim**: the two component-private `clamp` functions are byte-identical to each other and
  semantics-identical (incl. NaN passthrough: all comparisons false → return v) to
  `lib/clamp.ts` `clamp` (ternary vs if/return spelling only). Each is called exactly once
  (world-map.tsx:129, atlas-view.tsx:303 — the same `clamp(cam.zoom * factor, MIN_ZOOM,
  MAX_ZOOM)` line). PR #99 created lib/clamp.ts as the shared home and consolidated the six
  lib copies (its header comment names image-click, edit-mask, image-condition, scale-tree,
  world-geometry, geo-tap); the two component copies were left behind.
- **evidence**: side-by-side read of both function bodies + lib/clamp.ts; `grep -rn "function
  clamp\|const clamp" apps/web` → only these two non-lib copies of the 3-arg form remain.
  Neither file was touched in the delta (`git log 83e3262..HEAD -- components/world-map.tsx
  components/atlas-view.tsx` → empty), so these are #99 leftovers, not new drift.
- **precedent check**: Jun-13 05-dedup KEPT the TS clamp family because "a shared clamp util is
  a module the prior run deliberately avoided". That premise is gone: #99 created the module and
  its header declares it the consolidation point. Evidence changed → KEEP does not bind here.
  map-labels.ts:43 `clamp01(v, span)` (2-arg, different semantics) and
  ClickDetailPopover.tsx:117 `clampPitch` (domain wrapper) stay KEEP.
- **confidence**: high.
- **verdict**: **safe-auto** — in each file add `clamp` to an import from `"@/lib/clamp"`
  (both files already import from `@/lib/*`) and delete the private function. Net −10 lines,
  zero flags, byte-identical behavior.
- **re-verify**: `grep -n "function clamp" apps/web/components/world-map.tsx
  apps/web/components/atlas-view.tsx` → empty after; `pnpm vitest run` + `tsc`.

### F3 — 6× byte-equivalent "b64-encode off-thread + progress SSE frame" blocks in generate_modes

- **file:line**: `providers/generate_modes/tap.py:926-943` (enter preview, #208),
  `tap.py:952-966` (enter rejected-attempt stream), `tap.py:1031-1043` (zoom draft),
  `tap.py:1049-1057` (zoom preview, #209); `providers/generate_modes/edit.py:149-161` and
  `edit.py:251-263` (rejected edit / judged attempt streams).
- **claim**: all six repeat the same ~12-line block: `(await _asyncio.to_thread(base64.b64encode,
  <jpeg_bytes>)).decode("ascii")` then `yield _sse({"type": "progress", "frame_index": <i>,
  "jpeg_b64": <b64>}, trace_id)`. Payload keys identical in all six; only the bytes source and
  index vary. The off-thread rationale comment (1-3MB JPEG stalls the loop 5-15ms) lives at one
  site (tap.py:1026-1030) and is the why for all six. ~70 lines of boilerplate total. The two
  preview *mechanisms* (iterator `emit_preview` flag on the enter path vs `_race_preview` queue
  on the zoom path) are genuinely different and NOT the duplication — only the paint block is.
- **evidence**: `grep -rn "b64encode" providers/generate_modes/*.py` → exactly the six sites;
  read each block — payload dicts byte-equivalent.
- **proposed consolidation**: one helper, new tiny module
  `providers/generate_modes/_frames.py` (NOT `__init__.py` — it imports the mode modules, a
  helper there would cycle):
  `async def progress_frame(sse, jpeg_bytes, index, trace_id) -> bytes` (encode off-thread,
  return the sse-encoded progress frame); call sites become
  `yield await progress_frame(_sse, ..., trace_id)`. `_sse` is already DI-passed into every
  mode, so the helper takes it as an argument — no new coupling, no flags. Net ≈ −50 lines,
  one canonical frame shape.
- **confidence**: high on the duplication; the consolidation is mechanical and byte-output
  identical.
- **verdict**: **report-only** — these are the paid render/edit SSE paths (`stream_tap` /
  `stream_edit`), and the Jun-13 run's binding bar put loop-flow consolidation on this path at
  REPORT-ONLY (the `_score`/`_env_float` dedup landed only on explicit request, 843a653). Gates
  DO exist if taken: tests/test_zoom_preview.py, test_generate_view.py, test_generate_enter.py,
  test_edit_loop.py assert the frames; `make eval` green required.
- **re-verify**: `grep -rn "b64encode" apps/modal-backend/providers/generate_modes/*.py` → 6
  sites today; 1 (the helper) after.

### F4 — 3× hand-rolled SSE reader skeleton in web (page + two hooks)

- **file:line**: `apps/web/app/play/page.tsx:917-933`, `apps/web/hooks/useAscend.ts:47-66`
  (`readAscendReady`), `apps/web/hooks/useExpandBloom.ts:88-103`.
- **claim**: the ~13-line reader skeleton is byte-equivalent in all three:
  `body.getReader()` → `TextDecoder` → `buffer += decode(value, {stream:true})` →
  `chunks = buffer.split("\n\n")` → `buffer = chunks.pop() ?? ""` → per chunk `trim()` →
  `startsWith("data:")` → `slice(5).trim()` → `JSON.parse`. Only the per-event dispatch and the
  abort-check position differ (useAscend checks `signal.aborted` BEFORE parse; useExpandBloom
  AFTER parse). lib/ltxf-parser.ts uses TextDecoder for the binary WS path — different animal,
  excluded. lib/stream-client.ts is the LTX WebSocket client, not an SSE home.
- **precedent check**: never ruled on — the original 05-dedup §3 KEEP covered the SERVER-side
  modal fetch/relay routes; no prior run assessed the client reader loops. Two of the three
  files were substantially reworked in the delta.
- **proposed consolidation**: new tiny `apps/web/lib/sse.ts` (the `env-flag.ts` /
  `optimistic-update.ts` precedent for tiny single-purpose lib modules):
  `export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string>`
  yielding the RAW `data:` payload strings. JSON.parse + dispatch + abort checks stay at each
  caller, which preserves each site's exact (abort × malformed-payload) ordering — the unified
  helper needs zero flags. No `reader.cancel()` in the helper (today's early returns don't
  cancel either; abort is owned by the callers' AbortControllers). Net ≈ −30 lines across three
  hot files, one canonical chunker.
- **evidence**: side-by-side reads of the three loops; `grep -rn 'split("\\n\\n")'` → exactly
  these three prod sites (+ test fixtures).
- **gates**: hooks are directly fixture-tested (useAscend.test.tsx builds a fake SSE
  `ReadableStream`; useExpandBloom.test.tsx likewise, 3 ReadableStream uses); the play-page loop
  is exercised by the REQUIRED e2e-mock Playwright suite (11 specs) on every PR, plus vitest.
- **confidence**: high on duplication; the yield-raw-string design keeps behavior byte-identical.
- **verdict**: **safe-auto** — mechanical, flag-free, per-caller semantics untouched, double
  gate (vitest fixtures + required e2e). Implementation order if cautious: hooks first, page
  last; but the same 6-line replacement applies to all three.
- **re-verify**: `grep -rn 'split("\\\\n\\\\n")' apps/web --include="*.ts" --include="*.tsx" |
  grep -v test` → 3 sites today, 1 (lib/sse.ts) after; `pnpm vitest run` + e2e-mock suite.

---

## Assessed and KEPT (fresh candidates that do not survive scrutiny)

### K1 — `_clamp01` detector/segmenter — KEEP (binding precedent, evidence unchanged)
`providers/detector.py:36` ≡ `providers/segmenter.py:169`, still byte-identical, still exactly
two copies. Prior rationale (Jun-13 05-dedup row 2 + 07-defensive.md:195 "KEEP — untrusted
value"): trivial coercion, no appropriate shared home, fail-loud guard the defensive concern
wants local. Nothing changed. Additional new evidence AGAINST consolidating onto
`coordinate_scale.coerce_unit`: the contracts differ — `coerce_unit` returns `None` on
non-numeric/NaN (and has percent-ladder semantics), `_clamp01` returns `0.0`; not a drop-in.
KEEP.

### K2 — clamp/coerce family (Python) — no shared helper; per-site KEEP
- `providers/layout_solver.py:95` `_clamp(v, lo, hi)` — the ONLY 3-arg clamp in the Python tree
  (grep `def _clamp` → 4 hits: this, the two `_clamp01`, `_clamp_zoom_factor`). No dup partner.
  KEEP.
- `providers/image_edit.py:362` `_clamp_zoom_factor` — semantic wrapper over named domain
  constants (`_ZOOMOUT_FACTOR_MIN/MAX`), not a generic clamp. KEEP.
- `providers/geometry_checks.py:45` `_num` — finite-float-or-None with bool rejection; distinct
  contract (Jun-13 already recorded "distinct helper from the clamps, not a dup"). Note:
  `providers/llm/world.py:228` `_is_number` looks similar but is a bool predicate WITHOUT the
  isfinite check — different semantics, not duplication (same class as the KEEP'd compass
  helpers). KEEP both.
- Inline `max(0.0, min(1.0, x))` — 4 standalone sites (view_estimator.py:93, llm/click.py:657,
  llm/extraction.py:303, llm/extraction.py:367): a one-line stdlib idiom on already-coerced
  floats; a helper adds a hop for zero lines saved. The one real repeat is INTRA-file:
  extraction.py's 4-line confidence coercion block appears twice (:300-303, :364-367,
  byte-identical) — a local `_confidence(entry)` would be net-zero lines (+1 symbol). Below the
  bar. KEEP.
- Verdict: the recorded preference for local copies stands; a shared clamp module for Python
  would be the config-flag helper the charter warns about.

### K3 — feedback.py critic-block idiom — KEEP-leaning report-only (precedent + paid path)
`providers/prompt_library/feedback.py` — 7 blocks (5 in `retry_feedback_clause` :36-97, 2 in
`edit_retry_feedback_clause` :113-133) repeat: lead-in + rationale → dot-terminate → fixed
corrective suffix → append. Jun-13 05-dedup recorded KEEP on exactly this trailing-period idiom
(then ~6×; the interiors program added the `interior_rationale` block, so now 7 — that is the
only evidence change). A `_critic_block(lead, rationale, follow_up="")` extraction would be
byte-output-identical (the conf block's conditional `register_reminder` composes as
`follow_up=... if reminder else ""`) and save ~10-15 lines — but the module is a
table-of-prose by design (the prompt_library pattern the Jun-13 run praised), the prose IS the
content, and it feeds the paid render path (REPORT-ONLY bar). Verdict: **report-only, low,
KEEP-leaning** — record, don't do, unless an 8th+ block family lands.

### K4 — mongo-configured predicate ×3 in delta libs — KEEP
`lib/idempotency.ts:28`, `lib/spend-ledger.ts:32`, `lib/session-owner.ts:39` — each wraps
`Boolean(process.env.MONGODB_URI && process.env.MONGODB_DB)` in a domain-named 3-line function
(`configured` / `ownershipStoreConfigured` with a why-docstring). One-line predicate; the
domain names carry meaning; `lib/env.ts.requireMongo` throws (different shape — same
distinction the Jun-13 run drew for the route guards). Consolidating saves ~0 lines. KEEP
(consistent with the Mongo env-guard-503 KEEP).

---

## Verified clean (delta areas swept, no duplication found)

- **§4 register**: `providers/register.py` is the single source; `tests/recon_bench/_align.py`
  IMPORTS `Alignment`/`fit_alignment`/the health gate from it (docstring documents the layering).
  The web `world-geometry.ts fitSimilarity` twin is the documented hand-synced cross-language
  mirror — out of scope by the campaign standard (register.py:15-17 says so explicitly).
- **llm package** (post-#124 dissolution; providers/llm.py confirmed gone): no function name is
  defined in two modules; `salvage_json` lives once (client.py); `click._coerce_unit`
  (click.py:371) is the documented alias over `coordinate_scale.coerce_unit` (imported
  :14 as `_coerce_scaled_unit`) — binding precedent intact.
- **edit_loop/render_loop**: still parallel siblings; edit_loop imports `_env_float` (+`_score`)
  from render_loop (edit_loop.py:39-42) — the 843a653 dedup held, no regression.
- **model_router.py**: single home for tier/model selection; image.py CALLS
  `model_router.fallback_chain` (image.py:389) rather than re-rolling it.
- **optimisticReplace**: every world/world-map write path added in the delta (incl. the new
  `removeEntityGeos`, world-map.ts:385) rides `lib/optimistic-update.ts`. The §1 extraction held.
- **usePersisted* hooks**: Locale/Theme/Tier all delegate to `usePersistedState` (#99's "dup
  hooks" cut). Clean.
- **e2e**: `e2e/helpers.ts` (waitForStableImage, clickAtImageFraction) is factored; no repeated
  multi-line setup blocks across the 11 specs (mock steering rides `/play?q=` by contract).
  Minor test-tree note: useAscend.test.tsx's `sseBody` fixture and useExpandBloom.test.tsx's
  inline stream builders overlap — test-tree, below the bar (prior runs left test-tree alone).
- **minimaps**: session-minimap.tsx bounds (min/max over laid page rects) vs WorldMiniMap.tsx
  framing (world-geo bounds +10% incl. origin) — same superficial min/max idiom, different data
  and semantics. Not dup.
- **click-route.ts / scene-closeup.ts / geo-tap.ts**: distinct exported domain functions; the
  delta's bbox math already imports `clamp01` from lib/clamp.ts. No repeated blocks.
- **`to_thread(image_provider.encode_data_url, ...)`** ×4 (expand.py:81/197, tap.py:1092,
  ascend.py:237): one-line idiom feeding different event types (neighbor/page/ascend_ready).
  KEEP.
- **prompt_library instructions/layout/policy**: tables-of-prose + one assembler each, per the
  established pattern. No action.

---

## Draft verdict-table rows (Jun-13 style)

| Sev | Tag | file:line | Issue | Recommended change | Conflicts |
|-----|-----|-----------|-------|--------------------|-----------|
| Low | SAFE-AUTO | `providers/video.py:133` ≡ `providers/image.py:418` | `data_url_from_bytes` byte-duplicates `encode_data_url` and has ZERO production callers — only its own #178-era test (`tests/test_video.py:138-143`); video.py already imports from `.image`, so the copy never had a reason | Delete the function + its test block; `encode_data_url` (30+ callers incl. monkeypatch seams) stays canonical in image.py — do not relocate to `_common.py` | — |
| Low | SAFE-AUTO | `components/world-map.tsx:388` ≡ `components/atlas-view.tsx:872` ≡ `lib/clamp.ts:5` | Two #99-leftover private `clamp(v,lo,hi)` copies (one call site each, both the identical zoom-clamp line); semantics incl. NaN passthrough match the shared `lib/clamp.ts` the same PR declared the home | `import { clamp } from "@/lib/clamp"` + delete both private defs (−10 lines) | Jun-13 TS-clamp KEEP predates #99's clamp.ts — its "no shared module" premise no longer holds |
| Med | SAFE-AUTO | `app/play/page.tsx:917` ≈ `hooks/useAscend.ts:47` ≈ `hooks/useExpandBloom.ts:88` | The ~13-line SSE reader skeleton (getReader → TextDecoder → `split("\n\n")` → `data:`-filter → parse) is byte-equivalent ×3; only dispatch + abort-check position differ | New `lib/sse.ts` async generator yielding RAW `data:` payload strings; JSON.parse/dispatch/abort stay per-caller (zero flags, per-site ordering preserved); gated by hook stream-fixture vitests + the required e2e-mock suite | Never ruled on — prior §3 KEEP covered the server-side proxy routes only |
| Med | REPORT-ONLY | `generate_modes/tap.py:928/954/1033/1052` + `generate_modes/edit.py:151/253` | 6 byte-equivalent "to_thread b64encode + `{"type":"progress","frame_index",jpeg_b64}` SSE" paint blocks (~70 boilerplate lines); the enter-vs-zoom preview MECHANISMS differ, the paint block does not | `async def progress_frame(sse, jpeg_bytes, index, trace_id)` in a new `generate_modes/_frames.py` (`__init__.py` would cycle); `_sse` stays DI-passed; ≈ −50 lines, byte-identical frames; verify test_zoom_preview/test_generate_view/enter + make eval | Paid render/edit flow — Jun-13 bar keeps this path REPORT-ONLY (the `_score` dedup landed only on request) |
| Low | REPORT-ONLY (KEEP-leaning) | `prompt_library/feedback.py:36-97,113-133` | Critic-block idiom now ×7 (interiors added 1 since the Jun-13 KEEP on the trailing-period idiom); `_critic_block(lead, rationale, follow_up)` would be byte-output-identical, ~−12 lines | Record only; table-of-prose module on the paid path — extract only if the block family keeps growing | Jun-13 05-dedup KEEP (trailing-period idiom) |
| — | KEEP | `detector.py:36` ≡ `segmenter.py:169` (`_clamp01`); clamp/coerce family; mongo-configured ×3 | Evidence unchanged (still exactly 2 `_clamp01` copies; `coerce_unit` is NOT a drop-in — None/NaN contract differs); layout_solver `_clamp` has no dup partner; extraction.py intra-file confidence block ×2 is net-zero to extract; 1-line domain-named env predicates | No change | Binding: Jun-13 05-dedup row 2 + 07-defensive.md:195 |

## Net assessment

The delta is again strongly DRY where it counts: the generate_modes split threads `_sse`/helpers
explicitly instead of copying them, the llm package dissolved without a single cross-module
duplicate, §4 register centralised its math and the bench imports it, and #99 pre-empted the TS
clamp/hook consolidation this run would otherwise have proposed. Genuine residue = two dead-ish
leftovers (F1, F2), one client-side chunker triplication (F4) — all safe-auto, ~−45 lines with
existing gates — and one paid-path boilerplate cluster (F3) worth ~−50 lines that stays
report-only by the campaign's own bar.

IMPLEMENTED @ 089f7d4 — F1 (data_url_from_bytes + test deleted, video.py's now-unused
`import base64` removed with it), F2 (both component clamps → lib/clamp.ts import), F4
(lib/sse.ts sseData generator + 4-case test; play/page.tsx, useAscend, useExpandBloom rewired,
per-caller parse/abort ordering preserved — `git diff -w` per file shows only the header collapse
+ one brace). Gates: make eval green; eslint 0 errors/17 warnings (unchanged); pnpm -r typecheck
green; vitest 100 files/832 tests, thresholds hold (all-files 77.6/87.03/81.26/77.6, sse.ts
100/91.66/100/100); backend pytest not-paid 1015 passed/2 skipped, coverage TOTAL 87% (86.82 ≥ 85);
web build green. e2e-mock SKIPPED: a live REAL-provider stack (fal+openrouter true, the user's
VIEW_LOOP_PREVIEW override run) occupies :3000 — a mock rebuild would destroy it and running
against it would bill real providers; relying on the campaign end-of-run e2e gate.
