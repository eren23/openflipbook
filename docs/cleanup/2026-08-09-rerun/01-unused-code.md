# Concern 01 — Unused code · rerun 2026-08-09 (delta 83e3262..e75e3b1, 174 commits, +31k/−6k)

Standard: docs/cleanup/01-unused-code.md + the Jun-9/Jun-13 rerun docs. Prior KEEPs treated
as default. Branch chore/cleanup-rerun-2026-08-09 @ e75e3b1. Research only — nothing modified.

## Tool output (fresh, this run)

- `ruff check . --select F401` (apps/modal-backend) → **All checks passed!** (0 unused imports).
- `cd apps/web && pnpm exec knip --config ../../knip.json` → 2 unused files (both known FPs:
  `public/theme-init.js`, `scripts/ladder-proof.mjs`), **9 unused exports**, **15 unused exported
  types**, 0 unused deps, 0 unlisted binaries. vs the Jun-13 roster the only NEW flags are
  `cropRegionRect` and `FirstRunCoachVariant` (both adjudicated KEEP below); `cropRegion` and
  `SessionNodeEvent` are gone (removed in the Jun-13 run). All other 22 flags are the prior-KEEP
  roster re-appearing verbatim (in-file-used exports, `__test`-bridge exports, Mongo
  collection-generic types) — spot-re-confirmed, still in-file used.

## Verdict counts

- **safe-auto: 1** (F-1, tool-config only)
- **report-only: 1** (F-2, coverage gap)
- **KEEP adjudications of new knip flags: 2** (F-3, F-4 — not dead, no action)
- **Dead code found in the delta: 0** — the discipline held for a fourth run.

## Findings

### F-1 · knip.json:20 — two entries point at files deleted in this delta

- **file:line**: `/Users/eren/Documents/AI/openflipbook/knip.json:20`
- **claim**: the `scripts/record-demo` workspace lists `"record-geo-nav.ts"` and
  `"record-mappan.ts"` as entries, but both files were deleted inside the delta (commit
  `6734140` "ponytail-audit cuts (#99)" removed 6 recorders: record-ankh-tour, record-ankh,
  record-fresh-nav, record-geo-nav, record-mappan, repro-502). knip silently tolerates the
  missing entries today. Meanwhile the surviving runnable `record-features.ts` (the
  feature-study harness, used for the #168 clip) is NOT an entry.
- **evidence**: `ls scripts/record-demo/*.ts` → only `record-features.ts`, `record-geo.ts`,
  `record.ts`. `git show 6734140 --stat -- scripts/record-demo` shows both deletions.
  `record-features.ts` is referenced by `scripts/record-demo/encode-studies.sh:2` and
  `scripts/record-demo/README.md:39,48,53` (runnable via `pnpm tsx record-features.ts`).
- **confidence**: high
- **verdict**: **safe-auto** — edit knip.json entry list to
  `["record.ts", "record-geo.ts", "record-features.ts"]` (drop the 2 deleted names, add the
  one real runnable — the exact symmetric of the Jun-9 precedent that ADDED record-mappan.ts
  as a concern-01 action, `66fec41`). Zero behavior change (tool config only).
  **Re-verify fast**: `ls scripts/record-demo/*.ts` (3 files) then re-run knip and diff
  against the output above — must stay: 2 unused files (the 2 known FPs), 9/15 exports/types.
  Note: the binding "known FP: record-mappan.ts" is moot — the FILE no longer exists; only
  the stale config string remains.

### F-2 · knip.json — `scripts/ux-bench` (new in delta) has no knip workspace

- **file:line**: `/Users/eren/Documents/AI/openflipbook/knip.json` (workspaces map) /
  `scripts/ux-bench/run.ts`
- **claim**: the new ux-bench harness is outside knip coverage entirely (and root
  package.json is not a workspace either), so future dead code there is invisible to the tool.
  Not dead itself: it is live and wired.
- **evidence**: `Makefile:249-253` (`ux-bench-dry` / `ux-bench` → `pnpm tsx
  scripts/ux-bench/run.ts`); all 5 `tasks/*.json` are readdir-loaded at `run.ts:102-105`;
  root package.json's new devDeps `tsx`/`playwright`/`@types/node` are consumed by it
  (`run.ts:11` imports playwright; Makefile invokes via `pnpm tsx`).
- **confidence**: high
- **verdict**: **report-only** — adding a workspace changes tool coverage and could surface
  new flags needing fresh adjudication; not a mechanical zero-reference removal. Suggested
  block: `"scripts/ux-bench": { "entry": ["run.ts"], "project": ["*.ts"] }`.

### F-3 · apps/web/lib/image-condition.ts:111 — `cropRegionRect` (new knip flag) = KEEP

- **claim**: knip flags it only because the Jun-13 run's concern-7 removed its dead wrapper
  `cropRegion` (`6064f48`), erasing the last cross-module import. It is alive.
- **evidence**: called in-file at `image-condition.ts:174` (inside the condition-stack
  builder); it is now the named cross-language mirror anchor —
  `apps/modal-backend/tests/continuity_bench/enter_runner.py:137` ("Pillow mirror of the
  client's region crop (cropBox + cropRegionRect)") and `docs/PLAN_EDITING.md:27`
  ("`cropRegionRect` (TS) / `crop_box` (py)").
- **confidence**: high
- **verdict**: report-only (KEEP; the `export` keyword is an encapsulation question for the
  types workstream, same class as the prior `viewScale`/`PRESET_ANCHOR_PREFIX` KEEPs).

### F-4 · apps/web/components/PlayPage/FirstRunCoach.tsx:5 — `FirstRunCoachVariant` = KEEP

- **claim**: new exported type flagged by knip; in-file used.
- **evidence**: types the `variant?:` prop at `FirstRunCoach.tsx:17`; the component itself is
  prod-imported by `app/play/page.tsx`. Same in-file-used-type class as `ConditionRole` et al.
- **confidence**: high
- **verdict**: report-only (KEEP, no action).

## Clean sweeps (zero findings — evidence kept so the implementer can re-verify fast)

1. **§4 register/pose area (#189–#209) — fully consumed, no orphans after the #203/#207
   detour removal.**
   - `providers/register.py` (binding KEEP) — every remaining symbol has a consumer:
     `Alignment`+`fit_alignment` ← `tests/recon_bench/test_recon.py:12`;
     `_RECOVERY_RESIDUAL_MAX`+`_fit_is_healthy` ← `test_recon.py:193-194`;
     `FRAME_W/FRAME_H/Point/_RECOVERY_MIN_SCALE/_fit_is_healthy/fit_alignment` ←
     `tests/recon_bench/_align.py:15-22`; `Alignment.apply` ← `_align.py:124`,
     `test_recon.py:60,67`; `Alignment.invert` ← `test_recon.py:67`;
     `_RECOVERY_MIN_MATCHED` used in-file (`register.py:118`).
   - Removed-symbol residue: `rg 'POSE_REGISTER_FIX|register_positions|_register_detection_centres|_pose_register_on'`
     over the whole repo (excl. docs/cleanup) → **zero hits**. .env.example clean.
   - Web-side live register: `fitSimilarity`/`isFitHealthy`/`applySimilarity`/`REGISTER_MIN_SCALE`
     imported by `lib/world-map.ts:22-32` and used at `:585-607`; `registerPlanToImage` ←
     `app/api/world/[sessionId]/extract/route.ts:7,298`. #206 telemetry is emitted
     (`planRegistration`/`gate_healthy`, extract route `:191,:305-313,:386`) — not orphaned.
2. **VIEW_LOOP_PREVIEW (#208/#209)** — `Attempt.preview` (`render_loop.py:111`) read at
   `generate_modes/tap.py:921,:943`; `emit_preview` (`render_loop.py:196`) passed at
   `tap.py:919`; `_race_preview` (`tap.py:65`) called at `tap.py:1049` + unit-tested
   (`tests/test_zoom_preview.py:13`). All live.
3. **Python delta def sweep** — extracted all 293 top-level defs from the delta's
   providers/generate.py files; repo-wide ref-count: the only ≤1-ref names are 6
   decorator-registered endpoints (`_shared_token_gate` @middleware `generate.py:75`,
   `fastapi_ingress` @asgi_app `:1851`, `moderate_text` @post `:1811`, `trace_recent` @get
   `:1822`, `trace_abort_stats` @get `:1836`, `plan_world_endpoint`) — each route also has a
   live web caller (`gallery/publish/route.ts:51` → /moderate-text; `admin/trace/page.tsx:34-35`
   → /trace/recent + /trace/abort-stats). A second pass excluding tests found **zero**
   prod-dead/test-only functions. No stubs (`NotImplementedError`/bare `pass`) in delta providers.
4. **Web delta components/hooks/libs — all prod-imported** (knip's tests-are-entries blind
   spot manually closed): BlankTapNudge, TapHint, EnterableMarkers, EntityHoverOverlay,
   FirstRunCoach, MapLabelOverlay, MorphImagePair, NeighbourTray, WorldMiniMap,
   GeometryOverlay, HelpOverlay, useAscend, useExpandBloom, useImageMorph,
   useKeyboardShortcuts, usePersistedLocale/State/Theme/Tier, useWander → every one imported
   by `app/play/page.tsx` or another prod module. Delta libs (clamp, coach, debug-access,
   edit-mask, geo-tap, morph-style, session-owner, spend-ledger, idempotency, ids,
   session-pages, click-route, scale-tree, world-mode, map-labels, waterfall-segments,
   trace, image-click, entity-hit) all have non-test importers. `mse-player` looked orphaned
   under the `@/lib/` glob but is imported relatively at `lib/stream-client.ts:7`. A
   per-export scan of delta files (export function/const/class with zero non-test external
   refs AND no in-file use) returned **zero candidates**.
5. **packages/config** — delta is +110/−55 on `src/index.ts` but `git diff | grep '^+export'`
   is EMPTY: no new exports, only field changes inside existing types. Cross-language surface
   unchanged; binding constraint untouched. New devDep `vitest` ← its first tests
   (`src/index.test.ts`) + `"test"` script. `world-geo-fixture.json` ← `tests/test_geo_schema.py`,
   `tests/test_geometry_checks.py`, `apps/web/lib/world-geo-schema.test.ts`.
6. **Bench/eval scaffolding (delta)** — all wired: matrix_bench `_cache`/`_record`/`report` ←
   runner.py:29-30,:353 + recon/scenario runners + tests; map_corpus `chains` ←
   `descent_bench/runner.py:38`; map_corpus draft/annotate/overlay + world_bench runners +
   descent/continuity/edit/recon/scenario runners ← Makefile:64-256 (every `-m tests.…`
   module exists on disk, checked); click_bench `leaderboard` ← `test_click_bench.py:23` +
   `docs/BYO-KEYS.md:147`. e2e specs are knip entries and playwright-collected.
7. **Deps** — knip: 0 unused. Root package.json adds (`tsx`, `playwright`, `@types/node`) are
   consumed by ux-bench (see F-2). `apps/web/package.json` dep set unchanged in the delta.

## Draft verdict-table row (Jun-13 00-summary.md style)

| # | Concern | Verdict | Action / commit |
|---|---------|---------|-----------------|
| 1 | Unused (knip + ruff F401) | **0 dead symbols** (4th run clean); 1 stale tool-config | Python F401 spotless; knip's only 2 new flags (`cropRegionRect`, `FirstRunCoachVariant`) are in-file-used = KEEP; §4 register area fully consumed post-#203/#207 removal (zero `POSE_REGISTER_FIX`/`register_positions` residue), VIEW_LOOP_PREVIEW symbols all live. safe-auto: knip.json record-demo entries — drop deleted `record-geo-nav.ts`/`record-mappan.ts` (gone in `6734140`), add the live `record-features.ts`. Report-only: add a `scripts/ux-bench` knip workspace (new, Makefile-wired, uncovered). |

## Re-verification recipe for the implementer (fast, HEAD may have moved)

1. `ls scripts/record-demo/*.ts` → expect exactly record.ts, record-geo.ts, record-features.ts.
2. Edit knip.json:20 entry array accordingly.
3. `cd apps/web && pnpm exec knip --config ../../knip.json` → output must match this run's
   (2 known-FP files / 9 exports / 15 types); any NEW flag = stop and re-adjudicate.
4. `cd apps/modal-backend && ruff check . --select F401` → All checks passed.
