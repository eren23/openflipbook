# Cleanup 8 (delta re-run) — AI-slop / build-history comments

**Scope:** `git diff beedb82..HEAD` over source files only (`apps/web/**/*.{ts,tsx}`,
`packages/**/*.ts`, `apps/modal-backend/**/*.py`) — the 157 commits / ~7.8k TS +
~14k Py added since the Jun 9 delta (`beedb82`): closeup / scale-ladder / POV
surroundings, PRs #64–#87. Standard: original `docs/cleanup/08-comments.md` +
Jun 9 `00-rerun-2026-06-09.md`. **Comments only; no executable code touched.**

## Assessment

The discipline held completely. The new code carries **zero** in-motion
narration, PR/audit/phase markers (`FIX A/B/C`, `codex #N`, `(M3)`, `Phase N`),
`TODO`/`FIXME`/`HACK`/`WIP`, stub bodies, placeholder returns, obvious-restatement
filler, or hedging slop (`for now`, `temporary`, `ideally we`) in any added
comment line. Every keyword hit (`used to`, `no longer`, `placeholder`,
`instead of`) resolved to either a load-bearing WHY (an invariant, or the
specific visual failure a guard prevents) or an LLM prompt string — both
explicitly protected by the standard. This delta is, if anything, a model of
the repo's "explain why" comment culture: the new POV/closeup comments in
`geo-tap.ts`, the incident-documenting header in `waterfall-segments.ts`, the
relocation-bug rationale in `location-phrase.ts`, and the `docs/COSTS.md`-mirror
note in `cost-estimate.ts` are exemplary and stay.

**Net find: 0 edits.** Default-KEEP outcome — no churn to manufacture.

## Findings

| Sev | Action | file:line | Comment | Decision | Reason |
|-----|--------|-----------|---------|----------|--------|
| Low | **KEEP** | `apps/web/hooks/useWorldMode.ts:22` | `…world mode is per-session and used to always seed off.` | keep | Explains the deploy-time seeding footgun ("why did consistency regress"); the "used to" contrasts current behaviour against the bug state a reader must understand. Rationale, not changelog. |
| Low | **KEEP** | `apps/web/app/play/page.tsx:274` (`:515` on disk) | `…exactly the state that used to dead-end at a static "no localized geometry" message.` | keep | Justifies the auto-localize-once effect by naming the dead-end it replaces — load-bearing WHY. |
| Low | **KEEP** | `apps/web/app/play/page.tsx:709` (`:1473` on disk) | `// re-extraction won't re-add what's no longer drawn.` | keep | States the tombstone invariant for a new reader; present-tense, not history. |
| Low | **KEEP** | `apps/web/lib/waterfall-segments.ts` header | `Extracted (and fixed) because the inline version mislabeled… (the 184813ms incident).` | keep | The "(and fixed)" / incident reference IS the rationale for why the extracted math differs from the inline version and which regression it prevents. Prior run kept this class of rationale. |
| Low | **KEEP** | `apps/modal-backend/providers/render_loop.py:122` | `"""Placeholder for a judge axis that isn't applicable this attempt — keeps the gathered result shape positional."""` | keep | `_no_judge` is a real sentinel coroutine (returns `None` to hold a positional slot in `judge_concurrently`), not an unimplemented stub. "Placeholder" names its semantic role. (Also REPORT-ONLY zone.) |
| Low | **KEEP** | `apps/web/lib/world-geometry.ts:243` | `…a wide building no longer seeds at 6×6, so its map footprint tracks the size it was rendered at.` | keep | **Out of delta scope** — comment pre-dates `beedb82` (already cleaned); not a new-code finding. WHY rationale regardless. |

(Numerous additional `instead of` hits in `geo-tap.ts`, `scene-closeup.ts`,
`stream-client.ts`, `db.ts`, the API routes, and the Python providers are all
either WHY-rationale comments or LLM prompt-string content — KEEP, not tabled
individually.)

## Verification

- Searched added comment lines (`^\+` ∩ `//|#|*`) across the full delta for:
  in-motion narration (`now we`/`changed to`/`renamed`/`refactored`), markers
  (`PR #`/`codex #`/`FIX [A-Z0-9]`/`(M\d)`/`Phase \d`/`audit follow`),
  `TODO`/`FIXME`/`HACK`/`XXX`/`WIP`, self-congratulation, obvious-restatement
  filler, hedging (`for now`/`temporary`/`ideally we`/`revisit this`), and
  TS/Py stub bodies (`NotImplementedError`, `=> {}`, `pass # stub`,
  `return None # placeholder`). **All empty.**
- The only non-empty keyword classes (`used to` / `no longer` / `placeholder` /
  `instead of`) were each read in context and resolved to KEEP per the
  load-bearing / prompt-string carve-outs.
