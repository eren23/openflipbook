# Cleanup 1 — Unused code (knip + ruff F401)

Workstream 1 of the sequenced code-quality cleanup. Scope: **find and remove
genuinely unused code** only. Dedup, type-strengthening, defensive-code and
comment cleanups belong to other workstreams and were left untouched.

## Tooling added

- `knip@6.16.1` as a devDependency in `apps/web` (pnpm).
- `knip.json` at repo root, configured for the four TS workspaces:
  - `apps/web` — entries are the Next.js App Router special files
    (`app/**/{page,layout,route,loading,error,not-found,template,default,global-error}.tsx`),
    `next.config.*`, `tests/**`, `e2e/**`, and `**/*.test.tsx`. knip natively
    recognises `vitest.config.ts`, `playwright.config.ts`, `instrumentation*.ts`
    and `postcss.config.mjs` as entries, so they need no explicit listing.
  - `packages/config` — `includeEntryExports: false` so the public-API exports of
    `src/index.ts` are **never** reported as unused. This is the deliberate
    guardrail (see below): those types are mirrored by hand into Python Pydantic
    models in the Modal backend, a cross-language use knip cannot see.
  - `scripts/record-demo` and `scripts/perfbudget` — their `*.ts` recorder/runner
    entries.

## What the tools found

### Python — `ruff check . --select F401` (apps/modal-backend)

`All checks passed!` — **zero** unused imports. Nothing to remove on the backend.
(`providers/_common.py` is already `# noqa: F401` for intentional re-exports.)

### TypeScript — knip (repo root)

- **Unused files:** none. Every `.ts`/`.tsx` file is reachable.
- **Unused dependencies / devDependencies (2 — both FALSE POSITIVES, see below):**
  - `tsx` in `scripts/perfbudget/package.json`
  - `tailwindcss` in `apps/web/package.json`
- **Unlisted binaries (4 — all legitimate, see below):** `e2e`, `modal`,
  `playwright`, `tsx`.
- **Unused exports (8 reported):** `cropRegion`, `hasWSStreaming`,
  `PRESET_ANCHOR_PREFIX`, `applyGeoUpsert`, `recomputeBounds`, `applyEntityEdit`,
  `viewScale`, `scoreEntitiesForContinuity`.
- **Unused exported types (11 reported):** `ScrubberFrame`, `PrefetchPoint`,
  `PrefetchBBox`, `WorldStateView`, `ClickInParent`, `NodeSource`, `NodeDoc`,
  `ErrorDoc`, `ConditionRole`, `AbortStageRow`, `AbortEntry`.

## What I removed (high confidence)

| Item | File | Evidence |
|------|------|----------|
| `hasWSStreaming()` | `apps/web/lib/stream-client.ts` | `grep -rn "hasWSStreaming"` across `apps/web`, `apps/modal-backend`, `packages`, `scripts` (ts/tsx/py/mjs) returns **only its own definition**. Not in `app/play/page.tsx`'s import block from `@/lib/stream-client` (which imports the sibling `getWSUrl`, `startLTXStream`, and the two stream types — but not this). Zero references anywhere. |

That is the **only** genuinely-dead export in the tree.

## What I deliberately KEPT — and why

### packages/config — the entire public API (all 59 exports)

The critical guardrail. `packages/config/src/index.ts` exports 59 names. Many
exported **types** are consumed only by the hand-written Pydantic mirror in
`apps/modal-backend/generate.py` + `providers/llm.py` (and referenced by name in
Python comments), which knip cannot see. I audited **every** export with a
repo-wide grep across both TS and Python:

```
for n in <all 59 exported names>; do
  grep -rn "\b$n\b" apps/web apps/modal-backend scripts --include=*.ts --include=*.tsx --include=*.py | grep -v node_modules
done
```

**Result: all 59 have at least one external reference. Zero are dead.** Examples
that would have been false-positives under a naive run:

- `ProjectedEntity` → a Pydantic `class ProjectedEntity(BaseModel)` in
  `generate.py`, plus named in comments in `detector.py`, `geometry_prompt.py`,
  `grounding.py`.
- `EntityGeoEdit` → referenced **by name in a Python comment** in `providers/llm.py`
  ("Edit shapes mirror EntityGeoEdit in packages/config").
- `LTXFHeader` / `LTXF_MAGIC` → mirrored across `apps/web/lib/ltxf-parser.ts` and
  `apps/modal-backend/ltxf.py`.
- `GroundingSummary` → no direct by-name use outside config, but it is a field
  type inside the live wire interface `GenerateFinalEvent` (the SSE `final`
  event the web app consumes), so it is transitively load-bearing.

Feature-flag-gated geometry types (`SceneView`, `ObserverPose`, `WorldEntityGeo`,
`MapCrop`, `ViewLevel`, `ViewProjection`, `ViewEstimate`, `WorldMapSnapshot`,
`EntityEditPlan`, `EditEntities*`, …) are all live behind `GEOMETRIC_WORLD` /
`WORLD_GEOMETRY_GEN` / `VLM_GROUNDING` and were kept per the constraint not to
remove active feature-flag code.

### knip "unused exports" that are actually used in-file (7 kept)

knip's export-graph flags a declaration when **no other module imports it** — but
each of these is referenced *within its own file*, so it is live code, not dead
code. Demoting the `export` keyword would be an encapsulation change, not a
dead-code removal, and overlaps the types workstream, so I left them as-is:

| Symbol | File | Why it's live |
|--------|------|---------------|
| `cropRegion` | `lib/image-condition.ts` | called in-file at line ~111 by `buildConditionStack`. |
| `PRESET_ANCHOR_PREFIX` | `lib/styles.ts` | used in-file at lines ~90, ~94. |
| `viewScale` | `lib/world-overlay.ts` | used in-file at lines ~31, ~37. |
| `applyGeoUpsert`, `recomputeBounds`, `applyEntityEdit` | `lib/world-map.ts` | each used internally **and** re-exported via the `__test = { … }` object (lines ~403–405) that `lib/world-map.test.ts` destructures. The test reaches them through `__test`, so the named export reads as "unused" to knip. |
| `scoreEntitiesForContinuity` | `lib/world.ts` | used internally (~line 735) **and** re-exported via `__test` (~line 940), consumed by `lib/world.test.ts` + `lib/world-helpers.test.ts`. |

### knip "unused exported types" — all 11 are used in-file (kept)

Every one is referenced within its own module (as a field type, array element,
function parameter, or reducer state). None is dead; the `export` keyword is the
only thing knip considers redundant. Notable: the `lib/db.ts` types (`NodeDoc`,
`ErrorDoc`, `ClickInParent`, `NodeSource`) describe the MongoDB document shapes
and are used in-file as `db.collection<NodeDoc>(…)` generics + nested field types
— a deliberate, load-bearing schema surface. `ConditionRole` types the `roles`
array inside `image-condition.ts`. `WorldStateView` is the reducer state type in
`useWorldState.ts`. All kept.

### Dependencies / binaries — all false positives (kept)

- **`tailwindcss` (apps/web)** — load-bearing via CSS, which knip does not parse:
  `app/globals.css` has `@import "tailwindcss";` and `postcss.config.mjs` uses the
  `@tailwindcss/postcss` plugin (which resolves `tailwindcss`). Removing it breaks
  the build. KEPT.
- **`tsx` / `playwright` (scripts/perfbudget)** — used by the `"start": "tsx run.ts"`
  npm script + `playwright install chromium` postinstall + the `playwright` import
  in `run.ts`. knip reports them as both an "unlisted binary" and an "unused
  dependency" purely because it does not parse those package scripts. KEPT.
- **Unlisted binaries `e2e`, `modal`** — `e2e` is the `apps/web` npm script invoked
  from CI; `modal` is the Modal CLI used by the root `modal:serve`/`modal:deploy`
  scripts. Both legitimate. KEPT.

## Verification

- `apps/web`: `pnpm exec tsc --noEmit` ✅ ; `pnpm exec vitest run` ✅ (51 files,
  395 tests).
- Repo root `make eval` ✅ (pytest `-m "not paid"` + ruff + mypy(6 files) for the
  backend; vitest + `tsc --noEmit` for web).
- `cd apps/web && pnpm exec eslint . --max-warnings=20` ✅.

## Net change

- Removed 1 dead function (`hasWSStreaming`).
- Added `knip` devDep + `knip.json` (tooling for future runs).
- **No** dependency removals (all flags were false positives).
- **No** `packages/config` changes (public API, cross-language mirror — all 59
  exports proven live).
- **No** feature-flag code touched.
