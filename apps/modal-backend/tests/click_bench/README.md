# Click-resolver bench

Measures the thing the whole product rides on: given a tap on an illustration,
does the VLM name the right subject — and does it *refuse* to name one when the
tap lands on empty space?

## Metrics

Per model, over a fixture set:

- **Subject pass** — fraction of *groundable* taps whose predicted subject
  matches the human label (composite ≥ 0.6 of fuzzy + Jaccard string sim).
- **Composite** — mean similarity over groundable taps.
- **Rejection recall** — of the taps on empty space / decoration
  (`groundable: false`), how many the VLM correctly flagged
  `groundable=false` instead of confabulating. This is the groundability
  gate's report card.
- **Groundable accuracy** — predicted vs expected groundability over all
  completed (non-errored) cases.
- **p50 ms** — median resolver latency.

Subject metrics are computed over `groundable: true` cases only, so a
deliberate empty-space case can't deflate them.

## Run it

Single model (defaults to `OPENROUTER_VLM_MODEL`):

```bash
cd apps/modal-backend
OPENROUTER_API_KEY=... .venv/bin/python -m tests.click_bench.runner \
  --fixtures tests/click_bench/fixtures/synthetic.json \
  --out tests/click_bench/reports/latest.json
```

Multi-model leaderboard (the "which VLM should I use" table). `--runs N`
repeats each model N times and reports **mean ± stdev** — VLM click resolution
is non-deterministic, so a single run can't rank models that sit close together:

```bash
OPENROUTER_API_KEY=... .venv/bin/python -m tests.click_bench.leaderboard \
  --fixtures tests/click_bench/fixtures/v1.json \
  --runs 3 \
  --models google/gemini-3-flash-preview,openai/gpt-4o,openai/gpt-4o-mini,qwen/qwen3-vl-8b-instruct \
  --out tests/click_bench/reports/leaderboard.md
```

Both hit a real VLM (one call per case per model per run), so they need a key and
are never run by the default `pytest`. With the multi-provider change you can
bench a local model too — set `LLM_PROVIDER=custom` + `LLM_BASE_URL` first.

## Fixtures

- `fixtures/synthetic.json` — deterministic labelled boxes/circles from
  `_gen_synthetic.py`. They make the bench runnable from a cold start; they are
  **not** a real signal. Regenerate with
  `python -m tests.click_bench._gen_synthetic`.
- `fixtures/v1.json` — **real illustrations**: 20 cases over three generated
  fantasy maps from live sessions (`images/real/`), 17 groundable taps + 3
  blank-parchment rejection cases. Tap points are detector-verified entity
  centroids, each eyeballed against the rendered map (several maps print the
  feature name in-image, so ground truth is human-checkable). See
  `_meta.how_to_add_cases` to extend it.

## Latest leaderboard (2026-07-05, `fixtures/v1.json`, 20 cases, **3 runs, mean±stdev**)

Reports land in the gitignored `reports/`; this snapshot is the durable record.
Run cost: ~$0.71 for this 3-run × 4-model × 20-case pass. gemini-2.5-pro is
excluded — an earlier run established it echoes the page title verbatim on every
tap (0% pass, stable); running it three more times is wasted spend.

| Model | Subject pass | Composite | Rejection recall | Groundable acc | p50 ms | ~$/tap |
| --- | --- | --- | --- | --- | --- | --- |
| openai/gpt-4o-mini | 78% ±3 | 0.749 ±0.026 | 0% | 85% | 4745 | $0.0057 |
| google/gemini-3-flash-preview | 76% ±0 | 0.757 ±0.006 | 44% ±19 | 92% ±3 | 4530 | $0.0010 |
| openai/gpt-4o | 75% ±3 | 0.752 ±0.025 | 0% | 85% | 5451 | $0.0047 |
| qwen/qwen3-vl-8b-instruct | 73% ±3 | 0.697 ±0.029 | 0% | 85% | 2588 | $0.0003 |

`~$/tap` = avg prompt tokens (incl. the image) × input price + ~60 output ×
output price, at early-2026 OpenRouter rates.

**What the denoised run shows:**

- **The four grounders are statistically tied on subject accuracy.** 73–78% pass
  / 0.70–0.76 composite, all with overlapping ±stdev. Three runs confirm what a
  single run couldn't: there is no meaningful gap between gpt-4o-mini, gemini-3-flash
  and gpt-4o at grounding a tap on these maps. Don't read the #1 row as a winner.
- **gemini-3-flash wins on *reliability*, not raw pass.** Identical subject-pass on
  all three runs (±0), tightest composite (±0.006), the best groundable-accuracy
  (92%), and the **only model that rejects a blank tap at all** (44% vs 0%). For a
  click path where a wrong-but-confident subject spawns a garbage page, "stable +
  knows when it's lost" beats a point of raw accuracy.
- **A small open model holds up.** `qwen3-vl-8b-instruct` is within a few points of
  the frontier and **20× cheaper per tap** than gpt-4o-mini, at the lowest latency
  (2.6s). A serious default-click candidate — the bench's central "does a small VLM
  ground a tap" question answers *yes*.
- **Nothing rejects a blank tap except gemini-flash.** Rejection recall is 0% for
  three of four models across all runs — tap empty parchment and the resolver
  confabulates a nearby named feature instead of flagging `groundable=false`. The
  groundability gate is the product's weakest link, now measured.
- **gpt-4o-mini is secretly the costliest.** It bills ~37k tokens per tap — OpenAI
  mini models apply a ~33× image-token multiplier — versus ~1.7k for every other
  model. Despite the cheapest per-token price it lands at ~$0.0057/tap, pricier
  than full gpt-4o. Cheapest-looking ≠ cheapest on images.

**Still small (20 cases).** Three runs pin the variance (the ± columns), so the
"they're tied" conclusion is trustworthy; a *finer* ranking would need more cases,
not more runs. The five new v1 cases deliberately include hard "named water" taps
(harbor channel, crescent basin) that pulled every model down from the 15-case set.

## Not covered yet

Continuity-bench (`../continuity_bench/`) still needs a real captured session —
its fixtures can't be synthesised meaningfully. Capture one from a live run and
drop it in per that bench's `manifest.json` `_meta`.
