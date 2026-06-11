# What a tap costs — model prices, per-operation cost, and where the time goes

Prices verified June 2026 (fal model pages + OpenRouter). Token counts are
real, pulled from this repo's own `prompt_tokens` logs. Two headline facts up
front:

1. **Image generation is ~99% of the dollars.** Every Gemini call (judge,
   extraction, planner) is ~$0.001–0.002. Even the enter path's eleven of them
   add up to ~2¢. The fal image call is the bill.
2. **The slowness you feel is call COUNT and re-uploads, not price.** An enter
   fires up to 13 sequential model calls and re-uploads the full-res page to
   fal storage on every attempt. On a fast link it's hidden; on a hotspot the
   dead time is the whole video. See "Where the time goes" at the bottom.

## The models we call (slug → price → budget alternative)

### Image (fal) — the dollar driver

| Slot / tier | Default slug | Price | Budget alternative | Budget price |
|---|---|---|---|---|
| fresh `fast` | `fal-ai/nano-banana` | **$0.039**/img | — (already the floor) | — |
| fresh `balanced` (default) | `fal-ai/nano-banana-pro` | **$0.15**/img (1K-2K; 4K $0.30; +$0.015 web search) | `fal-ai/nano-banana-2` | $0.08/img |
| fresh `pro` | `openrouter:sourceful/riverflow-v2.5-pro` | **~$0.24**/img (+152s) | `nano-banana-pro` | $0.15 |
| enter (`enter_scene`) | `fal-ai/nano-banana-pro/edit` | **$0.15**/img | `nano-banana-2/edit` | $0.08 |
| inpaint (`inpaint`) | `fal-ai/flux-pro/v1/fill` | **$0.05/MP** → ~$0.10/edit at 16:9 | none — it's the only true compositor (the mask smoke proved gpt/nano don't honor masks); lower the resolution to drop the MP | scales with px |
| zoom (`zoom_continue`) | `fal-ai/flux-pro/kontext` | **$0.04**/img | — | — |
| outpaint (`outpaint`) | `fal-ai/bria/expand` | **~$0.04**/img | — | — |

Every slot already takes an env override (`FAL_*_MODEL`, and the tier keys
`FAL_IMAGE_MODEL_FAST/BALANCED/PRO`, `FAL_EDIT_MODEL_*`) — the "budget
alternative" column is just a documented value for those.

### Text / VLM / judge (OpenRouter) — pennies, but they stack up in COUNT

| Role | Default | Price | Budget alternative | Budget price |
|---|---|---|---|---|
| planner / instruction polish | `google/gemini-3-flash-preview` | **$0.50/M in · $3/M out** | `google/gemini-3.1-flash-lite-preview` | **$0.25 / $1.50** (½) |
| VLM (click resolve, extract, detect, view) | same | same | flash-lite | ½ |
| judges (conformance / same-place / detail / medium / alignment) | same (`CONTINUITY_BENCH_JUDGE_MODEL` override) | same | flash-lite | ½ |

Observed cost per call (from this repo's logged `prompt_tokens`, Gemini 3 Flash):
- instruction polish (`polish_fill` 164 tok in): **~$0.0003**
- planner (`plan_page` ~680 in): **~$0.0012**
- click resolver (`click_to_subject` ~2100 in): **~$0.0017**
- extraction (`extract_entities` ~2400 in): **~$0.0024**
- one judge (image + ~1800 in): **~$0.0015**

Switch all of these to flash-lite and the OpenRouter bill halves — but it's
already <2% of the total, so the win is marginal. The judges' real cost is
**latency**, not dollars.

## What each operation costs (balanced default, GEOMETRIC_WORLD on)

| Operation | fal calls | OpenRouter calls | ≈ cost | the calls |
|---|---|---|---|---|
| **Fresh map** | 1 × $0.15 | 4 | **$0.16** | plan + extract + detect + view |
| **Enter (1 attempt)** | 1 × $0.15 | 9 | **$0.16** | click + plan + **4 judges** + 3 extraction |
| **Enter (2 attempts)** | 2 × $0.15 | 13 | **$0.32** | + 1 edit + **4 more judges** |
| **Mask edit (1 attempt)** | 1 × ~$0.10 | 5 | **$0.11** | polish + **2 judges** + 2 extraction |
| **Mask edit (2 attempts)** | 2 × ~$0.10 | 7 | **$0.21** | + 1 inpaint + **2 more judges** |
| **Judged whole-image edit** | 1 × $0.15 | 5 | **$0.16** | polish + 2 judges + 2 extraction |
| **Extraction (after EVERY final)** | 0 | 1–3 | **~$0.006** | extract (+ detect + view if geo) |

**A full demo run** (map + 1 mask edit + 2 enters, ~1.5 attempts each) ≈
**$0.6–1.0**. The Ankh-Morpork re-shoot's ~10 takes was ~$6–9 of fal, almost
all of it nano-banana-pro/edit on the enters.

### A budget profile (env, no code change)

```sh
# Cheaper images everywhere (≈4× on fresh/edit, the enter is the big one):
FAL_IMAGE_MODEL_BALANCED=fal-ai/nano-banana-2     # $0.15 -> $0.08
FAL_EDIT_MODEL_BALANCED=fal-ai/nano-banana-2/edit
FAL_ENTER_MODEL=fal-ai/nano-banana-2/edit
# Half-price judges/VLM (marginal $, but flash-lite is also faster):
CONTINUITY_BENCH_JUDGE_MODEL=google/gemini-3.1-flash-lite-preview
OPENROUTER_VLM_MODEL=google/gemini-3.1-flash-lite-preview
# Fewer judged retries (latency + $):
VIEW_LOOP_MAX_ATTEMPTS=1
EDIT_LOOP_MAX_ATTEMPTS=1
```
That roughly halves both the dollars and the call count — a demo run drops to
~$0.3–0.5 and noticeably fewer round-trips.

## Where the time goes (the "video is ass" diagnosis)

Dollars are fine; **wall-clock is the product problem**, and it's structural:

1. **Full-res re-upload to fal, every attempt.** `to_fal_url` uploads the
   ~2-3 MB page (and the mask) to fal storage on each edit/enter *and re-does
   it per retry attempt* — no memoization. On a hotspot that was a measured
   **3.5 min** for one ferry edit. **Biggest single win: upload once per
   request, reuse the URL across attempts.** (Real, mergeable fix.)
2. **Judges are sequential.** ~~An enter runs 4 judges per attempt, one after
   another (~2-5s each), up to 2 attempts = up to 8 VLM round-trips before the
   image is accepted.~~ **Shipped:** `judge_concurrently()` gathers them
   (render_loop + edit_loop) — judge wall-clock per attempt is now the
   slowest single judge, not the sum. And the speed preset's `verify:false`
   skips them entirely per request.
3. **Extraction blocks the felt-ready moment.** 3 VLM calls (~15-25s) fire
   after every final before the codex/geo are populated. Already fire-and-
   forget for the image, but the next interaction's geo isn't ready until it
   lands.

So the honest fix for a *snappier* demo isn't a cheaper model — it's: cache
the upload, parallelize the judges, and a one-shot fast mode. The budget
profile above is the cheap-and-fast lever today; the upload cache + concurrent
judges are the code wins worth doing next.

Sources: fal model pages (nano-banana-pro $0.15, nano-banana-2 $0.08,
flux-pro/v1/fill $0.05/MP, flux-pro/kontext $0.04, nano-banana $0.039),
OpenRouter (gemini-3-flash-preview $0.50/$3, gemini-3.1-flash-lite $0.25/$1.50),
repo `prompt_tokens` logs + Makefile eval cost anchors (eval-view ~$2.5,
eval-edit-region ~$1, mask-smoke ~$0.5).

## The live meter (`providers/spend.py`)

The backend now keeps a running **estimate** of spend using the prices above:
each generation records its image calls by model slug + a flat ~$0.02 for the
VLM stack. The session total rides every `final` frame
(`session_spend_estimate`) and shows next to the toolbar's cost chip;
`MAX_DAILY_SPEND` (dollars) turns the daily total into a hard gate — streams
refuse with a clear error once today's estimate crosses it.

Honest limitations: totals are **in-process** (per container, reset on
restart, not shared across replicas) and **estimates** (the slug price table
above, not provider invoices). Right-sized for a self-hosted cap; don't bill
anyone off it.

One more cap honesty note: the gate is checked at stream start, so requests
already in flight when the cap trips still complete — worst case overshoot is
one generation per concurrent stream. Right-sized for a personal cap.
