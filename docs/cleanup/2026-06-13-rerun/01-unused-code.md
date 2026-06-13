# Cleanup re-run — 2026-06-13 · Concern #3 Unused code (knip + ruff F401)

DELTA pass over the +157 commits / ~7.8k TS + ~14k Py added since `beedb82`
(closeup / ladder / POV program, PRs #64–#87). Prior standard: `docs/cleanup/01-unused-code.md`;
prior delta: `docs/cleanup/00-rerun-2026-06-09.md`. Prior KEEPs treated as default.

## Assessment

The discipline held again. **Python is spotless** — `ruff check --select F401` =
`All checks passed!` (zero unused imports). On the TS side knip surfaced 27 items;
every prior-KEEP export/type re-confirmed still in-file-used, and the dependency /
binary false-positives that dogged earlier runs are **gone this run** (none flagged).
Only **one genuinely-dead symbol** appeared in the new code: the orphan interface
`SessionNodeEvent` (zero refs anywhere). One pre-existing export, `cropRegion`, was
silently refactor-orphaned of code callers since `beedb82` but is named as a
cross-language mirror anchor in two Python bench comments + a planning doc, so it is
REPORT-ONLY (removing it would orphan documented references, and the body logic is
the reference impl the Python `crop_box` mirrors).

## Tooling output (fresh, this run)

- **`ruff check --select F401 apps/modal-backend`** → `All checks passed!` (0 hits).
- **`knip --config knip.json`** (run from `apps/web`, where knip 6.16.1 lives) →
  2 "unused files" (both known FPs), 10 "unused exports", 15 "unused exported types".
  No unused dependencies, no unlisted binaries (cleaner than Jun-7 / Jun-9 runs).

## Findings

| Severity | Verdict | file:line | symbol | Verification done | new/old |
|---|---|---|---|---|---|
| **low** | **AUTO-remove** | `apps/web/lib/db.ts:534` | `SessionNodeEvent` (interface) | `rg -ni 'SessionNodeEvent'` across the whole repo (all globs, incl md/json, minus node_modules/lock) → **only its own definition line**. Dynamic-pattern probe (`rg 'NodeEvent\|node_event\|nodeEvent'`) → no string-key/alias use. The live read-along feed at `app/api/session/[sessionId]/events/route.ts:78-88` sends an **inline** `{type:"node_added", node:{…}}` payload, typed client-side via `IncomingNode` (`hooks/useSharedSession.ts:69` — which IS used), never via `SessionNodeEvent`. The sibling `watchSessionNodes()` uses `NodeDoc`. Not a barrel/re-export (no `lib/index.ts`). Same class as the prior runs' removed `hasWSStreaming` / `PlanWorldRequestBody`. | **NEW** (`c0075f1`, after `beedb82`) |
| **low** | **REPORT-ONLY** | `apps/web/lib/image-condition.ts:76` | `cropRegion` (async fn) | No **code** caller: `rg '\bcropRegion\b'` (ts/tsx/py/mjs, all dirs) → only its def (`:76`) + body (`:82`, which calls `cropRegionRect`). It was a prior-KEEP ("called by buildConditionStack") but the refactor in `6018503`/`4682050` made `buildConditionStack` (`:162`) call the extracted `cropRegionRect` directly, orphaning `cropRegion`. **Held for report** because it is named as the canonical cross-language reference impl: `enter_runner.py:137` ("Pillow mirror of the client's cropRegion"), `coherence_runner.py:40` ("mirror of lib/image-condition.ts cropRegion default"), `docs/PLAN_EDITING.md:27`. Same cross-lang-anchor rationale the prior report used for `EntityGeoEdit`. Removal needs those mirrors re-pointed at `cropRegionRect`/`cropBox` first. | **OLD def, NEWLY orphaned** |
| info | DO-NOT-TOUCH | `public/theme-init.js` | (file) | Known FP. Loaded via runtime `<script src="/theme-init.js" />` at `app/layout.tsx:72` (confirmed) — knip can't see runtime script tags. | old |
| info | DO-NOT-TOUCH | `scripts/ladder-proof.mjs` | (file) | Known FP. Makefile `ladder-proof` target + user's uncommitted edits (shows as `M` in git status). | old |
| info | KEEP | `apps/web/lib/modal.ts:13` | `SHARED_TOKEN_HEADER` | Used in-file at `:17` (`{[SHARED_TOKEN_HEADER]: token}`) **and** is the TS half of the `x-openflipbook-token` auth header mirrored by `generate.py:65` (literal match confirmed; also exercised in `test_deploy_safety.py`). Cross-language contract. | NEW |
| info | KEEP | `apps/web/lib/image-condition.ts:103` | `cropRegionRect` | Used in-file: called at `:82` (by `cropRegion`) and `:162` (by `buildConditionStack`). Live. | NEW |
| info | KEEP | `apps/web/lib/waterfall-segments.ts:41` | `IDLE_GAP_MS` | Used in-file at `:65` and `:88`. | NEW |
| info | KEEP | `apps/web/hooks/useSharedSession.ts:5` | `IncomingNode` (interface) | Used in-file at `:16`, `:30`, `:69` — the actual typed shape of the `node_added` SSE payload. | NEW |
| info | KEEP | `apps/web/lib/db.ts:425` | `PublishedSessionDoc` (interface) | Used in-file as `Collection<PublishedSessionDoc>` generic at `:443-444`. MongoDB schema surface. | NEW |
| info | KEEP | `apps/web/lib/db.ts:499` | `PresenceDoc` (interface) | Used in-file as `Collection<PresenceDoc>` generic at `:505-506`. MongoDB schema surface. | NEW |
| info | KEEP | `apps/web/lib/scale-neighbors.ts:5` | `LogicalNeighbor` (interface) | Used in-file at `:16` (`neighbors: LogicalNeighbor[]`). | NEW |
| info | KEEP (test-only) | `apps/web/lib/world-map.ts:113,136,174` | `applyGeoUpsert`, `recomputeBounds`, `applyEntityEdit` | Re-exported via `__test` object (`:443`) destructured by `world-map.test.ts`; also used internally (15/9/12 refs). Prior adjudication. | old |
| info | KEEP (test-only) | `apps/web/lib/world.ts:617` | `scoreEntitiesForContinuity` | Re-exported via `__test` (`:899`), consumed by `world(-helpers).test.ts`; 16 internal refs. Prior adjudication. | old |
| info | KEEP (in-file) | `lib/styles.ts:79`, `lib/world-overlay.ts:24` | `PRESET_ANCHOR_PREFIX` (3 refs), `viewScale` (3 refs) | In-file usage re-confirmed; prior KEEP. | old |
| info | KEEP (in-file) | `components/time-scrubber.tsx:5`, `hooks/usePrefetchCache.ts:5,10`, `hooks/useWorldState.ts:12`, `lib/db.ts:98,103,320`, `lib/image-condition.ts:11`, `lib/trace-types.ts:28,36` | `ScrubberFrame`, `PrefetchPoint`, `PrefetchBBox`, `WorldStateView`, `ClickInParent`, `NodeSource`, `ErrorDoc`, `ConditionRole`, `AbortStageRow`, `AbortEntry` | Each ≥2 in-file refs (field/array/param/reducer-state types). All prior-KEEP, re-confirmed. | old |

## Why only one AUTO-remove

`SessionNodeEvent` is provably dead: a single repo-wide case-insensitive grep returns
nothing but its own declaration, there is no dynamic/string-key indirection, it is not
a barrel re-export, and the feature it documents (the read-along SSE feed) is fully
typed by other means. It is safe to delete the 6-line interface with no further
re-pointing. Everything else knip flags is either an in-file-used `export` (an
encapsulation question for the types workstream, not dead code), a test-only export
reached through the `__test` bridge, a MongoDB collection-generic schema type, or a
cross-language mirror anchor — none of which are dead.

`cropRegion` is the one judgment call: it has no live code caller after the closeup
refactor, but three docs/Python comments name it as the reference implementation the
backend's `crop_box` mirrors. Per the standing cross-language rule (and the
`generate.py`-adjacent caution), it is REPORT-ONLY: if the cleanup wants it gone, the
two bench comments + `PLAN_EDITING.md` should first be re-pointed at `cropRegionRect`.

## Excluded known false positives (per brief)

- `public/theme-init.js` — runtime `<script>` in `app/layout.tsx:72`. Excluded.
- `scripts/ladder-proof.mjs` — Makefile target + user's uncommitted edits. Excluded.
- `record-mappan.ts` — whitelisted in `knip.json` entries; did not appear in output. Excluded.
