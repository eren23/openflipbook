# 05 — Baseline & regression methodology

_Code-grounded design, `SESSION_AUDIT.md` discipline. How to turn the existing runners +
the new `geometry_checks` anchors into a **continuous regression harness**; a concrete design
for the two missing pieces (a baseline-drift guard, and the multi-hop drift runner for the
unmeasured Risk #1); and how the free deterministic layer and the paid VLM-judged layer fit
together. File names + thresholds + what runs free-per-commit vs paid-on-label are explicit._

## 1. What exists, sorted by what it costs to run

The eval surface is real (`Makefile:34-82`). The load-bearing split is **free deterministic
gates** (every commit) vs **paid VLM-judged runners** (manual / on-label). The methodology
below extends that split; it does not invent a parallel one.

| Layer | Mechanism | Cost | Today's trigger |
|---|---|---|---|
| Deterministic anchors | `geometry_checks` 20 anchors (`tests/test_geometry_checks.py`); solver goldens (`test_layout_solver.py`); projection golden + cross-lang fuzz (`eval-geometry`); schema parity (`test_geo_schema.py`) | **free** | `make eval` (`-m "not paid"`) every commit |
| Live diagnostic | `check_geo_entities(solved)` logs (never blocks) on real solver output | free | runtime, `generate.py:1734` |
| VLM-judged A/B | 5 paid runners: `layout`, `grounding`, `coherence`, `style`, `outward-drift` | **paid** | `make eval-<name>`, manual, gated by `*_BENCH_RUN` |

The paid runners share a deliberate shape worth preserving: a **pure `summarize`** (the
pass/fail brain) separated from the spend, so the decision is unit-tested free
(`outward_runner.py:139 summarize`, `coherence_runner.py:169`), a configurable threshold from
env (`outward_runner.py:39 OUTWARD_BENCH_THRESHOLD=6.5`), and artifacts written to a
**git-ignored** `reports/` (`.gitignore:48 apps/modal-backend/tests/**/reports/`). That is the
skeleton the regression harness slots into.

### The honest gap (what this doc designs)

`SESSION_AUDIT.md` + `PLAN_OUTWARD.md` name the holes precisely:
- **No baseline-drift regression guard, and no committed baselines to guard against.**
- **Multi-hop drift across OUTWARD/DEEPER chains is UNMEASURED** (Risk #1,
  `PLAN_OUTWARD.md:118`). `outward_runner.py` measures a **single** hop only (`_run_case` does
  one `from_tier → to_tier`).
- VLM-judge scores are treated as absolute pass/fail (a fixed `6.5`), but the literature is
  clear that VLM judges are **reliable as relative rankings, not absolute calibration** (see §5).

## 2. The continuous regression harness (free, per-commit)

The free layer is already a regression harness for *correctness* — it just lacks a
*quality-baseline* tier. Make it continuous by adding one deterministic gate and committing
baselines for the paid layer to compare against.

### 2.1 Wire the anchors as a self-check on every solver/projection output

The 20 `geometry_checks` anchors prove the checker; the live diagnostic
(`generate.py:1734`) proves real output at runtime. Close the loop in CI: extend
`test_layout_solver.py` so **every golden fixture's solved output is also run through
`check_geo_entities` and asserted issue-free** — the anchor already exists
(`test(anchor): solver output must pass the geometry invariants`, commit `3010b4a`). This makes
the deterministic invariants a *property* every solver test must hold, not a separate suite.
Do the same for the projection golden (`check_projected` over each `ProjectedEntity`).

### 2.2 Commit a thresholds file — the single source of pass/fail truth

Today each runner hard-codes or env-reads its threshold (`OUTWARD_BENCH_THRESHOLD=6.5`,
`STYLE_BENCH` pass at the medium-lock lift). Centralise them in **one committed file** so a
threshold change is a reviewable diff and the free layer can validate it without spending:

```
apps/modal-backend/tests/eval_baselines.json     # committed (NOT in reports/)
{
  "schema_version": 1,
  "style":          { "metric": "medium_faithfulness_lift", "min": 8.0,  "n_min": 1 },
  "layout":         { "metric": "mean_lift",                 "min": 0.0,  "n_min": 4 },
  "grounding":      { "metric": "grounded_confirm_rate",     "min": 0.6,  "n_min": 4 },
  "coherence":      { "metric": "mean_lift",                 "min": 0.0,  "n_min": 3 },
  "outward_drift":  { "metric": "fresh_medium_mean",         "min": 6.5,  "n_min": 10,
                      "regression_band": 1.0 }
}
```

- `min` = the absolute floor a paid run must clear (the existing thresholds, lifted here).
- `regression_band` = how far **below a previously-recorded baseline mean** a new paid run may
  fall before it is a *regression* (vs. just a low absolute score) — see §3.
- `n_min` = the minimum sample size for the number to count (guards the `outward` N≥10 caveat
  the runner prints, `outward_runner.py:198`; today nothing enforces it).

### 2.3 A free schema/threshold check in `make eval`

Add a free test `test_eval_baselines.py` (runs under `-m "not paid"`, so every commit) that:
1. loads `eval_baselines.json`, asserts it parses + every runner key has the required fields;
2. asserts each runner's `summarize()` emits the `metric` key the baselines file references
   (call `summarize` on a tiny **synthetic** `CaseResult` list — no spend, the pure-brain
   pattern the runners already enable, `outward_runner.py:139`);
3. asserts monotonic sanity on thresholds (`0 ≤ min ≤ 10` for 0–10 judges, band ≥ 0).

This catches the classic rot — a runner is refactored and stops emitting the metric the gate
keys on, or a threshold is fat-fingered — **for free, every commit**, with zero fal/openrouter
calls. It is the metamorphic/"golden-version" idea applied to the *gate*, not the model
([metamorphic regression testing](https://arxiv.org/pdf/2109.09798)).

## 3. Design: the baseline-drift guard (the missing regression tier)

Today a paid run prints a number and a human eyeballs it. A drift guard makes "did this commit
make consistency *worse*" mechanical. Design:

### 3.1 Record + compare, don't just print

Each paid runner already writes `<name>_latest.json` to the git-ignored `reports/`
(`outward_runner.py:192`, `coherence_runner.py:202`). Add a **committed**
`apps/modal-backend/tests/eval_baselines/<name>.json` holding the *last accepted* summary
(means + n + commit sha + date). A new helper `tests/_baseline.py compare(name, summary)`:

```
status = compare("outward_drift", report["summary"])
#   PASS       : metric >= baselines.min                         (absolute floor)
#   REGRESSION : metric <  baseline.mean - regression_band       (dropped vs accepted baseline)
#   IMPROVED   : metric >  baseline.mean + regression_band       (offer to re-baseline)
#   LOW_N      : summary.n < baselines.n_min                     (don't trust, don't gate)
```

`compare` is **pure** → unit-tested free with synthetic summaries (same discipline as
`summarize`). Only the *recording* of a new baseline spends; the *comparison logic* is free and
covered every commit.

### 3.2 Re-baselining is an explicit, reviewed act

A drift guard is only honest if the baseline can't silently drift up with noise. Rule:
`reports/<name>_latest.json` is an artifact; promoting it to
`tests/eval_baselines/<name>.json` is a **manual `make eval-baseline-accept NAME=outward_drift`**
that copies latest→committed and stamps the sha. So every baseline move is a reviewable diff
with provenance — the "golden version" concept ([baseline testing](https://www.virtuosoqa.com/post/baseline-testing)),
kept under version control rather than recomputed from drifting runs.

### 3.3 Adaptive band, not a single fixed cliff

The VLM-judge literature warns a single absolute threshold is brittle (calibration error is
nontrivial; §5). So the guard's *primary* signal is **relative** (drop vs. the committed
baseline mean by more than `regression_band`), with the absolute `min` as a backstop. This
matches the model-drift guidance to *"adopt adaptive baselines that adjust to typical
performance rather than fixed thresholds, reducing false alarms while catching real issues"*
([model drift](https://magai.co/how-to-detect-and-manage-model-drift-in-ai/)). Concretely the
band ≈ the run-to-run judge noise: estimate it once from 3 repeat runs of the same fixtures and
set `regression_band` to ~1× its stdev (for the 0–10 judges, ~1.0 is a sane start, matching the
`outward` precedent).

## 4. Design: the multi-hop drift runner (Risk #1, currently unmeasured)

`outward_runner.py` measures one hop. The design's stated risk is **compounding drift across
MANY hops** (`PLAN_OUTWARD.md:118, 123`), which the autoregressive-generation literature
confirms is the real failure mode: *"exposure bias causes compounding errors as generated frames
become the context for future steps; initial inaccuracies compound over time"*
([Pathwise](https://arxiv.org/html/2602.05871), [BAgger](https://arxiv.org/pdf/2512.12080)).
Measure it directly.

### 4.1 `tests/continuity_bench/chain_runner.py` (new, paid, on-label)

Model it on `outward_runner.py` (reuse `_load_env`, `score_style_pair`, the `reports/` +
`summarize` shape):

1. Generate one styled source at the finest rung of a chain (e.g. `place`).
2. Walk OUTWARD **k hops** (`place→district→city→region→world`, picked via
   `model_router.coarser_tier`, `model_router.py:75`), each hop the real ascend op
   (`select_outward_op`, `:94`) conditioned on the *previous hop's output* — i.e. the actual
   compounding path, not k independent single hops.
3. After each hop `i`, score **two** things with the existing judge:
   - `drift_from_source[i] = score_style_pair(source, hop_i)` — absolute medium-faithfulness
     vs. the *original* (does the chain wander off the starting medium?);
   - `drift_step[i] = score_style_pair(hop_{i-1}, hop_i)` — per-hop loss (where the wandering
     happens).
4. `summarize`: `mean_drift_per_hop`, `total_drift = source_score − final_hop_score`, and a
   **`half_life`** = the hop index where `drift_from_source` first crosses a floor. The pure
   `summarize` is the gate brain; unit-test it on synthetic score sequences.

### 4.2 Why this is the right shape

- It reuses the exact reparent/ascend ops the product uses (`select_outward_op`,
  `expand_image_zoomout`, the `scale_parent` fresh path), so the number describes the real
  feature, not a proxy.
- It turns Risk #1 into a **trend with a stopping rule**: the gate isn't "is hop 5 good" (a
  single VLM score, noisy) but "**how many hops until drift exceeds the band**" — a far more
  robust signal, and exactly the *relative-ranking* use the VLM literature endorses (§5). The
  product rule falls out of it: cap auto-OUTWARD at `half_life − 1` hops, or force a
  style-anchor refresh / human checkpoint there.
- A symmetric DEEPER chain (`world→…→object`) measures the inward direction; the deterministic
  side is already covered by `INV-1` (reparent moves no leaf, `PLAN_OUTWARD.md:51-57`) and
  `tierTransitionValid` (INV-2, `index.ts:50`) — so the chain runner only needs to add the
  *visual* drift number the deterministic invariants can't see.

### 4.3 Mirror it deterministically (free) where possible

Drift has a **metric** half and a **visual** half. The metric half is free: a free TS test
walking a k-hop reparent chain and asserting `resolveAbsolutePos(leaf)` is byte-identical
before/after (INV-1) and every hop passes `tierTransitionValid` (INV-2) catches *coordinate*
drift with zero spend. The chain runner then only spends on the *pixel-medium* half the
deterministic checks can't measure. This is the §6 layering: push everything that can be a
deterministic invariant into the free tier; spend VLM budget only on the genuinely perceptual
residue.

## 5. VLM-as-judge: use it as a ranker, gate on lifts and trends

The harness leans on a VLM judge (`_score.py _ask_judge`, Gemini default, `temperature=0.0`,
JSON `{score, rationale}`, `_score.py:48-101`). The literature is consistent on how far to
trust it, and the existing design already mostly does the right thing:

- **Strong but imperfect correlation with humans** (Spearman ~0.57–0.70 on coherence/relevance;
  artifact agreement lags human–human) and a **positive bias that under-penalizes misaligned
  layouts / glitches** ([ImagenWorld](https://arxiv.org/pdf/2603.27862),
  [VLM-as-a-Judge](https://www.emergentmind.com/topics/vlm-as-a-judge-protocol)). → **Gate on
  A/B *lifts* and *trends*, not absolute scores.** OFB already does this for `style`,
  `layout`, `coherence` (all report `lift = with − without`); the positive bias largely cancels
  in a paired A/B. The `outward` and `chain` runners should likewise prefer the **relative**
  drop-vs-baseline signal (§3.3) over the absolute floor.
- **Interpret as relative rankings; consistent ordering is the reliable part** ([protocol](https://www.emergentmind.com/topics/vlm-as-a-judge-protocol)).
  → the §4 `half_life` (an *ordering* over hops) is more trustworthy than any single hop's score.
- **Inter-judge agreement is moderate (κ≈0.37–0.69)**; consensus / self-verifying framings beat
  a single scalar self-rating. → cheap hardening for the gating runs (not every dev run):
  average **2–3 judge samples** (or 2 judge models) per pair and record the stdev; that stdev
  *is* the empirical `regression_band` (§3.3). Keep `temperature=0.0` for the per-dev run;
  reserve multi-sample for baseline-acceptance runs.
- **Rubric specificity matters** — fine-grained rubrics calibrate VLM judges. OFB's prompts are
  already specific and medium-focused ("ignore subject, score style only",
  `_score.py:91`; the 10/5/0 anchors in `score_continuation`, `:137`). Keep that; it is the
  single biggest lever on judge reliability.

## 6. How the two layers fit (the operating contract)

```
free, every commit  (make eval, -m "not paid")
  ├─ correctness: geometry_checks anchors, solver goldens, projection golden, parity, fuzz
  ├─ NEW: every solver/projection golden output also asserted issue-free by check_geo_entities
  ├─ NEW: test_eval_baselines.py — baselines file parses + each summarize() emits its metric
  └─ NEW (free metric half of drift): k-hop reparent INV-1 + INV-2 chain test (no spend)

paid, on-label  (make eval-<name>, *_BENCH_RUN=1; manual / nightly / pre-release)
  ├─ existing: layout, grounding, coherence, style, outward-drift
  ├─ NEW: chain_runner.py — multi-hop OUTWARD/DEEPER visual drift + half_life
  └─ each run: compare(summary) vs committed tests/eval_baselines/<name>.json
              → PASS / REGRESSION / IMPROVED / LOW_N ; promote only via make eval-baseline-accept
```

**Principle (load-bearing):** anything expressible as a deterministic invariant goes in the
free tier and runs every commit (coordinates, cycles, tier monotonicity, schema parity,
footprint>0); VLM budget is spent **only** on the perceptual residue (medium faithfulness,
layout plausibility, continuation), gated on **lifts and drop-vs-baseline**, never on a single
absolute score. The free tier catches regressions cheaply and continuously; the paid tier,
run on a label with committed baselines, catches the perceptual drift the invariants are blind
to — and the multi-hop chain runner finally puts a number on Risk #1.

---

### Sources
- [Metamorphic relation prioritization for regression testing](https://arxiv.org/pdf/2109.09798)
- [Baseline testing — definition, types, best practices (golden version)](https://www.virtuosoqa.com/post/baseline-testing)
- [How to detect & manage model drift (adaptive baselines vs fixed thresholds)](https://magai.co/how-to-detect-and-manage-model-drift-in-ai/)
- [ImagenWorld: explainable human eval, VLM positive bias / under-penalised layout glitches](https://arxiv.org/pdf/2603.27862)
- [VLM-as-a-Judge protocol (relative-ranking reliability, inter-judge κ, rubric calibration)](https://www.emergentmind.com/topics/vlm-as-a-judge-protocol)
- [Pathwise test-time correction (compounding drift in autoregressive generation)](https://arxiv.org/html/2602.05871)
- [BAgger: backwards aggregation for mitigating drift](https://arxiv.org/pdf/2512.12080)
