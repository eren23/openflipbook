# Cleanup re-run — 2026-06-13 · Concern #7 (deprecated / legacy / dead code paths)

DELTA pass over `git diff beedb82..HEAD` (157 commits, ~7.8k TS + ~14k Py): the
closeup/ladder/POV-surroundings program (PRs #64–#87). Standard + prior decisions:
`docs/cleanup/03-legacy.md`; prior delta `docs/cleanup/00-rerun-2026-06-09.md` (concern 3 = Clean).

## Assessment

The ladder/closeup program iterated hard on tap-routing and the conditioning crop,
but it iterated *in place* — each step refactored the single live path rather than
forking a parallel one, so almost nothing superseded was left behind. The one real
find is a dead 4-arg wrapper: `cropRegion` in `image-condition.ts`, which commit
`6018503` ("the conditioning crop IS the routing window") orphaned by switching
`buildConditionRefs` to call `cropRegionRect` directly. Everything else flagged by
the keyword sweep is a live default, an LLM byte-identity prompt-contract
(`_legacy_*` instruction builders), an external-API tolerance, or a documented +
tested + env-gated toggle — all matching prior KEEP verdicts, none stale.

## Findings

| Severity | Disposition | File:line | The path | Evidence superseded / not | Conflicts |
|---|---|---|---|---|---|
| Low | **AUTO-remove** | `apps/web/lib/image-condition.ts:76-83` | `export async function cropRegion(src, xPct, yPct, frac=0.42)` — the click-centered crop wrapper | **Genuinely superseded + zero callers.** Pre-`6018503`, `buildConditionRefs` called `cropRegion` (old `image-condition.ts:119`). Commit `6018503` rewrote it to call `cropRegionRect(parentDataUrl, regionBox ?? cropBox(...))` directly (now `:162`). Repo-wide `grep -rn "cropRegion" apps/web --include='*.{ts,tsx}'` excluding `cropRegionRect` returns **only its own definition** — 0 non-test callers, 0 test refs, not in `knip.json`. `cropBox` (its only dependency) stays live (used at `:165`), so deletion is the 8 lines only. The 4-arg form is now exactly `cropRegionRect(src, cropBox(x,y,frac))` — a thin dead wrapper. | **#3** (knip flags unused exports; this is its natural owner) · loosely #1/#5 (dead wrapper / one-call dedup) |
| — | KEEP | `apps/modal-backend/providers/prompt_library/instructions.py:38,80` (`_legacy_zoom_instruction`, `_legacy_enter_instruction`) | the pre-grammar `view=None` byte-identity prompt builders | **Live default branch, test-guarded.** Called at `:585,589` (zoom: `view is None` / no keep-fragment) and `:641` (enter: `view is None` or projection ∉ ENTER set). Test `tests/test_generate_view.py:121-126` asserts the flag-off enter equals `_legacy_enter_instruction` verbatim. Multi-way dispatch (faithful / label_free / view-aware / legacy), all arms reachable. "legacy" = the documented byte-identity contract for old renders, not dead. Same class as prior KEEP (LLM prompt prose + byte-identity). | matches prior KEEP |
| — | KEEP | `apps/modal-backend/providers/prompt_library/instructions.py:496` (`_faithful_zoom_instruction`) | the closeup-rung magnification string (`33acc21`) | **New live path, not an orphan.** Reached via `build_zoom_instruction` `:583` (`if faithful:`), driven from `generate.py:1857` `faithful=bool(body.scene_view and body.scene_view.closeup)`. The closeup rung reused the existing zoom/Kontext path with a `faithful` flag — it did NOT fork then abandon a parallel closeup builder. No superseded sibling exists. | — |
| — | KEEP / REPORT-ONLY | `generate.py` flags: `ENTER_STEP_IN_JUDGE`, `EDIT_JUDGE`, `ENTER_EDIT_REF`, `SCALE_OUTWARD_EDIT_REF`, `SCALE_OUTWARD_OUTPAINT` | the new ladder/closeup product toggles | **Each wired in `generate.py` AND has a dedicated test** (`test_generate_enter.py`, `test_generate_edit_judge.py`, `test_generate_view.py`, `test_generate_ascend.py`) with explicit "flag-off is byte-identical legacy" assertions. A flag + test reaching a branch = NOT dead (HARD RULE → REPORT-ONLY at most), and these live in `generate.py` (REPORT-ONLY regardless). `SCALE_OUTWARD_OUTPAINT` was already an explicit prior KEEP (documented+tested+env-gated). The "old / legacy bytes" comments are the *measured BEFORE baseline*, not dead branches. | matches prior KEEP (#28/SCALE_OUTWARD) |
| — | KEEP | `apps/web/lib/geo-tap.ts:81` (`describeSurroundings`) vs `:117` (`describeVisibleSurroundings`) | non-POV vs sightline-culled surroundings | **Not an old/new pair — two coexisting modes.** `describeSurroundings` is live at `:332` (non-POV branch); `describeVisibleSurroundings` is the POV/sightline branch (`3bd0abc`). Both have non-test callers + 6 tests each. POV is selected by `surroundings_pov`, not a replacement. | — |
| — | KEEP | `providers/image.py` (`PROVIDER_FALLBACK`, `fallback_chain`, `FALLBACK_CHAINS`) | Wave-4 failover chain | env-gated (`PROVIDER_FALLBACK`, off by default) + fully tested (`tests/test_provider_fallback.py`). Live graceful-degradation feature, not superseded code. | — |
| — | KEEP | `apps/web/app/play/page.tsx:~2328-2339` (`wideRegionCut`) + `:14134-14170` diff (W1/W2 `fallbackTap` chain) | world-OFF zoom-cut + geo-route fallback | live product degradation paths; `wideRegionCut` has 4 non-test callers + 6 tests; the `fallbackTap` chain is the documented degrade-to-faithful-zoom routing (`3fe29d9`). KEEP. | — |
| — | KEEP | misc keyword hits across the diff | "old blind coin-flip" critic comment (`generate.py:295`), "old fresh path scored 3" (test prose), "legacy renders keep hardcoded text" (view contract docs), `confidence: 0.0 # a fallback is never trusted`, etc. | All explanatory comments / prompt prose / measured baselines / genuine product defaults. No dual code path. Comment polish is concern #8's remit. | #8 (comments) |

## Net

- **AUTO-remove: 1** — `cropRegion` (`image-condition.ts:76-83`), proven 0 callers / 0 tests, superseded by `cropRegionRect` in `6018503`. (Concern #3 / knip is the alternative owner — coordinate to avoid a double-edit.)
- **REPORT-ONLY: 0 net new** — the five `generate.py` toggles are tested+wired (not dead); listed for visibility only, no action.
- **KEEP: all other keyword hits** — `_legacy_*` builders (byte-identity LLM contract), `_faithful_zoom_instruction` (new live path), the env-gated tested flags, the two surroundings modes, the Wave-4 fallback chain, `wideRegionCut`, and the comment-only hits. Consistent with both prior passes' verdicts.

## Method

`git diff beedb82..HEAD -- 'apps/web/**/*.{ts,tsx}' 'packages/**/*.ts' 'apps/modal-backend/**/*.py'` →
keyword sweep `deprecated|legacy|superseded|no longer|obsolete|old|_v1|_v2|fallback|todo|fixme|hack`
on added lines; traced the brief's named commits (`6018503`, `33acc21`, `d025f8e`,
`cf29848`, `2389670`, `6f4d274`, `249fb65`); enumerated every exported fn in the
iterated TS libs (`geo-tap`, `click-route`, `scene-closeup`, `geo-to-edit`,
`image-condition`) + the new Wave libs and counted non-test vs test callers; verified
each Python product flag is both wired in `generate.py` and test-covered.
