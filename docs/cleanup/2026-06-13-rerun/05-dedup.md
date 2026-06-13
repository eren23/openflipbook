# Cleanup re-run — 2026-06-13 · Concern #1 DRY/dedup (delta over `beedb82`)

Scope: ONLY the ~7.8k TS + ~14k Python lines added since `beedb82` (the
closeup/ladder/POV-surroundings program, PRs #64–#87). Standard = the prior
`docs/cleanup/05-dedup.md` (extracted `optimisticReplace`/`envFlag`/`modalUrl`;
`_frame_dims`/`_err_json`/`_gate_json`) + the 2026-06-09 re-run (which added
`_FRAME_DIMS` and the err/gate envelopes). Prior KEEP decisions are the default.

## Critical assessment

The new code is, again, strongly DRY — and conspicuously so where it matters.
The largest new Python subsystems already share their seams by construction:
`generate.py` routes every SSE frame through one `_sse()` helper and gates spend
/ rate-limit through `_rate_limited()` + `cap_exceeded()`; `judge.py`'s eight
score functions all funnel through one `_ask_judge`/`_parse_judgement`/`_image_block`;
the `prompt_library/*` modules are tables-of-prose + one assembler each;
`inpaint.py` reuses `image.py`'s fal plumbing rather than re-rolling it; and the
proxy `/api/*` routes only gained `...modalAuthHeaders()` (itself a shared helper)
on top of the already-KEEP'd modal-dispatch shape. The candidate clusters the
brief named — JSON-parse-400, Mongo env-guard-503, `if(!res.ok)`, the modal
dispatch, demo BASE_URL defaults — are all either pre-existing-and-settled-KEEP,
trivial 2-line guards that read clearer inline, or already factored. The one
*genuine* new duplication is the `edit_loop.py` ↔ `render_loop.py` sibling pair
(byte-identical `_score` + `_f`, parallel `conclude`/`iter_*` skeletons) — but it
is the paid render/edit path, so it is REPORT-ONLY by the bar, not an AUTO fix.
Net: no AUTO change is warranted; one REPORT-ONLY consolidation worth recording.

## Findings

| Sev | Tag | file:line | Issue | Recommended change | Conflicts |
|-----|-----|-----------|-------|--------------------|-----------|
| Med | REPORT-ONLY | `providers/edit_loop.py:123` ↔ `providers/render_loop.py:117` (`_score`); `edit_loop.py:55` ↔ `render_loop.py:64` (`_f`); plus parallel `conclude`/`conclude_edit` + `iter_attempts`/`iter_edit_attempts` skeletons | `edit_loop` is documented as "the render loop's sibling (same DI shape, keep-best, degrade-on-judge-failure rules)" and already imports `MAX_ATTEMPTS_CAP, Rendered, judge_concurrently` from `render_loop` — yet redefines `_score` **byte-identically** and re-rolls the same `_f` env-float parser, the same first-accepted-then-strict-tuple-improve `conclude`, and the same attempt-loop spine (abort → attempt-0-propagates / retry-quiet-fail → `judge_concurrently` → budget-stop → fold-feedback). The axis arity genuinely differs (edit: outside/alignment/medium; view: conformance/same_place/detail/medium). | REPORT-ONLY: both loops are called from `generate.py`'s paid render/edit flow (`generate.py:950/1056/2010`). Safe slice: also import `_score` from `render_loop` (delete the duplicate) and lift the `_f` parser to a shared `_loop_config_float(name, default)`. The `conclude`/`iter_*` skeletons should be left as parallel siblings — unifying them needs a generic over the axis set and would obscure each loop's accept rule. Verify under `make eval` + the edit/view benches before any change. | — |
| Low | REPORT-ONLY (KEEP-leaning) | `providers/segmenter.py:37` `_clamp01` (NEW) ≡ `providers/detector.py:35` `_clamp01` (OLD) | Byte-identical 6-line untrusted-VLM-coordinate clamp (`try float(); except → 0.0; max(0,min(1))`) now in both VLM-output parsers. | KEEP, per priors. Only 2 copies of a trivial coercion; no appropriate shared home (the prior 05-dedup explicitly ruled `_common.py` "provider-IO-specific" and declined to create a generic math/util module — that's why `env_flag` went to `_env.py`); and it's a fail-loud guard the defensive concern wants kept local. If ever consolidated, it lands next to `detector`/`segmenter` parsing, not in `_common.py`. | **07-defensive** KEEP on `providers/detector.py:36 _clamp01` ("untrusted value"). |

## Verified-and-KEEP (candidate clusters that are NOT new duplication)

- **Modal-dispatch across `app/api/*` proxy routes** (`animate`, `resolve-click`,
  `status`, `trace/recent`, `trace/abort-stats`, `precompute-candidates`,
  `models`) — all PRE-EXISTING at `beedb82`; the only change since is adding
  `...modalAuthHeaders()` (the SHARED_TOKEN gate), which is itself already a
  shared helper. The dispatch shape was the prior **05-dedup §3** documented
  KEEP (POST-abort vs GET-timeout sub-variants would need 4-5 flags to merge).
  No new evidence to overturn it.
- **Mongo env-guard-503** (`if (!env.MONGODB_URI || !env.MONGODB_DB) → 503`):
  pre-existing in 12 route files and KEPT by both prior runs; the 4 new files
  (`gallery/publish`, `session/events`, `session/presence`, `export/[nodeId]`)
  add the same ~5-line guard. Adding more copies of an already-settled trivial
  guard is not new logic; the guard also varies (`{ok:false,…}` vs `{error:…}`,
  different messages). `requireMongo` in `lib/env.ts` exists but THROWS
  (`EnvMissingError`) for `db.ts`'s internal use — a different shape from the
  route-level early-return-Response. KEEP.
- **`invalid JSON` 400** (5 sites: `gallery/publish`, `plan-world`, `extract`,
  `entity`, `edit-entities`): the 2-line `try { await req.json() } catch { 400 }`.
  Trivial, reads clearer inline; the bodies/types differ per route. KEEP.
- **`MODAL_API_URL not set` 503** (12 sites): pre-existing pattern, varies
  (`{error}` vs `{ok:false,error}`). KEEP, consistent with §3.
- **TS clamp helpers** — NEW `edit-mask.ts:16 clamp01(n)` (NaN→0) is identical
  to the PRIVATE `image-click.ts:89 clamp01`; NEW `geo-tap.ts:396 clamp01(v)`
  (no NaN guard) and `map-labels.ts:43 clamp01(v, span)` (different 2-arg
  semantics) diverge. The prior cleanup already left 4+ clamp variants
  (`image-click`, `image-condition` `clamp(v,lo,hi)`, `scale-tree` `clampScale`,
  `world-geometry` `clampFootprint`) un-consolidated; signatures + NaN handling
  differ, and a shared clamp util is a module the prior run deliberately avoided.
  KEEP (aligns with **07-defensive** KEEP on `_clamp01`).
- **TS compass/direction helpers** — `geo-tap.ts:68 cardinal(dx,dy)` (atan2 →
  8-wind), `geo-to-edit.ts:16 compassFor(dx,dy)` (drop-minor-axis → 1-2 word
  combo + "in place"), `location-phrase.ts:11 locationPhrase(geo,frame)` (3×3
  grid + span). Same superficial `(dx,dy)→string` shape, genuinely different
  algorithms/vocabularies for different callers; each exported + tested.
  Consolidating would force one grammar onto all and change behavior. KEEP.
- **Python `_f`/`max(0.0,float(env or 0.0))` env reads** — `spend.daily_cap()`
  ↔ `ratelimit.rpm()` share the `max(0.0, float(os.environ.get(NAME,"") or 0.0))`
  /`except ValueError` 1-liner (2×, different vars). Trivial. KEEP.
  (The loop-module `_f` is the Med finding above.)
- **`spend`/`ratelimit`/`breaker`/`moderation`** — deliberate tiny sibling
  modules sharing only a *posture* (in-process `threading.Lock` + `reset_for_tests`
  + "per-container, reset on restart"), not logic. Each module's locked state and
  reset differ. KEEP.
- **`feedback.py` trailing-period idiom** (`if not text.endswith("."): text+="."`,
  ~6×) — trivial 2-line idiom; the two feedback functions emit genuinely
  different prose. It feeds the paid render path (REPORT-ONLY territory anyway).
  KEEP.
- **Intentional TS↔Python mirrors** (REPORT-ONLY + deliberate, like the
  out-of-scope geometry engines): `heights.py:_TIER_METERS` ("Mirrors
  SCALE_TIER_METERS in packages/config … kept in sync by hand"); `camera.py`
  `compass_word`/`gaze_to_compass` ("same names and the same Math.round
  semantics as geo-tap.ts cardinal()"). Hand-synced contract mirrors. KEEP.
- **Demo-recorder `BASE_URL` default** (`process.env.DEMO_BASE_URL ?? "…:3000"`)
  — NEW `record-ankh.ts`/`record-fresh-nav.ts`/`record-mappan.ts` repeat the
  1-line default the pre-existing recorders already had (KEPT). They are
  standalone `pnpm tsx` scripts that don't import each other, use different env
  names (`DEMO_BASE_URL`/`LADDER_BASE`/`PERF_BASE_URL`) and defaults (`:3000`
  vs `:3137`). A shared const among throwaway scripts adds coupling, not
  clarity. KEEP.
- **`judge.py`, `pixel_diff.py`, `inpaint.py`, `geometry_checks.py`,
  `mock.py`, `prompt_library/camera.py`** — all single-responsibility and
  already-factored; `geometry_checks._num` (`float|None`, rejects bool/NaN) is a
  distinct helper from the clamps, not a dup. No action.

## Green gate (for any REPORT-ONLY work, if later taken)

- `make eval` (repo root) + the edit-region / view continuity benches for the
  loop-module item; the loops sit on the paid path, so neither item is AUTO.
