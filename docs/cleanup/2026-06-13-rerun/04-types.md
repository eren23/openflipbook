# Cleanup re-run 2026-06-13 — Concern #2: shared types + TS↔Pydantic drift

Delta pass over the closeup/ladder/POV-surroundings program (PRs #64–#87, 157
commits since `beedb82`). Standard = `docs/cleanup/04-types.md` + the 2026-06-09
re-run; prior KEEPs are the default.

## Assessment

**No TS↔Pydantic contract drift exists in the new code — sub-goal A is clean.**
The schema-parity gate the prior runs strengthened did its job: every new request
field landed on BOTH the TS `GenerateRequestBody` and the Pydantic `GenerateBody`
(field sets are 40-for-40 identical, verified directly), and `WorldContextEntity`
gained `location_hint` on both sides at parity. The new geo shapes (`ViewSpec`,
`SceneView.closeup`/`view`, `WorldEntityGeo.border`/`height_m`) are fixture-gated
in `test_geo_schema.py` (17 tests, all green on HEAD). Response/event additions
(`EditVerdict`, `image_op`, `session_spend_estimate`, the `draft` stage) are
TS-source-of-truth, emitted as matching Python dicts, and consumed by typed web
readers — consistent with prior practice (events are not Pydantic-gated). For
sub-goal B: the new code is disciplined — it **imports** `EntityBBox`,
`NodeRelation`, `ScaleKind`, `SceneView`, etc. from `@openflipbook/config` rather
than redeclaring them, introduces **zero** new `: any`/`as any`, and adds **zero**
fresh standalone redeclarations of an exported config type. The only consolidation
notes are pre-existing inline `relation`/`scale` string unions (the delta merely
added the `"edit"` value to them) and two `{x,y,w,h}` region aliases that mirror an
inline-only wire shape — all REPORT-ONLY or KEEP.

## Sub-goal A — TS↔Pydantic contract drift: NONE FOUND

Traced every new field on a Pydantic request/response model and every `fetch`
body in the changed `app/api/**/route.ts` + `page.tsx` senders.

- **`GenerateBody` ↔ `GenerateRequestBody`** — 8 new request fields this delta
  (`max_attempts`, `verify`, `edit_mask`, `edit_region`, `surroundings_pov`,
  `surroundings_behind`, `suppress_map_labels`, `from_closeup`) + nested
  `EditRegion`, `ViewSpec`, `SceneView.closeup`/`view`. **All present on both
  sides.** Direct field-name diff: 40 TS fields == 40 Py fields, zero divergence
  either direction. The gate's `test_generate_body_carries_geo_round_trip_fields`
  asserts FULL set-equality (the assertion the prior run added to close the
  `prefetched_surroundings` / `focus_id` hole); its TS-interface regex captures
  all 40 fields, so the equality is real, not falsely satisfied. The new senders
  use conditional spreads (`...(cond ? { surroundings_pov: true } : {})`) — the
  same excess-property-check-bypassing pattern that hid the prior bugs — but the
  full-equality gate now catches that class, and it is green.
- **`WorldContextEntity`** — gained `location_hint` on both TS and Pydantic;
  field sets at parity (gated by `test_world_context_entity_mirror_matches_ts`).
- **`EditVerdict` (new), `image_op`, `session_spend_estimate`, `draft` stage** —
  TS is the source of truth; Python emits plain dicts whose keys match field-for-
  field (`generate.py:991`, `:1112`, `:1009`/`:1107`/`:1150`/`:2184`, `:1008`/
  `:2199`, `:2101`), and the web reads them through the typed `evt`
  (`page.tsx:818`, `:835` → `formatEditVerdict(v: EditVerdict)`). Not Pydantic-
  gated, by the same design as the rest of the event stream — REPORT-ONLY, no
  action (collapsing a TS↔dict event mirror is out of scope per brief).
- **`ModerateTextBody` (new, `{text: str}`)** — internal `/moderate-text` endpoint
  (gallery publish, `app/api/gallery/publish/route.ts:50`); inline `{text}` body +
  inline `{allowed,reason}` response, no `@openflipbook/config` type expected
  (same as other internal endpoints). Not a contract surface.
- `AnimateBody`, `ResolveClickBody`, `ExtractEntitiesBody`, `EditEntitiesBody`,
  `PlanWorldBody` — **unchanged** this delta. Session events/presence routes are
  pure Mongo (no Python call) — they never cross the boundary.

## Sub-goal B — duplicate type defs in new code

| severity | AUTO/REPORT-ONLY | file:line | issue | recommended change | conflicts-with |
| --- | --- | --- | --- | --- | --- |
| info | — | `apps/web/lib/entity-hit.ts:1`, `lib/scene-closeup.ts:1`, `lib/world-geometry.ts`, `lib/world-map.ts`, `components/PlayPage/EntityHoverOverlay.tsx` | The new closeup/ladder code **already imports** `EntityBBox`, `SceneView`, `Entity`, `finerTier` from `@openflipbook/config`. No `{x_pct,y_pct,w_pct,h_pct}` redeclaration introduced. | None — note of correct practice. | — |
| low | REPORT-ONLY | `apps/web/app/api/nodes/route.ts:22-23` | `relation?: "descend"\|"expand"\|"ascend"\|"edit"` == `NodeRelation`; `scale?: "component"\|"peer"\|"container"` == `ScaleKind` (no `\| null`). Pre-existing inline unions; the delta only added the `"edit"` value. File already imports `{ ScaleTier, SceneView }` from config. | Could import `NodeRelation`/`ScaleKind` (inline union → imported type = behavior-preserving AUTO). Not a documented KEEP, but pre-dates the delta and was left by both prior runs (their tables covered geometry shapes/DTOs, not these string unions) — treat as implicit KEEP unless the team wants the tidy. | Extends prior 04-types KEEP scope (no contradiction). |
| low | REPORT-ONLY | `apps/web/lib/node-kind.ts:32` | `relation?: NodeRelation \| null` written inline; file already imports `{ ViewLevel }` from config. | Import `NodeRelation`, write `NodeRelation \| null` (removes the literal dup, keeps null). Low value. | — |
| info | KEEP | `apps/web/lib/db.ts:126/127,152/153,171/172` | `relation`/`scale` inline unions on `NodeDoc`/`NodeInsert` (carry `\| null`) and `NodeRow` (no null). | **KEEP** — the brief's explicit note: db.ts variants carry `\| null` storage semantics (a real difference). The Mongo-document layer's local storage contract. | Matches prior 04-types db.ts KEEP. |
| info | KEEP | `apps/web/app/play/page.tsx:188` | `relation?: "descend"\|"expand"\|"edit"` — a deliberate SUBSET of `NodeRelation` (omits `"ascend"`; client-create never makes an ascend node here). `scale` (`:189`) == `ScaleKind`. | **KEEP** the `relation` subset (narrowing is intentional, not `NodeRelation`). `scale` is importable but trivial. | — |
| info | KEEP | `apps/web/lib/edit-mask.ts:6` `EditRegionBox {x,y,w,h}` | Local named alias for `edit_region?: {x,y,w,h}`, which config exposes **only inline** on `GenerateRequestBody` (no standalone export). Author already documents the mirror in the docstring. | **KEEP** — same class as the prior run's `{x_pct,y_pct}` click-point KEEP: config has no standalone exported type, so adding/removing a shared alias is additive, not a redeclaration removal. | Matches prior 04-types `{x_pct,y_pct}` KEEP rationale. |
| low | REPORT-ONLY | `apps/web/lib/scene-closeup.ts:22` `regionBox: {x,y,w,h}` | Inline anonymous shape structurally == `EditRegionBox` (same 0..1 natural-image region semantics) in sibling new code; `scene-closeup.ts` doesn't import `edit-mask`. | Intra-web tidy: reuse `EditRegionBox` from `lib/edit-mask.ts`. NOT a config consolidation; small. | — |

## Verification

```
apps/modal-backend $ python3 -m pytest tests/test_geo_schema.py -q   # 17 passed
# GenerateBody  ↔ GenerateRequestBody : 40 == 40 fields, 0 divergence (direct diff)
# WorldContextEntity TS ↔ Py          : field-set parity (incl. new location_hint)
# delta TS new ': any' / 'as any'     : 0
# delta TS new standalone redecl of an exported config type : 0
```

## Net

0 AUTO changes warranted, 0 contract drift. The strengthened gate from the prior
runs absorbed the entire +7.8k-TS / +14k-Py program without a single new
TS↔Pydantic divergence. Sub-goal B surfaces only pre-existing inline `relation`/
`scale` unions (REPORT-ONLY consolidation, implicitly KEEP) and the documented
db.ts `| null` storage KEEP; the one genuinely-new near-dup (`scene-closeup.ts`
`regionBox` vs `EditRegionBox`) is an intra-web tidy, not a config matter.
