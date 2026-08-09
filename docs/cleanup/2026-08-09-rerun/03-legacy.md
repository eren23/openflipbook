# Concern-03 (legacy / deprecated / fallback paths) — rerun 2026-08-09

Delta audited: `83e3262..HEAD` (174 commits, 325 files, +31,209/−5,961) on
`chore/cleanup-rerun-2026-08-09` @ e75e3b1. Standard: `docs/cleanup/03-legacy.md`
removal bar — **no doc surface AND no test surface AND no live call surface, all
three proven → safe-auto**; flag+test reaching a branch = NOT dead (report-only
at most); generate.py toggles report-only regardless (Jun-13 hard rules).

Method: keyword sweep of delta added lines (56 hits, all classified); deleted-token
orphan sweep (every ALL_CAPS token deleted by the delta checked for surviving
doc/code surface — 0 orphans); reverse-orphan sweep of `.env.example` ×2 +
`docker-compose{,.demo}.yml` env keys vs code; deleted-file dangling-reference
check; export-vs-caller enumeration on the register-touched web libs; targeted
verification of the charter's named sites.

---

## SAFE-AUTO findings (2)

### F1. knip.json:20 — two entry files deleted by the delta

- **file:line**: `/Users/eren/Documents/AI/openflipbook/knip.json:20`
- **claim**: the `scripts/record-demo` workspace entry array
  `["record.ts", "record-geo.ts", "record-geo-nav.ts", "record-mappan.ts"]`
  references `record-geo-nav.ts` and `record-mappan.ts`, both **deleted in this
  delta** (`git diff 83e3262..HEAD --diff-filter=D` lists
  `scripts/record-demo/{record-ankh,record-fresh-nav,record-geo-nav,record-mappan}.ts`;
  the #174 repo-clear era). Current dir contents:
  `record.ts`, `record-geo.ts`, `record-features.ts`.
- **evidence (triple surface)**: doc surface = **only knip.json itself** (README.md:16,
  docs/ARCHITECTURE.md:16, package.json:40 reference the *directory* or `record.ts`,
  both alive); test surface = **none**; live call surface = **files do not exist**.
  knip is a manual devDependency (`apps/web/package.json:55`, no script wires it in
  package.json/ci.yml/Makefile) — the stale entries mis-scan any manual knip run,
  i.e. this campaign's own concern-01 tooling.
- **confidence**: high.
- **verdict**: **safe-auto** — drop the two dead entries. Adjacent (coordinate with
  concern-01, knip config is its tooling): `record-features.ts` (the #168
  feature-study recorder) exists but is **unlisted** — with `"project": ["*.ts"]`
  a knip run would false-flag it; add it in the same edit.
- **re-verify fast**: `ls scripts/record-demo/*.ts` vs the knip.json:20 array.

### F2. GEOMETRIC_WORLD_AUDIT.md (root) — dated audit snapshot, archive per #174 precedent

- **file:line**: `/Users/eren/Documents/AI/openflipbook/GEOMETRIC_WORLD_AUDIT.md` (whole file, 17,015 B)
- **claim**: point-in-time audit doc, truly dated: content frozen since
  **2026-06-08** (`git log -1` → ba2ce8a 2026-06-08; zero commits since);
  self-marks sections historical ("_Update 2026-06-08 … The §2 status table is
  historical_"); line 215 cites `scripts/record-demo/artifacts-geo/ + artifacts-mappan/`
  — dirs purged in the #174 repo-clear. Repo precedent #174 moved dated docs to
  `docs/archive/` (`DEMO_ANKH_2026-06-14.md`, `ENTER_RELIABILITY_2026-06-15.md`).
- **evidence (surfaces)**: inbound references = 3 **bare-name backtick citations**,
  none markdown links, so a move breaks nothing mechanically:
  `docs/SESSION_AUDIT.md:4`, `docs/PLAN_SCALE_NAV.md:27` (cites §4b/§6.5 as the
  "honest constraint"), `docs/PLAN_PLACE_TO_WORLD.md:4` (+ `:501` contextual
  "audit §4b"). Not referenced by README/code/CI. The live "§4" numbering in the
  recon bench / world-geometry.ts is program-internal (recon Step numbering), not
  a link into this file.
- **confidence**: high.
- **verdict**: **safe-auto** — `git mv GEOMETRIC_WORLD_AUDIT.md docs/archive/GEOMETRIC_WORLD_AUDIT.md`
  (keep the filename so bare-name greps still resolve; the two existing archive
  files carry dates in-name from birth — no rename needed). Update the 3 citation
  paths in the same commit for findability. Move, not delete: it is cited as the
  lineage source of the "geometry is relative, not metric" constraint.
- **re-verify fast**: `git log -1 --format=%ad -- GEOMETRIC_WORLD_AUDIT.md` +
  `grep -rn "GEOMETRIC_WORLD_AUDIT" docs/ README.md`.

---

## Charter known-facts — verified, orphan-free (no action)

### V1. POSE_REGISTER_FIX / bare TAP_ENTER_DIRECT — 0 hits confirmed

- **claim**: `POSE_REGISTER_FIX` = **0 hits** repo-wide (py/ts/tsx/yml/md/.example,
  node_modules/.next excluded). Bare backend `TAP_ENTER_DIRECT` = **0 hits**.
  All 7 surviving `TAP_ENTER_DIRECT` matches are the **prefixed**
  `NEXT_PUBLIC_TAP_ENTER_DIRECT` — a live documented web flag
  (`.env.example:215`, `apps/web/app/play/page.tsx:175-176,2645,2696`,
  comments in `click-route.ts:186`, `scene-closeup.ts:32`) = binding KEEP class,
  distinct from the removed backend token. | **confidence**: high | **verdict**: verified.

### V2. §4 backend register detour (#203, removed by #207/4ae42dd) — zero leftovers

- `apps/modal-backend/providers/register.py` — trimmed to `Alignment` /
  `fit_alignment` / `_fit_is_healthy`; docstring correctly points at the live
  web-side register. **Live consumers**: `tests/recon_bench/_align.py:15`,
  `tests/recon_bench/test_recon.py:12,193-194` (the bench's shared source of
  truth — exactly what the #207 commit said would stay). KEEP.
- `prior_entities` / `PriorEntity` (`generate.py:1377,1397,1452,1481`) — **live,
  not an orphan**: #207 removed only the unused `x_pct/y_pct`; the field feeds
  the extraction prompt (`providers/llm/extraction.py:69-90`), is sent by
  `apps/web/app/api/world/[sessionId]/extract/route.ts:144`, typed at
  `packages/config/src/index.ts:825`. KEEP.
- Telemetry (#206/04e1bb9) is **web-side only**: `extract/route.ts:313`
  (`gate_healthy`) + the `console.warn("[world.register] unhealthy fit applied")`
  shadow signal. Backend grep for `gate_healthy|pose_register|register_telemetry`
  = 0 stubs. `gate_healthy` currently has no client-side reader (rides the raw
  extract response; the warn is the signal) — 1-day-old deliberate decision
  telemetry for the WORLD_REGISTER_GATE flip, **not** legacy. KEEP.
- Removed tests (`test_extract_register.py`, `test_register.py`) left no orphaned
  conftest fixtures (only an unrelated "indoor register" comment at conftest.py:75).
- **Deleted-token sweep**: every ALL_CAPS token deleted anywhere in the delta was
  checked for surviving doc-surface-without-code-surface — **0 doc orphans**.
- **confidence**: high | **verdict**: clean.

---

## KEEP verdicts (verified live-by-design; binding or precedent classes)

| file:line | path | evidence | verdict |
|---|---|---|---|
| `providers/generate_modes/tap.py:465-471` | "legacy exterior→interior preamble … legacy clause only fires when the grammar stayed silent" | multi-way dispatch: camera clause vs WORLD_TOPDOWN_MAPS lever vs grammar; all arms reachable (grammar-silent → legacy arm) | KEEP (charter-binding, verified) |
| `providers/generate_modes/tap.py:807-819` | "Legacy (no deliberate view) enters keep the one-shot path" | `view_loop = enter_view is not None and env_flag("VIEW_LOOP","true") and body.verify is not False` — flag-gated dual arm, no-view arm is the live default for legacy enters | KEEP (charter-binding, verified) |
| `providers/prompt_library/instructions.py:38,80` | `_legacy_zoom_instruction` / `_legacy_enter_instruction` | called at `:751,755,812`; byte-identity asserted by `tests/test_generate_view.py:121-123` — the Jun-13 KEEP reaffirmed, call sites moved but intact | KEEP |
| VIEW_LOOP_PREVIEW (#208/#209) | pre-judge preview | full triple surface: `.env.example` ×2, `tap.py` ×5, `render_loop.py:108-241` (`emit_preview`, attempt-0 `preview=True`), `test_render_loop.py` + `test_zoom_preview.py`; web consumes ("Draft preview…" `page.tsx:962`) | KEEP (binding) |
| `providers/model_router.py:130-141` | steep-enter router (#172) | `STEEP_ENTER_DEFAULT = nano-banana-pro/edit` + `FAL_ENTER_MODEL_STEEP` escape hatch; **no dead gpt pin constant left** | KEEP (binding) |
| `apps/web/lib/world-map.ts:598` + `world-geometry.ts:442-` | WORLD_REGISTER_GATE gated register (#204/#205) | opt-in gate; legacy arm (apply any fit) IS the default until the #206 telemetry justifies the flip; `fitSimilarity`/`isFitHealthy`/`REGISTER_MIN_SCALE` all have non-test callers + 10+ tests | KEEP (binding) |
| `providers/register.py` ↔ `world-geometry.ts:492` | Python/TS twin of the fit math | deliberate twin, documented in both docstrings ("this Python twin stays the bench's source of truth") — not a superseded duplicate | KEEP |
| 56 delta keyword hits (all classified) | "legacy bytes" prompt-contract prose, `packages/config/src/index.ts:120,151,725,732` additive-wire comments, PrefetchEntry legacy-entry tolerance, session claim-on-first-write (`legacy (unowned) session`), OpenRouter legacy `citations` shape (now in `llm/client.py`, prior explicit KEEP), `llm/world.py:82` optional-param back-compat contract, test prose | zero dual dead paths among them; wire-type tolerance is back-compat policy (binding) | KEEP |

## Non-findings (checked, recorded to save the next run the trip)

- `apps/web/.next/standalone/**` contains a stale copy of the **pre-#124 monolith**
  (`providers/llm.py`) — untracked build output (`git ls-files apps/web/.next` = 0).
  Exclude `.next/` from greps; not repo content.
- Root `providers/llm` (an "additional working directory" in the session env) does
  **not exist** — stale session config, nothing to clean. The dissolved
  `apps/modal-backend/providers/llm.py` → `llm/` package left zero stale imports
  (all `from providers import llm` resolve to the package).
- `MINIO_ROOT_USER/PASSWORD`, `HOSTNAME` — compose-only env keys consumed by the
  minio image / `mc` bootstrap / Node runtime inside `docker-compose.yml:57-79`;
  not app-code orphans.
- `apps/web/e2e/style-pin.spec.ts:19` `test.skip(true, …)` — **conditional**
  env-capability skip inside try/catch (Mongo/R2 unreachable), not a dead test.
  11 e2e specs, 0 deleted, no unconditional skips.
- `world-geometry.ts:370` `resolveAbsoluteFrame` nontest-external:0 — internally
  live (`:357` via `resolveAbsolutePos`, `:412` via `toAbsoluteEntities`); export
  is test-surface. Not superseded.
- `providers/mock.py:149` `_MOCK_CLIP_B64` — live embedded mock mp4, not a lever.
- CI: single `ci.yml`, delta +62/−5 all additive (ratchet + e2e-mock upgrade);
  no disabled/superseded jobs (`if: false|skip|continue-on-error` = 0).
- Makefile → referenced script/test paths: all exist.

## Report-only (1, cross-concern)

- `scripts/record-demo/record-geo.ts:84` — comment cites the **deleted** sibling
  `record-ankh` ("networkidle never fires (the record-ankh …)"). Historical
  gotcha-explanation prose; harmless; concern-8's remit if anyone cares.

---

## Draft verdict-table row (Jun-13 style)

| # | Concern | Verdict | Action |
|---|---------|---------|--------|
| 3 | Legacy / fallback | 2 safe-auto, 1 report-only, rest KEEP | knip.json:20 — drop 2 entries deleted by the repo-clear (`record-geo-nav.ts`, `record-mappan.ts`; add unlisted `record-features.ts`, coord w/ #1). `GEOMETRIC_WORLD_AUDIT.md` → `docs/archive/` (frozen 2026-06-08, self-marked historical, cites purged artifact dirs; 3 bare-name citations, none links — update paths in-commit; #174 precedent). §4 detour removal (#203/#207) verified orphan-free: `POSE_REGISTER_FIX` + bare `TAP_ENTER_DIRECT` 0 hits (`NEXT_PUBLIC_TAP_ENTER_DIRECT` is a distinct live flag); `register.py` = bench-live; `prior_entities` live; #206 telemetry web-side only; deleted-token sweep 0 doc orphans. tap.py:467/:814 legacy arms, `_legacy_*` builders (called :751/:755/:812 + byte-identity test), VIEW_LOOP_PREVIEW (full triple surface), WORLD_REGISTER_GATE dual arm, steep-enter router — all KEEP (flag+test live, binding). |
