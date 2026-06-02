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
- `fixtures/v1.json` — real illustrations (empty until you add some). This is
  where a meaningful leaderboard comes from. See its `_meta.how_to_add_cases`:
  drop the illustration in `fixtures/images/`, pick a tap point, write the
  expected subject, and add a few `groundable: false` cases (sky, gaps,
  decoration) so the rejection metric has teeth.

## Not covered yet

Continuity-bench (`../continuity_bench/`) still needs a real captured session —
its fixtures can't be synthesised meaningfully. Capture one from a live run and
drop it in per that bench's `manifest.json` `_meta`.
