# Cleanup re-run — 2026-08-09 (delta over the interiors/tap-enter/§4-register program)

Fourth pass of the eight concerns (Jun 7 `7de5779`, Jun 9 `beedb82`, Jun 13 PR #88). Since
Jun 13, 174 commits added ~31k lines — interiors (#161–166), tap=enter (#167–173), the
coverage campaign (#174–186), §4 pose-recovery + register telemetry (#189–209),
VIEW_LOOP_PREVIEW (#208–209) — none through cleanup. Full-tree re-audit of all eight
concerns concentrated on that delta; each concern's standard is its original `0N` doc plus
the two prior reruns. Run decisions: **delta-over-baseline**, **cover TS + Python**,
**safe-auto / risky-report**, one campaign branch (`chore/cleanup-rerun-2026-08-09`), one
commit per concern.

**Outcome: the discipline held a fourth time, with one real catch.** Zero dead code, zero
cycles, zero handler removals, zero slop in ~31k new lines. The catch: two TS↔Pydantic
contract drifts — one of them **live on the wire** (`scene_description`, sent by the web
extract call but absent from the TS request type since before the delta) — plus two holes
in the parity gate that let them slip. Both closed, gate widened 17→26 assertions.

| # | Concern | Verdict | Action / commit |
|---|---------|---------|-----------------|
| 1 | Dedup / DRY | 3 consolidations | SSE reader skeleton ×3 → new `lib/sse.ts` (generator, 100% covered; parse/abort stay per-caller); 2 private `clamp`s → `lib/clamp.ts` imports (#99 leftovers); `data_url_from_bytes` deleted (≡ `encode_data_url`, zero prod callers). Net −69 lines. `_clamp01` pair, `feedback.py` critic-block, loop siblings = KEEP per precedent. `089f7d4` |
| 2 | Shared types / TS↔Pydantic | **2 drifts closed, gate widened** | `place_form` added to the Pydantic `SceneView` mirror (+fixture+witness); live `scene_description` added to TS `ExtractEntitiesRequestBody`; fixture↔TS-interface check + ResolveClick/ExtractEntities/EditEntities body gates added (test-only, 17→26 passed); `regionBox` → `EditRegionBox` import (third adjudication, promoted). All additive — wire back-compat intact. `1d6e4d6` |
| 3 | Unused (knip + ruff F401) | **0 dead symbols** (4th clean run) | Python F401 spotless; knip's 2 new flags (`cropRegionRect`, `FirstRunCoachVariant`) in-file-used = KEEP; §4 register area fully consumed post-#203/#207 (zero `POSE_REGISTER_FIX` residue). safe-auto: knip.json record-demo entries — 2 deleted recorders dropped, live `record-features.ts` added. `1d1d174` |
| 4 | Circular (madge + import graph) | **clean** | 256 TS files (was 218), 0 cycles; packages/config 0; Python 54 modules / 92 edges = DAG except the **by-design** providers/llm SCC (#124 monkeypatch seam — module-object bind only, KEEP). Re-runnable checker committed (`pydag.py`). No change. |
| 5 | Weak types | 30 annotations (TS: 0) | Segmenter chain pinned to `Detection`/`SegmentEntity` (5 casts deleted in generate.py); ViewSpec de-`dict`ed end-to-end (8 sites, 4 casts deleted); 8 render closures → `GeneratedImage`; `_same_place_judge` → typed `Callable`; 8 missing return annotations (FastAPI trap honored: `sse_generate -> Response`, never a union). `result`/`judged_image` protocol-erasure = KEEP per binding. mypy same 48 files green. `8831cb9` |
| 6 | Defensive (fail-loud) | **0 removals**; 6 swallows made loud | 233 handlers enumerated (86 py except + 4 suppress; 117 TS catch + 26 .catch) — every one boundary-justified, third clean run. This run's mandate ("no error hiding") licensed log-only fixes for the 6 genuinely-silent swallows: `tap.zoom_judge_failed`, `tap.zoom_retry_failed`, `llm.choice_shape_error`, `llm.tool_shape_error`, `planner.citations_parse_error`, `extract_entities.image_decode_failed`. Control flow and returns byte-identical. `838575d` |
| 7 | Legacy / fallback | 1 dated doc archived | `GEOMETRIC_WORLD_AUDIT.md` → `docs/archive/` (frozen 2026-06-08, #174 precedent; 3 citations re-pointed). §4 detour removal verified orphan-free (deleted-token sweep: 0); tap.py legacy arms, `_legacy_*` builders (byte-identity-tested), VIEW_LOOP_PREVIEW, WORLD_REGISTER_GATE dual arm, steep-enter router = all live-by-design KEEP. `debf6e7` |
| 8 | Comments / slop | 2 wording trims | 0 commented-out code / stubs / TODO-litter in the delta; ~49 past-tense "used to/legacy" mentions adjudicated one-by-one — all but 2 are trap-documenting (KEEP). Trims: a changelog "now" (record-features.ts), a work-tracking parenthetical (tap.py) — trap sentences verbatim. `bab2a9d` |

## Report-only (handed back for your call — none auto-applied)

1. **`scripts/ux-bench` has no knip workspace** (#3) — new, Makefile-wired, zero tool
   coverage. Suggested block: `"scripts/ux-bench": { "entry": ["run.ts"], "project": ["*.ts"] }`.
2. **6× b64-encode+progress-SSE paint blocks** (#1; tap.py ×4, edit.py ×2, ~70 lines) →
   a `progress_frame` helper in `generate_modes/_frames.py`; paid-path bar per Jun-13.
3. **3 defensive judgment calls** (#6): tap.py draft-race swallow (prior-run KEEP precedent),
   segmenter per-label SAM3 skips (per-label warn = noise judgment), render_loop
   corrupt-vs-remote discrimination.
4. **Type-mint needs for a future #2 pass** (#5): `GenerateFinalEvent` TypedDict twin for
   the SSE payload dicts; provider-side `SceneView` twin for `world.py` wire params.
5. **Small tidies**: `page.tsx` resolve casts + relation/scale unions (#2);
   "byte-identical to today" dated anchors ×2 (#8); `record-geo.ts:84` cites a deleted
   sibling recorder (#8).

## Notes

- **Gate receipts (final tree):** `make eval` exit 0 — backend "All checks passed!",
  mypy 48 files, web 100 files / 832 tests, madge 258 files 0 cycles; eslint 0 errors /
  **17 warnings (= baseline, cap 20)**; web coverage thresholds hold (77.6/87.0/81.3/77.6,
  up from baseline); backend coverage **87% ≥ 85**; knip roster byte-identical to baseline
  (2 known-FP files / 9 exports / 15 types, all recorded KEEPs).
- **e2e-mock ran in CI, not locally**: a live real-provider stack occupied :3000 during the
  campaign (VIEW_LOOP_PREVIEW experiment) — tearing it down for a mock rebuild or driving
  it directly would have billed real providers. The required e2e-mock job gates the PR.
- The parity-gate widening (#2) is the structural fix for the drift class: optional TS
  fields could previously ride all three gate faces green (how `place_form` slipped).

Per-concern detail in the `0N-*.md` files in this directory.
