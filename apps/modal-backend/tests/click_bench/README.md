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

Multi-model leaderboard (the "which VLM should I use" table):

```bash
OPENROUTER_API_KEY=... .venv/bin/python -m tests.click_bench.leaderboard \
  --fixtures tests/click_bench/fixtures/synthetic.json \
  --models google/gemini-3-flash-preview,qwen/qwen3-vl-8b-instruct,openai/gpt-4o \
  --out tests/click_bench/reports/leaderboard.md
```

Both hit a real VLM (one call per case per model), so they need a key and are
never run by the default `pytest`. With the multi-provider change you can bench
a local model too — set `LLM_PROVIDER=custom` + `LLM_BASE_URL` first.

## Fixtures

- `fixtures/synthetic.json` — deterministic labelled boxes/circles from
  `_gen_synthetic.py`. They make the bench runnable from a cold start; they are
  **not** a real signal. Regenerate with
  `python -m tests.click_bench._gen_synthetic`.
- `fixtures/v1.json` — **real illustrations**: 15 cases over three generated
  fantasy maps from live sessions (`images/real/`), 12 groundable taps + 3
  blank-parchment rejection cases. Tap points are detector-verified entity
  centroids, each eyeballed against the rendered map (several maps print the
  feature name in-image, so ground truth is human-checkable). See
  `_meta.how_to_add_cases` to extend it.

## Latest leaderboard (2026-07-05, `fixtures/v1.json`, 15 cases)

Reports land in the gitignored `reports/`; this snapshot is the durable record.
Single run per model — treat as **indicative, not definitive** (see caveat).

| Model | Subject pass | Composite | Rejection recall | Groundable acc | p50 ms | ~$/tap |
| --- | --- | --- | --- | --- | --- | --- |
| google/gemini-3-flash-preview | 92% | 0.856 | 67% | 93% | 5372 | $0.0010 |
| openai/gpt-4o-mini | 92% | 0.857 | 0% | 80% | 4339 | $0.0057 |
| qwen/qwen3-vl-8b-instruct | 92% | 0.814 | 0% | 80% | 3495 | $0.0003 |
| openai/gpt-4o | 83% | 0.775 | 0% | 80% | 6572 | $0.0047 |
| google/gemini-2.5-pro | 0% | 0.223 | 0% | 80% | 7305 | $0.0037 |

`~$/tap` = avg prompt tokens (incl. the image) × input price + ~60 output ×
output price, at early-2026 OpenRouter rates.

**What holds across runs (real signal):**

- **The top four cluster within noise.** gemini-3-flash, gpt-4o-mini, qwen3-vl-8b
  and gpt-4o all land ~0.78–0.86 composite / 83–92% pass. Which one tops the
  table flips between runs (an earlier run on the same fixtures had gpt-4o at 92%
  and gemini-flash at 75%) — 15 cases × single run can't separate them. Don't
  read the #1 row as a winner.
- **A small open model holds up.** `qwen3-vl-8b-instruct` grounds as well as the
  frontier models here and is **20× cheaper** than gpt-4o-mini per tap. For the
  default click path it's a serious option — the README's central "does a small
  VLM ground a tap" question answers *yes* on these maps.
- **gemini-2.5-pro doesn't ground — it echoes the page title.** 0% pass, and its
  prediction for every tap is the parent map's title verbatim ("Crescent Bay
  Fishing Village"). A stable, reproducible failure mode; do not use it here.
- **Almost nothing rejects a blank tap.** Rejection recall is 0% for four of five
  models — tap empty parchment and the resolver confabulates a nearby named
  feature instead of flagging `groundable=false`. Only gemini-flash rejects
  (33–67% across runs). The groundability gate is the weakest link the product
  rides on, and this bench now measures it.
- **gpt-4o-mini is secretly the costliest.** It bills ~37k tokens per tap — OpenAI
  mini models apply a ~33× image-token multiplier — versus ~1.7k for every other
  model. Despite the cheapest per-token price it lands at ~$0.0057/tap, pricier
  than full gpt-4o. Cheapest-looking ≠ cheapest on images.

**Caveat:** VLM click resolution is non-deterministic and the set is small (15).
For a ranking you'd act on, grow the fixtures and average ≥3 runs per model.

## Not covered yet

Continuity-bench (`../continuity_bench/`) still needs a real captured session —
its fixtures can't be synthesised meaningfully. Capture one from a live run and
drop it in per that bench's `manifest.json` `_meta`.
