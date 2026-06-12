# Testing — the before/after story

How to know a change didn't break anything, in two layers: a free deterministic
gate you run constantly, and paid VLM-judged benches with committed baseline
bands you run around risky generation-path changes.

## Layer 1 — the free gate (every commit, ~1 min, $0)

```
make eval
```

Backend pytest (`-m "not paid"`, ~530 tests) + ruff + mypy (strict on
`providers/`) + web vitest (~480 tests) + tsc + circular-dep check. What it
locks:

- **Wire parity**: TS ↔ Pydantic shapes (`world-geo-fixture.json` keys AND
  sample values, three-legged: fixture / TS witness / Pydantic mirror), plus
  `GenerateRequestBody` ↔ `GenerateBody` full field-set equality.
- **Prompt byte-identity**: frozen goldens pin the legacy (`view=None`,
  `VIEW_GRAMMAR=false`, `ENTER_EDIT_REF=false`) strings byte-for-byte through
  both import paths (`tests/test_prompt_library.py`). If a refactor drifts a
  single character of the shipped prompts, this fails.
- **Routing**: which op/model/endpoint each render mode hits
  (`test_model_router.py`, `test_generate_enter.py`, `test_generate_view.py`,
  `test_generate_ascend.py`), including every kill-switch's revert path.
- **Geometry**: the 2.5D projection engine's TS↔Py parity (goldens +
  cross-language fuzz), invariants, the `project_top_down` port.
- **Eval brains**: every paid bench's pure `summarize()` + the baseline file's
  schema (`test_eval_baselines.py`) — the decision logic is tested without
  spending.

Coverage check (free):

```
make coverage
```

Current floor (2026-06-10): backend 79% overall; the generation-steering
surface is the strong part — `prompt_library/*` 97–100%, `model_router` 100%,
`geometry` 98%, `grounding` 98%, `image.py` 87%. Known-thin and accepted:
`generate.py` 71% (the untested misses are the expand/around/animate/edit SSE
branches, which predate the consistency work), `video.py` 0% (the animate
feature), `_common.py` (network helper). Web: the view-path libs
(`geo-tap`, `click-route`, `world-geometry`, `image-condition`) sit ~99%;
the page-level components are the untested bulk.

## Layer 2 — the paid baselines (around risky changes, ~$7, ~15 min)

```
make eval-baselines        # all four, back to back
```

or individually: `eval-layout`, `eval-style`, `eval-enter-drift`, `eval-view`.

Each bench renders real images, judges them with Gemini, computes one metric,
and compares it against the committed band in
`apps/modal-backend/tests/eval_baselines.json`, printing
**PASS / REGRESSION / IMPROVED / LOW_N**:

| baseline | metric | band | what it guards |
|---|---|---|---|
| `layout_fidelity` | with-clause lift | 0.33 ± 0.15 | the layout clause still steers placement |
| `style_medium_lock` | medium-lock lift | 8.5 ± 2.0 | edits keep the world's art medium |
| `enter_same_place` | edit−fresh lift | 2.33 ± 2.0 | entering a place stays THE SAME place |
| `view_conformance` | intended-arm mean | 6.0 ± 2.5 | the deliberate camera actually lands |

The before/after ritual for a generation-path change:

1. `make eval` green on the base commit.
2. (risky prompt/model/routing change?) `make eval-baselines`, keep the
   verdicts.
3. Make the change; `make eval` green again — the goldens catch accidental
   prompt drift for free.
4. `make eval-baselines` again; compare verdicts. REGRESSION = the band floor
   was crossed — investigate before merging. IMPROVED = consider re-baselining
   via a reviewed edit to `eval_baselines.json` (record the run in `source`).

**Honesty notes.** The judge is a ranker, not a calibrated meter (~0.6
Spearman): bands are wide on purpose, and a single bad sample at n=3 can flag
a false REGRESSION — `enter_same_place`'s recorded history (+2.33 / −1.0 /
+2.33 across identical code) is the canonical example; re-run once before
believing a lone failure, and trust the frozen goldens for "did the prompt
actually change". Benches self-skip without their `*_BENCH_RUN` env, and the
conftest scrubs all model/flag env so host config can't flip tests. Artifacts
land in `tests/continuity_bench/reports/` (gitignored) — eyeball them; the
images are the ground truth the scores summarize.

## The matrix bench (evolvable eval)

`tests/matrix_bench/` runs **scenarios × arms × models × prompt-variants**
with every frugality guarantee built in:

- **Dry-run is the default.** `make eval-matrix-dry` (or any runner without
  its `*_BENCH_RUN` flag) prints the per-cell table — cached? / est $ — and
  the total to-bill figure, then exits. Nothing touches the network. Run it
  before EVERY sweep; it is also the free CI smoke.
- **Disk cache = free evolution.** A cell's identity is
  `sha(scenario | description | arm | model | prompt | params)`, cached under
  `tests/matrix_bench/cache/` (gitignored). To evolve a prompt: copy
  `prompts/recon_base.v1.txt` → `v2`, edit, add `recon_base.v2` to the sweep's
  `variants`, dry-run, sweep. Only the new variant's cells bill; an identical
  re-run is 100% hits and $0.00. Same for ground-truth edits (the corpus
  `description_sha` excludes the review block, so verifying a draft is free).
- **Hard budget cap.** The ledger charges BEFORE every paid call; default
  `MATRIX_BUDGET_USD=3`. An over-cap sweep is refused at pre-flight unless
  `MATRIX_ALLOW_PARTIAL=1` (runs to the cap, reports `stopped_reason`).
  A flaky provider call records a failed cell and the sweep continues.
- **The reconstruction bench** (`make eval-recon`) is the first scenario
  type: regenerate each VERIFIED `tests/map_corpus/` map from its authored
  description (arm `graph` = the product planning path, `direct` =
  ground-truth layout), then detect + segment + anchored heights and score:
  presence, `pos_raw` (absolute register) vs `pos_aligned` (relative layout
  after a fitted similarity transform), size, height order/abs, plus style /
  plausibility / prompt-alignment judges → weighted composite. Baseline:
  `recon_fidelity` in `eval_baselines.json`.
- **The report** (`python -m tests.matrix_bench.report`, auto-printed after
  live runs) aggregates configs (model × variant), marks the Pareto front on
  (quality, −cost, −latency), prints near-best tradeoff findings ("94% of the
  best composite at 27% of its cost, 2.4× faster") and the per-operation
  spend breakdown.

Authoring corpus ground truth: `make corpus-fetch` (pins shas), `make
corpus-draft id=<map>` (VLM draft, ~$0.015), then open the image + JSON side
by side, correct entities/heights/relations, flip `review.status` to
`"verified"`, bump `rev`. The recon bench only consumes verified entries.
