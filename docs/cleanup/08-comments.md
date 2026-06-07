# Cleanup 8 — strip AI-slop / build-history comments

**Concern:** the fast geometric-world work left build-history narration in comments —
audit markers (`codex #N`, `FIX 1a`, `P0`–`P7d`, `Phase 3/4/5`, `(M3)`), changelog
prose (`was X → now Y`, `user-reported`, `honest:`), and self-congratulation — none of
which helps a new reader. **Comments only; no executable code touched.**

## Rule applied
- **Removed outright:** pure narration / phase-and-audit markers / "this used to…" history.
- **Reworded to terse present tense:** any comment carrying a real *why*, invariant, or
  gotcha (kept the knowledge, dropped the story).
- **Left untouched:** executable code, test files, `world_bench/`, JSON string literals
  that merely look like comments (e.g. an `error:` payload), and the `docs/cleanup/*` set.

## Footprint
~30 files across `apps/modal-backend` (generate.py, providers/*), `apps/web`
(`app/play/page.tsx`, the world API routes, `lib/*`, the PlayPage components, hooks,
`atlas-view.tsx`) and `packages/config/src/index.ts`. Net ≈ −31 lines.

Rough tally: ~30 comments removed, ~40 reworded. Most-affected:
`apps/web/lib/world.ts`, `apps/modal-backend/generate.py`, `providers/llm.py`,
`packages/config/src/index.ts`, `apps/web/lib/world-geometry.ts`.

## Examples
- *Removed:* `// codex #3: recurring entities silently fell off the slice` → the
  rationale was kept (reworded) but the changelog framing dropped.
- *Reworded:* `"Estimate a generated image's CAMERA so the geometry layer stops
  assuming top-down (the live Ankh map is 2.5D)…"` → `"…doesn't assume top-down (many
  maps are 2.5D)…"` — present tense, no project-specific story.
- *Reworded:* the OpenRouter `json_object` back-compat note trimmed from six lines of
  history to two lines of the live invariant.
- *Strip:* `geo-tap.ts` JSDoc `steers by (P3) and the grounding loop audits against
  (P4)` → `steers by and the grounding loop audits against`; `world-map.ts`
  `Nested propagation (P7d):` → `Nested propagation:`.

## Verification
- `git diff` filtered for any changed line that is **not** a comment/docstring/blank →
  empty (no executable line changed).
- `make eval` green + `pnpm exec eslint . --max-warnings=20` clean.
