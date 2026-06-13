# Cleanup re-run — 2026-06-13 (delta over the closeup/ladder/POV program)

The eight concerns ran Jun 7 (`7de5779`) + a delta re-run Jun 9 (`beedb82`). Since then
157 commits added ~7.8k TS + ~14k Py lines — the closeup rung, scene-closeups, the
conditioning-crop routing window, sightline-culled POV-surroundings (PRs #64–#87) — none
through cleanup. This is a full-tree re-audit of all eight concerns concentrated on that new
code; each concern's standard is its original `0N` doc plus the Jun 9 rerun. Run decisions:
**delta-over-baseline**, **cover TS + Python**, **safe-auto / risky-report**.

**Outcome: the discipline held again.** Across ~22k new lines the audit found two dead symbols
to remove and four annotations to tighten — everything else KEEP. No TS↔Pydantic contract drift
(the strengthened field-equality gate absorbed 8 new request fields at parity), 0 circular deps,
0 error-hiding, 0 slop comments.

| # | Concern | Verdict | Action / commit |
|---|---------|---------|-----------------|
| 1 | Dedup / DRY | new code strongly DRY | 1 dedup landed on request (`843a653`): lifted the env-float parser to a shared `render_loop._env_float`, imported `_score` rather than redefining. `_clamp01` in segmenter/detector = KEEP (prior 07 decision). |
| 2 | Shared types / TS↔Pydantic | **clean** | No drift: 40 TS == 40 Py request fields; 8 new fields (`max_attempts`, `verify`, `edit_mask`, `edit_region`, `surroundings_pov/behind`, `suppress_map_labels`, `from_closeup`) at parity. New closeup code imports config types rather than redeclaring. 3 low report-only intra-web tidies. |
| 3 | Unused (knip + ruff F401) | 1 dead export | Removed `SessionNodeEvent` (db.ts, 0 refs anywhere). Python `ruff F401` clean. 3 known false positives (theme-init.js, ladder-proof.mjs, record-mappan.ts) excluded. `6064f48` |
| 4 | Circular (madge) | **clean** | 218 TS files, 0 cycles. Python providers a DAG (manual import-graph check; new files are leaves). No change. |
| 5 | Weak types | 4 annotations (TS: 0) | generate.py loop accumulators typed: `loop_attempts: list[Attempt]`, `edit_attempts`/`judged_attempts: list[EditAttempt]`, `_judge_detail -> JudgeResult` (TYPE_CHECKING imports). TS added 0 weak types. `result`/`judged_image` `Any` = load-bearing protocol-erasure, KEEP. `83e3262` |
| 6 | Defensive (fail-loud) | **0 removals** | ~50 new handlers, all guard real boundaries (network/IO, untrusted VLM/LLM JSON, base64, browser quirk, observability). The new pure-logic layer has no try/catch at all. 0 error-hiding. No change. |
| 7 | Legacy / fallback | 1 dead path | Removed `cropRegion` (image-condition.ts) — orphaned by the conditioning-crop refactor (`6018503`); CORS rationale relocated to `cropRegionRect`, 3 references re-pointed. `_legacy_*_instruction`, the 5 new product flags, `PROVIDER_FALLBACK` etc. are all live + tested = KEEP. `6064f48` |
| 8 | Comments / slop | **0 edits** | New code carries zero in-motion / PR / audit / stub narration; INV-*/ladder/closeup vocabulary + why-rationale intact. No change. |

## Report-only (handed back for your call — none auto-applied)

1. **`edit_loop._score` + `_f` duplicate `render_loop`** — DONE on request (`843a653`): lifted the
   env-float parser to a shared `render_loop._env_float` and imported `_score` rather than
   redefining it. The loop skeletons stay parallel siblings (different judges/configs); behavior
   unchanged, `make eval` green.
2. **generate.py `result` / `judged_image` stay `Any`** — reassigned across branches mixing
   `render_loop.conclude(...).image` (typed `Rendered`) with `GeneratedImage`-only attribute reads
   (`.mime_type`/`.model`); the `Any` is deliberate protocol-erasure (one site already carries a
   comment saying so). Recommend KEEP.
3. **3 low intra-web type tidies (#2)** — e.g. `scene-closeup.ts` `regionBox: {x,y,w,h}` vs
   `EditRegionBox`; cosmetic, not a config consolidation.

## Notes

- The new senders reuse the conditional-spread pattern that hid the earlier
  `prefetched_surroundings` / `focus_id` drifts, but the full `GenerateBody`↔`GenerateRequestBody`
  field-equality gate now catches that class — and did: zero divergence this delta.
- `make eval` types `providers obs.py generate.py` (which covers `llm.py` via `providers`), so the
  generate.py annotations above are gate-verified — green at `83e3262`.

Per-concern detail in the `0N-*.md` files in this directory.
