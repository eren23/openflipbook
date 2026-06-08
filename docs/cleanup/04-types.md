# Cleanup 4 — Consolidate shared types + fix TS↔Pydantic drift

Workstream 4 of the sequenced code-quality cleanup. Scope: **consolidate shared
type definitions and fix drift between the TS source of truth and its hand-
mirrored Pydantic models.** Dedup, across-the-board weak-type tightening,
defensive-code and comment cleanups belong to other workstreams and were left
untouched.

## Background — where the contract lives

`packages/config/src/index.ts` is the single source of truth for shared
wire/domain types. It is consumed two ways:

- **apps/web** imports it directly via the `@openflipbook/config` path alias.
- **apps/modal-backend** *hand-mirrors* the shapes into Pydantic models in
  `generate.py` (and a few dataclasses in `providers/llm.py`).

A **P0 schema-parity gate** locks the two sides together for the geometric-world
shapes. It is a pair of twin tests reading one shared JSON fixture:

- `packages/config/src/world-geo-fixture.json` — the pinned key sets + samples.
- `apps/modal-backend/tests/test_geo_schema.py` — asserts the **Pydantic**
  mirrors' field sets equal the fixture (+ validate the sample).
- `apps/web/lib/world-geo-schema.test.ts` — asserts the **TS** interfaces (via
  typed witnesses that `tsc` checks) deep-equal the same fixture.

Before this pass the gate covered only the 5 standalone geo shapes
(`WorldVec2`, `ObserverPose`, `MapCrop`, `SceneView`, `ProjectedEntity`). The
**request body** (`GenerateRequestBody` → `GenerateBody`) and the **continuity
entity** (`WorldContextEntity`) were unguarded — which is exactly how the
`focus_id` drift below slipped in.

---

## Drift found + fixed

### 1. `SceneView.focus_id` missing on the Pydantic mirror (load-bearing)

`SceneView` in `packages/config/src/index.ts:472` has `focus_id?: string | null`
— the geo id of the place you ENTERED, which anchors the entered scene's child
frame. The round-trip is real and end-to-end:

- **sender:** `apps/web/lib/geo-tap.ts:80` sets `scene_view.focus_id =
  route.focus_id`.
- **wire:** `apps/web/app/play/page.tsx:1480` puts `geoTap.scene_view` on the
  generate body; `apps/web/app/api/generate-page/route.ts` forwards the body
  **verbatim** to the backend `/sse/generate`.
- **reader:** `apps/web/app/api/world/[sessionId]/extract/route.ts:161` reads
  `sceneView.focus_id` to anchor the child frame; `generate.py:1439` re-dumps
  `body.scene_view.model_dump()` into the geometry/edit path.

But the Pydantic `SceneView` (`generate.py`) had only
`node_id / level / observer / map_crop` — so **Pydantic silently dropped
`focus_id` on validation** of the request body, breaking the round-trip through
the backend.

**Fix** — added the field to the mirror and to the parity fixture so all three
gate faces agree:

- `apps/modal-backend/generate.py` `class SceneView` — added
  `focus_id: str | None = None`.
- `packages/config/src/world-geo-fixture.json` — added `"focus_id"` to
  `keys.SceneView` and `"focus_id": "g1"` to `samples.SceneView`.
- `apps/web/lib/world-geo-schema.test.ts` — added `focus_id: "g1"` to the
  `sceneView` typed witness (the witness key set must equal the fixture key
  set; `tsc` already accepted the optional field, the test needed it present).

`SceneView` in `EditEntitiesBody` reuses the same Pydantic class, so the
`/edit-entities` path now also preserves `focus_id` for free.

### 2. `WorldContextEntity.state` too loose (`dict[str, Any]` → primitive union)

`WorldContextEntity.state` is `EntityState` in TS, i.e.
`Record<string, string | number | boolean>`
(`packages/config/src/index.ts:349`). The Pydantic mirror used
`state: dict[str, Any]`.

**Fix** — `apps/modal-backend/generate.py` `class WorldContextEntity`:
`state: dict[str, str | int | float | bool]` (mirrors `EntityState`'s value
union). Behavior-preserving: the only consumer,
`providers/llm.py` `_world_context_block` (~line 1247), already filters values
to `(str, int, float, bool)` before formatting, so non-primitives were never
used anyway — the type now states that contract.

### 3. Same `EntityState`-mirror tightening in `providers/llm.py`

Two more `state` bags that mirror `EntityState` (not freeform JSON) were
tightened from `dict[str, Any]` to `dict[str, str | int | float | bool]`:

- `class ExtractedEntity.state` (dataclass) — its builder
  `_coerce_extracted_entity` already drops non-primitives into the bag, so the
  field type now matches what is constructed.
- the inner `state` sub-bag built inside `_coerce_entity_update` (the
  `changes["state"]` value) — likewise primitive-only by construction.

**Left as `dict[str, Any]` on purpose** (genuinely freeform / heterogeneous, NOT
an `EntityState`):

- `EntityUpdate.changes` — a `Partial<Pick<Entity, name|appearance|facts|state|
  aliases>>`: mixes `str`, `list[str]`, and the nested state bag. Not a single
  value union.
- the LLM tool-call / JSON-Schema dicts in `llm.py` (`CLICK_SCHEMA`,
  `*_SCHEMA`, `_parse_*`, `_safe_json`, `extra_body`, `span_ctx`, …).
- the geometry-engine boundary dicts in `providers/geometry.py`
  (`entity / observer / entities` as `dict[str, Any]`) — these are the projection
  engine's freeform inputs; geometry-engine parity was explicitly out of scope.

---

## Consolidation candidates (web local redeclarations vs `@openflipbook/config`)

Goal: replace **local** type redeclarations with imports of the canonical config
type **only where the shape AND meaning are identical**. Near-duplicates that
live in a *different coordinate frame* were deliberately NOT force-merged.

| Local declaration | File | Looks like | Verdict |
| --- | --- | --- | --- |
| `WorldRect { x,y,w,h }` | `lib/world-layout.ts:3` | `MapCrop` | **Defer.** Atlas **screen/layout** space, not the geometric-world's world-unit `MapCrop`. Different frame; merging would couple two unrelated coordinate systems. |
| `parentClickPoint / from / to { x,y }`, connector points | `lib/world-layout.ts:17,28,30,…` | `WorldVec2` | **Defer.** Atlas-layout coords, not geometric-world `WorldVec2`. Different frame. |
| `pxPoints / points { x,y }` | `app/play/page.tsx:383`, `components/PlayPage/StrokeOverlay.tsx:5` | `WorldVec2` | **Defer.** **Pixel** screen points, not world units. |
| `cropBox(...) → { x,y,w,h }` | `lib/image-condition.ts:30` | `MapCrop` / `ResolveClickBBox` | **Defer.** 0..1 **image-fraction** crop, not a world crop or a VLM subject box. |
| `NormalizedStroke.bbox { x,y,w,h }` | `lib/image-click.ts:50` | `ResolveClickBBox` | **Defer.** Image-fraction stroke bounds; same letters, different meaning. |
| `{ x_pct, y_pct }` click point | `components/heatmap-overlay.tsx`, `lib/world-mode.ts:33`, `app/api/nodes/route.ts:19`, `app/play/page.tsx` | `GenerateRequestBody.click` | **Defer.** Config exposes no *standalone exported* click-point type (only inline on `GenerateRequestBody`/`Click`). Introducing a new shared alias is a different (additive) change, not a redeclaration removal — out of scope for "high-confidence exact match". |
| `EntityDoc { … }` | `lib/world.ts:68` | `Entity` | **Defer.** Mongo **document** shape: `updated_at: Date` (not `string`) + DB-only soft-delete tombstone. Legitimately differs from the wire `Entity`. |

**Already importing the canonical type (no action):** `lib/world-overlay.ts`
(`MapCrop`, `ObserverPose`, `WorldVec2`), `components/PlayPage/EntityHoverOverlay.tsx`
(`Entity`, `EntityBBox`), `lib/world.ts` (`EntityState`, `EntityBBox`),
`lib/db.ts` / `lib/click-route.ts` / `lib/geo-tap.ts` / `lib/world-geometry.ts` /
`lib/world-map.ts` (`SceneView`, `ObserverPose`, `MapCrop`, `ProjectedEntity`, …).

**Net: 0 consolidations applied.** Every local `{x,y}` / `{x,y,w,h}` /
`{x_pct,y_pct}` shape that *looked* mergeable is a near-duplicate in a distinct
frame (screen-pixels, atlas-layout units, or image-fractions) or a DB DTO — the
brief explicitly says not to force-merge those. No exact-shape **and**
exact-meaning redeclaration of an exported config type was found in apps/web.

---

## Parity-gate strengthening

`apps/modal-backend/tests/test_geo_schema.py` was extended so the
request-body + continuity drift class **fails the build** going forward. The new
checks parse the TS interfaces straight out of `packages/config/src/index.ts`
(a tiny regex over the `export interface … { … }` block) so they track the
source of truth rather than a second hardcoded list that could itself drift.
All FREE (no paid marker, no network — just a file read + Pydantic validate):

- `test_world_context_entity_mirror_matches_ts` — Pydantic
  `WorldContextEntity.model_fields` must equal the TS `WorldContextEntity`
  field set.
- `test_scene_view_mirror_carries_focus_id` — `focus_id` must be in
  `SceneView.model_fields` **and** survive `model_validate` (the exact bug that
  slipped — proves it isn't silently dropped).
- `test_generate_body_carries_geo_round_trip_fields` — `GenerateBody` must
  expose `scene_view` + `expected_layout`, and a validated body must preserve
  `scene_view.focus_id` and the `expected_layout` payload end to end (the path
  the web proxy forwards verbatim).

The existing fixture-driven tests (now 5 shapes × 2) continue to pin the
standalone geo shapes; the TS twin (`world-geo-schema.test.ts`) continues to pin
the TS interfaces against the same fixture.

---

## Verification (all green)

```
make eval                 # repo root
  pytest -m "not paid"    # PASS (geo-schema gate now 13 tests, was 10; 0 fail, 2 skip)
  ruff check .            # PASS
  mypy <6 gated files>    # Success: no issues found in 6 source files
  vitest run             # PASS (51 files, 395 tests)
  tsc --noEmit           # exit 0
  check:circular (madge) # No circular dependency found

cd apps/web && pnpm exec eslint . --max-warnings=20   # 0 errors, 16 warnings (all pre-existing)
```

mypy run explicitly per the brief on the gated set
(`providers/geometry.py providers/geometry_prompt.py providers/model_router.py
providers/grounding.py providers/detector.py generate.py`) plus a sanity run on
`providers/llm.py` (not in the gate but edited) — both clean.

## Files touched

- `apps/modal-backend/generate.py` — `SceneView.focus_id`; `WorldContextEntity.state` union.
- `apps/modal-backend/providers/llm.py` — `ExtractedEntity.state` union + the two builder locals.
- `apps/modal-backend/tests/test_geo_schema.py` — 3 new parity assertions + TS-interface reader.
- `packages/config/src/world-geo-fixture.json` — `SceneView` gains `focus_id` (keys + sample).
- `apps/web/lib/world-geo-schema.test.ts` — `sceneView` witness gains `focus_id`.
