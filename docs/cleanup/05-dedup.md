# Cleanup 5 — Deduplicate / DRY

Workstream 5 of the sequenced code-quality cleanup. Scope: extract genuine
duplication **only where it reduces complexity**. Behaviour-preserving — zero
runtime change. The intentionally-mirrored geometry engines
(`world-geometry.ts` ↔ `providers/geometry.py`) are explicitly out of scope.

## What was duplicated, what was extracted

### 1. Optimistic-concurrency read-modify-write retry loop  → EXTRACTED

The same skeleton appeared **three** times (the brief named two; a third lives
next to them):

- `apps/web/lib/world.ts` `mergeExtraction` (~L260-314)
- `apps/web/lib/world.ts` `mutate` (~L890-933) — powers every codex CRUD
  (pin/rename/delete/merge/set_appearance)
- `apps/web/lib/world-map.ts` `upsertEntityGeos` (~L256-301)
- `apps/web/lib/world-map.ts` `applyEntityEdits` (~L306-350) — the fourth copy

Every copy is byte-for-byte the same control flow:

```
attempt = 0
loop:
  existing = col.findOne({ _id })
  <build `next` doc from `existing` + a mutation>
  if existing:
    ok = (col.replaceOne({ _id, updated_at: existing.updated_at }, next)).matchedCount === 1
  else:
    try { col.insertOne(next); ok = true }
    catch (err) { if (!isDuplicateKeyError(err)) throw; ok = false }
  if ok: return <derive result from `next`>
  if ++attempt >= OPTIMISTIC_RETRY_LIMIT: throw "<label>: retry exhausted for <id>"
```

The only things that vary between copies:
- the doc **type** (`WorldStateDoc` vs `WorldMapDoc`) — make the helper generic
- the **load** of an empty seed when no doc exists (`[]` entities, etc.)
- the **mutation** that turns the loaded doc into `next`
- the **return shape** derived from the persisted `next`
- the error **label** in the "retry exhausted" message

**Extraction:** `apps/web/lib/optimistic-update.ts` exporting
`optimisticReplace(col, id, build, opts)`. `build(existing)` receives the
freshly-read doc (or `null`) and returns the full replacement doc; the helper
owns the read → replaceOne-on-`updated_at` / insertOne-with-dup-key-recovery →
retry loop and returns the persisted doc. Each call site keeps its own
mutation + snapshot mapping; only the loop boilerplate moves.

Semantics preserved **exactly**:
- same `OPTIMISTIC_RETRY_LIMIT = 4` (passed through; each module keeps its const)
- same duplicate-key handling via each module's existing `isDuplicateKeyError`
  (passed in — the two modules' impls are equivalent: code === 11000 — kept the
  helper agnostic so neither private predicate had to move/merge)
- same `replaceOne` filter (`{ _id, updated_at: existing.updated_at }`)
- same first-write path (`insertOne`, recover from dup-key by looping)
- same "retry exhausted" throw, with the per-call-site **label** preserved
  (`mergeExtraction` / `world.mutate` / `upsertEntityGeos` / `applyEntityEdits`).
  One cosmetic-only normalization: the message tail unifies to `… for <id>` —
  `mergeExtraction`/`mutate` previously said `… for session <id>` (the extra word
  "session"). No test or runtime path depends on the exact tail; the
  load-bearing label prefix is unchanged.
- the doc's `updated_at` bump stays in each `build` (the helper does not touch
  field semantics — it only persists what `build` returns)

The four call sites collapse to a `build` closure + a result map. The pure
merge helpers (`applyExtractionToEntities`, `applyGeoUpsert`, `applyEntityEdit`)
and the `__test` surfaces are untouched, so the existing
`world.test.ts` / `world-map.test.ts` pass unchanged.

### 2. Env-flag truthiness parse  → EXTRACTED (TS + Python)

**TS** — two spellings of the same check were in the tree:
- array form: `["1","true","yes"].includes((process.env.X ?? "").toLowerCase())`
  — `app/api/world/[sessionId]/extract/route.ts`
- equality form: `const flag = (process.env.X ?? "").toLowerCase(); return flag === "1" || flag === "true" || flag === "yes";`
  — `route.ts`, `entity/route.ts`, `map/route.ts`, `edit-entities/route.ts`

Both reduce to "is env var X in the truthy set, default false". Extracted
`apps/web/lib/env-flag.ts`:
`export const envFlag = (name: string): boolean => ["1","true","yes"].includes((process.env[name] ?? "").toLowerCase())`.
Five call sites now call `envFlag("…")`. Same truthy set, same default-false.

**Python** — `os.environ.get("X", "<default>").lower() in ("1","true","yes")`
repeated across `generate.py` (8 sites) and `providers/llm.py` (3 sites). Note
the defaults differ per flag (`"false"` for most, but `"true"` for
`IMAGE_CONDITIONING`, `PROGRESSIVE_DRAFT`, `OPENROUTER_CACHE`,
`OPENROUTER_ENABLE_WEB_SEARCH`, `ANIMATE_PROMPT_REWRITE`). The helper takes the
default as a parameter so semantics are preserved exactly.

Extracted `env_flag(name, default="false")` into a new tiny module
`apps/modal-backend/_env.py` (no good existing home — `obs.py` is
observability-specific, `providers/_common.py` is provider-IO-specific). It's a
root-level sibling like `obs.py`, imported `from _env import env_flag` (the same
absolute-import pattern `llm.py`/`image_edit.py` already use for `obs`) and
explicitly added to the Modal image via `.add_local_python_source("_env")`
alongside `obs`/`providers`. Call sites:
- `generate.py` (8 sites): `os.environ.get(...).lower() in (...)` →
  `env_flag(...)`. The `WORLD_TOPDOWN_MAPS` site was `not in (...)` → flipped to
  `not env_flag(...)`. The `IMAGE_CONDITIONING` / `PROGRESSIVE_DRAFT` sites pass
  `default="true"`. After this, `os` had **no** remaining use in `generate.py`,
  so its now-dead `import os` was removed (required to keep `ruff` green — a
  direct consequence of the refactor).
- `providers/llm.py` (2 of 3 sites): `OPENROUTER_CACHE`,
  `OPENROUTER_ENABLE_WEB_SEARCH` (both `default="true"`). `os` stays (14 other
  uses).

**Not converted — `ANIMATE_PROMPT_REWRITE` (`llm.py` ~L1368).** It uses the
INVERSE idiom — `… .lower() in ("0", "false", "no")` (the *falsy* set) returning
the no-rewrite path — not the truthy `in ("1","true","yes")`. `not env_flag(...)`
is **not** behaviour-equivalent: for an arbitrary value like `"maybe"` the
original proceeds-with-rewrite (not in falsy set) while `not env_flag` would skip
(not in truthy set). The brief forbids changing env-flag semantics, so this one
is left exactly as written. Documented.

The **bench guards** in `tests/test_*_bench.py`
(`CONTINUITY_BENCH_RUN`, `CLICK_BENCH_RUN`) use the same truthy-`not in (...)`
idiom but live in the test tree with a default of `""`; left as-is (test-only,
importing an app module into a paid-bench guard isn't worth it). Documented, not
changed.

### 3. Modal-upstream fetch/SSE error boilerplate  → PARTIALLY EXTRACTED

There are two genuinely-distinct shapes here, not one:

**(a) "proxy verbatim" handlers** — `animate`, `resolve-click`,
`precompute-candidates`, `status`, `trace/recent`, `trace/abort-stats`. These
share: read `MODAL_API_URL` (503 if unset) → `fetch(modalUrl + path, …)` →
relay `upstream.status` + body text + content-type back. They split into two
sub-variants (POST-with-abort-passthrough+trace-header vs GET-with-timeout), but
the common spine is real.

**(b) "parse-and-branch" handlers** — `generate-page` (injects `world_context`,
streams SSE through), `world/extract` (pulls prior entities, merges the result
back, seeds geo), `world/edit-entities` (builds references, applies edits). The
fetch is buried mid-handler between bespoke pre/post logic; the non-2xx → JSON
error is the only shared fragment and it differs in payload (`detail` slice,
`trace_id`, status code 500 vs 502).

**Decision:** extracted the URL-join only (`modalUrl(path)` →
`apps/web/lib/modal.ts`), which removes the one fragment that is identical in
**every** call site (`${url.replace(/\/$/, "")}${path}`) and is easy to get
subtly wrong. Did **not** wrap the whole fetch/relay: the (a) handlers differ in
method/abort/timeout/trace-header enough that a single helper would need 4-5
flags (contorting the handlers, the brief's stated skip condition), and the (b)
handlers don't share enough to factor without obscuring their bespoke flow.
This is the judgment-call skip the brief allowed for — documented here.

## Left deliberately (not duplication, or extraction would add complexity)

- **`isDuplicateKeyError`** in `world.ts` vs `world-map.ts`: behaviourally
  identical (code === 11000). Not hoisted into the new helper as a shared export
  because each is small, each module's tests/readers expect it local, and the
  optimistic helper takes it as a parameter — so no behaviour is centralised that
  shouldn't be. (A types/utils workstream could merge them later; out of lane.)
- **`snapshotFromDoc` / `emptySnapshot`** exist in both `world.ts` and
  `world-map.ts` but map **different** doc shapes to **different** wire shapes —
  same name, different code. Not duplication.
- **`world-geometry.ts` ↔ `providers/geometry.py`** — intentional cross-language
  mirror, parity-gated by the eval suite. Explicitly out of scope.
- **`video.py` / `image.py`** were listed as Python env-flag sites but contain
  **no** `lower() in ("1","true","yes")` boolean-flag pattern (their
  `os.environ.get` calls read string *values* — tier, model, base-url). Nothing
  to change there.
- **`output_locale … not in ("en","auto","")`** in `llm.py` is a locale guard,
  not a boolean env flag — left alone.

## Tests added

- `apps/web/lib/optimistic-update.test.ts` — fake in-memory collection exercises
  the four-way matrix: fresh insert, conflict-retry on `updated_at` mismatch,
  duplicate-key on first-write → loop recovery, and retry-exhaustion throw.
- `apps/web/lib/env-flag.test.ts` — truthy set + default-false + case-insensitivity.
- `apps/modal-backend/tests/test_env_flag.py` — truthy/falsy set, custom default,
  case-insensitivity, unset.

## Green gate

- `make eval` (repo root)
- `cd apps/web && pnpm exec eslint . --max-warnings=20`
