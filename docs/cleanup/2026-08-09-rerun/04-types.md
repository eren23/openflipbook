# Concern 04 — Shared types / TS↔Pydantic (rerun 2026-08-09)

Delta 83e3262..HEAD (174 commits) + full-tree spot re-check. Standard: docs/cleanup/04-types.md + the Jun-09/Jun-13 reruns; prior KEEPs default. Branch chore/cleanup-rerun-2026-08-09, HEAD e75e3b1. RESEARCH ONLY — no repo file modified.

## Parity-gate receipts

- Gate: `apps/modal-backend/tests/test_geo_schema.py` (Py face) + `apps/web/lib/world-geo-schema.test.ts` (TS face) + shared fixture `packages/config/src/world-geo-fixture.json`.
- `cd apps/modal-backend && python3 -m pytest tests/test_geo_schema.py -q` → **17 passed**.
- `cd apps/web && pnpm exec vitest run lib/world-geo-schema.test.ts` → **16 passed**.
- Direct field diff (script, not the gate): `GenerateBody` ↔ `GenerateRequestBody` = **42 == 42, diff ∅** (Jun-13 was 40; delta added `prefetched_enter_as`, `prefetched_place_form`, both at parity). `ResolveClickBody` ↔ `ResolveClickRequestBody` 10==10. `EditEntitiesBody` ↔ `EditEntitiesRequestBody` 6==6. Nested slices at parity: `Click`, `EditRegion`, `PriorEntity`↔`Pick<Entity,…>`, `GeoEntityRef`↔`Pick<WorldEntityGeo,…>` (7==7), `WorldContextEntity` (gate-covered).
- All-6 fixture shapes vs TS interfaces (script): WorldVec2/ObserverPose/MapCrop/ViewSpec/ProjectedEntity OK; **SceneView DRIFT ts-only={place_form}**.

## Delta wire-field inventory (every +field in packages/config/src/index.ts since 83e3262)

Request side: `prefetched_enter_as` ✓Py, `prefetched_place_form` ✓Py, `SceneView.enter_index` ✓Py+fixture+witness, `SceneView.place_form` ✗ (finding 1).
Response/event side (TS source of truth, Python emits dicts — NOT Pydantic-gated by design, per Jun-13 precedent; emit keys verified): `ResolveClickResponse.place_form` (generate.py:1304, 1367; mock.py:290), `GenerateFinalEvent.render_unjudged` (tap.py:1155), `.layout_suppressed` (tap.py:1160), `.scene_view` stamp (tap.py:1146), `GenerateErrorEvent.detail` (generate.py:1120, ascend.py:230), `GenerateExpandDoneEvent.failed` (expand.py:108/128/226), `GenerateAscendReadyEvent.render_unjudged` (ascend.py:257), `Entity.appearance_borders` + `ExtractedEntity.border`/`EntityUpdate.border` (extraction.py:33/45 dataclass fields fill them). All key names match field-for-field. No action.

## Findings

### 1. HIGH | drift | `SceneView.place_form` missing from the Pydantic mirror — safe-auto

- **file:line**: `packages/config/src/index.ts` (`SceneView.place_form?: string`, added #161/#163) vs `apps/modal-backend/generate.py:215-238` (`class SceneView` — no `place_form`); `packages/config/src/world-geo-fixture.json` keys.SceneView lacks it; `apps/web/lib/world-geo-schema.test.ts` witness lacks it.
- **claim**: The TS contract says a request `scene_view` may carry `place_form`; Pydantic silently drops it on validation — the exact `focus_id` failure class.
- **evidence**: Script diff above (`SceneView DRIFT ts-only={place_form}`). Round-trip surface is real: `tap.py:1140` rebuilds the final-event stamp from `body.scene_view.model_dump(exclude_none=True)` — any request-side `place_form` dies there. Latent today: audited every sender — `geo-tap.ts:326/373` (buildSubmapTap/buildSceneTap), `scene-closeup.ts:68-78`, `page.tsx:1548/2821/2882` — all mint `scene_view` field-by-field and none copies `place_form`; interior arrivals re-derive it (`tap.py:1145` stamps `sv_stamp["place_form"]="interior"`). The first future sender that forwards a stored interior `sceneView` (e.g. the #168 sceneView-drift fix seam) loses the field silently.
- **confidence**: high (script-verified both directions; sender audit exhaustive via grep of `scene_view:` constructions).
- **verdict**: **safe-auto** — focus_id precedent, mechanical 3-file change: (a) `generate.py` SceneView += `place_form: str | None = None`; (b) fixture keys.SceneView += `"place_form"`, samples.SceneView += `"place_form": "interior"`; (c) TS witness += `place_form: "interior"`. Zero behavior change (today no sender sends it; `exclude_none` keeps stamps byte-identical). Re-verify: the two gate commands above.

### 2. HIGH | drift | `ExtractEntitiesRequestBody` missing `scene_description` (TS source of truth stale) — safe-auto

- **file:line**: `packages/config/src/index.ts` `ExtractEntitiesRequestBody` (6 fields) vs `apps/modal-backend/generate.py:1385-1398` `ExtractEntitiesBody` (7 — has `scene_description: str | None`).
- **claim**: A live, load-bearing wire field is absent from the TS contract — the `prefetched_surroundings` class, reverse direction of finding 1.
- **evidence**: Sender: `page.tsx:299` → web route `apps/web/app/api/world/[sessionId]/extract/route.ts:143` forwards `scene_description` to backend `/extract-entities`; consumer: `providers/llm/extraction.py:184` folds it into the extractor prompt (`scene_clean[:1400]`). The route types its own body locally (route.ts:39), so tsc never sees the config type on this path. Pre-delta (landed `2ca97e6`, world-memory) — missed by both prior runs' manual "unchanged this delta" diffs; the base was never re-validated.
- **confidence**: high (script diff + end-to-end trace).
- **verdict**: **safe-auto** — add `scene_description?: string | null` to `ExtractEntitiesRequestBody` (additive; wire back-compat policy satisfied). Type-only; `pnpm -r typecheck` proves it.

### 3. MEDIUM | gate hole | fixture shapes never compared against the TS interfaces — safe-auto (test-only)

- **file:line**: `apps/modal-backend/tests/test_geo_schema.py` (fixture tests assert Py==fixture; TS twin asserts witness==fixture; nothing asserts fixture==TS interface).
- **claim**: A TS-side *optional* field on a fixture-gated shape skips all three gate faces — tsc accepts a witness without an optional field. This is exactly how finding 1 slipped while both gates ran green (17/16 passed on the drifted tree).
- **evidence**: place_form drifted #161→today undetected; the request-body gate closed this class only for `GenerateBody` via `_ts_interface_fields` regex.
- **verdict**: **safe-auto** — add one parametrized test: `_ts_interface_fields(shape) == set(_FIXTURE["keys"][shape])` for the 6 shapes (all are `export interface`, the regex already handles them — verified by script). Fails on HEAD until finding 1 lands (that failure is the receipt); green after.

### 4. MEDIUM | gate hole | secondary request bodies not gated — safe-auto (test-only)

- **file:line**: `tests/test_geo_schema.py` covers GenerateBody + WorldContextEntity only.
- **claim**: ResolveClick/ExtractEntities/EditEntities parity rests on manual per-run diffs, and finding 2 proves that decays.
- **evidence**: scene_description survived two reruns' manual checks.
- **verdict**: **safe-auto** — 3 one-line assertions reusing `_ts_interface_fields`: `ResolveClickBody`↔`ResolveClickRequestBody`, `ExtractEntitiesBody`↔`ExtractEntitiesRequestBody`, `EditEntitiesBody`↔`EditEntitiesRequestBody`. First passes today (10==10), second passes once finding 2 lands, third passes today (6==6). AnimateBody/PlanWorldBody/PrecomputeBody/ModerateTextBody have no TS interface **by design** (internal endpoints; `PlanWorldRequestBody` was deleted as dead in the Jun-09 run) — exclude.

### 5. LOW | intra-web dup, third adjudication | scene-closeup regionBox vs EditRegionBox — safe-auto (my call this run)

- **file:line**: `apps/web/lib/scene-closeup.ts:22` `regionBox: { x,y,w,h }` vs `apps/web/lib/edit-mask.ts:6` `EditRegionBox` (exported, same 0..1 natural-image-region semantics, documented mirror of the wire `edit_region`).
- **claim**: Same shape AND same meaning (both 0..1 natural-image regions), flagged report-only in Jun-13 and Jun-09-adjacent runs; charter asks re-adjudication.
- **verdict**: **safe-auto** — one-line: `import type { EditRegionBox } from "./edit-mask"` + use it at :22. No import cycle (edit-mask imports only clamp/image-click). Gives the exported type its 2nd consumer (house "shared = used twice" satisfied). Cosmetic; fine to skip if the implementer wants the minimal diff.

### 6. LOW | report-only | page.tsx inline resolve-response casts near-dup `ResolveClickResponse`

- **file:line**: `apps/web/app/play/page.tsx:~2150, ~2252, ~2317, ~2390` — four inline `as { subject?; style?; …; enter_as?: string; place_form?: string }` casts of `/api/resolve-click` / `/precompute-candidates` JSON.
- **claim**: Structural near-dups of config `ResolveClickResponse` with deliberately loosened `enter_as?: string` (vs `EnterAs`) — loose-read-then-whitelist, same discipline as the Python side. `usePrefetchCache.ts` `PrefetchEntry` is the hook's own cache type, not a redeclaration (KEEP).
- **verdict**: **report-only** — consolidating to `Partial<ResolveClickResponse>` is a taste call (a cast either way); the precompute candidates shape has no standalone config export (same class as the `{x_pct,y_pct}` KEEP). Cross-ref concern 06 if it wants the `EnterAs` narrowing.

### 7. INFO | KEEP | `Alignment` (Py) ↔ `SimilarityFit` (TS) — deliberate cross-language twin

- **file:line**: `apps/modal-backend/providers/register.py:31` vs `apps/web/lib/world-geometry.ts:422`.
- **claim**: Same fields ({scale,tx,ty,flip_x/flipX,residual,matched}) + same math, duplicated across languages.
- **evidence**: Documented on BOTH sides as a lockstep twin (register.py docstring: "The LIVE prod register runs web-side… this Python twin stays the bench's source of truth"; TS: "keep the two in lockstep"). Single Python source (`tests/recon_bench/_align.py` imports from `providers.register` — "no duplicate geometry"). Parity-labeled tests both sides (`world-geometry.test.ts:186` "fitSimilarity (parity with recon_bench fit_alignment)" incl. the 0.5 scale-clamp case; recon bench golden-tests the Py side). Same pattern as the Pydantic hand-mirrors. **KEEP.** Nit for concern 08: the TS comment cites the pre-#203 location (`tests/recon_bench/_align.fit_alignment`); code now lives in `providers/register.py`.

### 8. INFO | charter item 3 | VLM `dict[str,Any]` shapes — no shared type SHOULD exist

- **file:line**: `providers/llm/client.py` (`_safe_json`, `salvage`, `_parse_*`, schema/extra_body/span_ctx), `llm/extraction.py:55/245/339`, `llm/click.py:97/131/434`, `llm/world.py:39/162/199/224-291`, `segmenter.py:64/94`.
- **assessment**: The house pattern is already correct: `dict[str,Any]` only at the untrusted-JSON parse boundary, coerced one hop later into EXISTING typed shapes (`ClickResolution`, `ClickCandidate` (click.py:19/69), `EntityExtractionResult`/`ExtractedEntity`/`EntityUpdate` (extraction.py — the Jun-era `state: dict[str, str|int|float|bool]` union SURVIVED the #124 package split), `Neighbor`/`EditPlan` (world.py), `PagePlan` (planner.py), `Detection` TypedDict (detector.py:20), `SegmentEntity` TypedDict (segmenter.py:30)). Every reply schema is endpoint-specific; a generic shared "VlmReply" alias would be speculative (house bar) and `dict[str,Any]` is the honest type for untrusted JSON. JSON-Schema literals stay loose per the original 04 ruling. **No new abstraction.** Cross-ref concern 06 (annotation, not consolidation): `segmenter.py:64` `det: dict[str,Any]` / `:94` `detections/segments: list[dict[str,Any]]` could reuse the existing `Detection`/`SegmentEntity` TypedDicts — the docstrings already name those shapes. `world.py` keeps `EntityGeoEdit` as validated dicts (`parse_entity_edits` enforces per-op fields); a hand-mirrored TypedDict union is not gate-able and adds nothing — KEEP.

### 9. INFO | good practice in the delta (no action)

- `Page`/`SessionNodeWire` were CONSOLIDATED out of page.tsx into `apps/web/lib/session-pages.ts` and imported back (page.tsx:136-143) — the delta performed its own concern-04 tidy.
- New TS decls audited, none redeclares a config type: `useWander.ts` (WanderCandidate/Options/StopReason — hook-local), `lib/coach.ts` CoachPreInput, `lib/waterfall-segments.ts` HiddenRange, `world-geometry.ts` FrameNode/AbsoluteFrame (frame-resolution engine types), Mongo `Document` shapes `idempotency.ts:17` KeyDoc / `session-owner.ts:27` OwnerDoc / `spend-ledger.ts:21` LedgerDoc (DB-DTO KEEP class), dev-bench/e2e/test locals (`Box` = Playwright boundingBox shape).
- Prior KEEPs re-affirmed unchanged: `nodes/route.ts:24-25` + `node-kind.ts:32` inline relation/scale unions (implicit KEEP), db.ts `| null` storage unions, world-layout/EntityDoc/image-fraction near-dups (untouched by delta).
- `apps/web/app/api/world/[sessionId]/extract/route.ts:36` local `ExtractRequestBody` is the web→route contract (different boundary + field set than config's route→backend type) — KEEP.

## Draft verdict-table row (Jun-13 style)

| # | Concern | Verdict | Action / commit |
|---|---------|---------|-----------------|
| 4 | Shared types / TS↔Pydantic | **2 real drifts + 2 gate holes** | `SceneView.place_form` (TS #161) missing from Pydantic mirror + fixture + witness — the focus_id class, latent (no sender forwards it yet), fixed by the mechanical 3-file focus_id recipe. `ExtractEntitiesRequestBody` missing live `scene_description` (pre-delta, survived two manual reruns) — added to TS, additive. Gate strengthened: fixture-shapes↔TS-interface equality (closes the optional-field blind spot that let place_form slip both green gates) + field-equality for ResolveClick/ExtractEntities/EditEntities bodies. GenerateBody 42==42 clean (delta's `prefetched_enter_as`/`prefetched_place_form` at parity); event additions emit-key-verified; `Alignment`↔`SimilarityFit` = documented lockstep twin, KEEP; VLM dict[str,Any] = correct boundary discipline, no shared type warranted. 1 low intra-web tidy (scene-closeup regionBox → EditRegionBox) promoted to safe-auto on third adjudication. |

## Safe-auto implementation checklist (fast re-verify)

1. `apps/modal-backend/generate.py` SceneView += `place_form: str | None = None`.
2. `packages/config/src/world-geo-fixture.json`: keys.SceneView += `"place_form"`; samples.SceneView += `"place_form": "interior"`.
3. `apps/web/lib/world-geo-schema.test.ts` sceneView witness += `place_form: "interior"`.
4. `packages/config/src/index.ts` ExtractEntitiesRequestBody += `scene_description?: string | null` (+ one-line comment: planner's full image prompt, extractor context).
5. `tests/test_geo_schema.py` += parametrized fixture↔TS-interface equality (6 shapes) + 3 body field-equality asserts (ResolveClick, ExtractEntities, EditEntities).
6. (optional cosmetic) `scene-closeup.ts` import `EditRegionBox`.
Verify: `cd apps/modal-backend && python3 -m pytest tests/test_geo_schema.py -q` (expect 17→~26 passed) + `cd apps/web && pnpm exec vitest run lib/world-geo-schema.test.ts` + `pnpm -r typecheck`. Ordering: 5 lands last (or same commit) — its new asserts fail without 1-4.

## IMPLEMENTED @ 1d6e4d6 (2026-08-09, base debf6e7)

All 5 safe-autos landed as one commit; both drifts re-verified present at debf6e7 before editing.

- Landed (6 files, +45/−3): `generate.py` SceneView += `place_form`; fixture keys+sample += `place_form`; TS witness += `place_form: "interior"`; `index.ts` ExtractEntitiesRequestBody += `scene_description?: string | null`; `test_geo_schema.py` += `test_fixture_keys_match_ts_interface` (6 shapes) + `test_secondary_body_mirrors_match_ts` (3 bodies); `scene-closeup.ts` regionBox → imported `EditRegionBox`.
- Receipts: pytest test_geo_schema **26 passed** (was 17); vitest twin **16 passed**; `make eval` exit 0 (pytest not-paid green/2 skips, ruff clean, mypy 48 files clean, vitest 99 files / 828 tests, madge 0 cycles); `pnpm -r typecheck` Done×2; eslint **0 errors / 17 warnings** (== baseline, 0 added).
- Stayed report-only: page.tsx inline resolve casts (finding 6), nodes/route.ts + node-kind.ts unions (7), Alignment↔SimilarityFit twin KEEP + stale TS comment pointer (→ concern 08), segmenter Detection/SegmentEntity annotations (→ concern 06), VLM dict[str,Any] no-new-type verdict (8).
- Nothing failed re-verification.
