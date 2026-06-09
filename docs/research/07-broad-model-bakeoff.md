# 07 — Broad model bakeoff (we tried the field)

Run 2026-06-09. Roster: incumbents (`nano-banana-pro`, `seedream-v4`) + the field requested
(`gpt-image-2` [fal], `recraft-v4.1-utility`/`-pro` [OpenRouter], `riverflow-v2.5-fast`/`-pro`
[OpenRouter]). Each generated the 2 canonical layout scenes WITH the geometry layout clause;
Gemini-judged layout fidelity. Both provider paths verified — fal `subscribe_async`, and the
OpenRouter image path (`chat/completions` with `modalities:["image"]` → base64 data-URL at
`choices[0].message.images[0]`). 14 generations, all succeeded, 0 errors. Spend incl. smokes
≈ **$2** of the ~$25 budget. Harness: `scripts/bakeoff/models_bakeoff.py` (reusable — add a
`{provider, slug}` to the roster).

## Layout fidelity (with clause), ranked

| # | model | provider | mean fidelity | ~$/img |
|---|---|---|---|---|
| 1 | riverflow-v2.5-pro | OpenRouter | 0.988 | from $0.24 |
| 2 | gpt-image-2 | fal | 0.982 | ~$0.01–0.40 |
| 3 | seedream-v4 | fal | 0.966 | ~$0.03 |
| 4 | riverflow-v2.5-fast | OpenRouter | 0.956 | from $0.02 |
| 5 | **nano-banana-pro** (incumbent) | fal | 0.955 | $0.139 |
| 6 | recraft-v4.1-utility | OpenRouter | 0.950 | $0.04 |
| 7 | recraft-v4.1-pro | OpenRouter | 0.943 | $0.25 |

**The spread is tight (0.94–0.99): with the layout clause, every model complies.** That
re-confirms (`06`) the clause is the real, model-independent lever — on layout alone the
incumbent is not meaningfully behind. `riverflow-v2.5-pro` + `gpt-image-2` edge ahead but inside
the N=2, single-run, ranker-judge noise (`05`).

## Qualitative — the axis the judge misses (eyeballed the saved images)

Lighthouse-coast (soft-watercolour brief):
- **riverflow-v2.5-pro** — the standout: most polished, richest detail, and it **held the
  watercolour medium** best. The one most worth piloting.
- **gpt-image-2** — high quality but **medium-drifts** (reads as oil / digital painting, not soft
  watercolour) — a style-lock risk for the medium-consistency requirement.
- **nano-banana-pro** (incumbent) — true watercolour, correct placement, lower detail. A safe,
  on-medium baseline.
- **recraft** — competent placement, unremarkable on these (label-free) scenes; its real strength
  is typography, which these scenes don't exercise (see caveat).

## Honest caveats

- **These scenes test placement, not map LABELS.** The text/typography axis — exactly where
  Recraft + gpt-image-2 are built to win, and what legible maps need — is UNTESTED here. So this
  run says "the field is viable, the clause works universally, riverflow-pro looks best on
  quality + medium," NOT "model X is best for labelled maps."
- N=2 scenes, single run, Gemini ranker (Spearman ~0.6, under-penalizes misalignment) — the
  ranking is directional, not calibrated.
- Cost varies ~10×: riverflow-pro / recraft-pro ($0.24–0.25) vs riverflow-fast / recraft-utility
  ($0.02–0.04) vs nano-banana-pro ($0.139); riverflow-pro is dynamic per-job.

## Price-to-effect

Because the layout clause **saturates** fidelity (~0.95–0.99 for everyone), effect barely varies —
so the ratio is dominated by price. Fidelity-per-dollar (illustrative; effect = layout fidelity
only, the one axis measured):

| model | fidelity | ~$/img | fidelity/$ |
|---|---|---|---|
| gpt-image-2 (*low* quality) | 0.982 | ~$0.01 | ~98 |
| riverflow-v2.5-fast | 0.956 | ~$0.02 | ~48 |
| seedream-v4 | 0.966 | ~$0.03 | ~32 |
| recraft-v4.1-utility | 0.950 | $0.04 | ~24 |
| **nano-banana-pro (default)** | 0.955 | $0.139 | **~6.9** |
| riverflow-v2.5-pro | 0.988 | $0.24 | ~4.1 |
| recraft-v4.1-pro | 0.943 | $0.25 | ~3.8 |

Headline: **the current default (`nano-banana-pro`) is mid-pack on effect but ~7× worse
price/effect than the cheap-compliant models** (riverflow-fast, seedream, recraft-utility,
gpt-image-2-low), which match its layout fidelity at a fraction of the cost. The premium tier
(riverflow-pro / recraft-pro) buys ~nothing *on layout* for ~2× the cost — its value, if any, is
on the medium / label / polish axes this run didn't isolate.

### How to optimize it

1. **Wire the layout clause in (Branch 2 P1) — it's free effect.** A text addition, $0 marginal,
   the single biggest lever (+0.33, model-independent). Optimize this before touching models.
2. **Re-price the tiers to the job.** The `fast`/`balanced`/`pro` tier system already exists; the
   default is just mispriced. For the bulk fresh-map render (where layout, not ultra-polish, is the
   goal) a cheap-compliant model — gpt-image-2 at explicit *low* quality, seedream, or
   riverflow-fast — delivers equal layout fidelity at ~5–10× lower cost than the nano-banana-pro
   default.
3. **Pay premium only on the final artifact.** Reserve riverflow-v2.5-pro (best quality + medium)
   for the pinned/final render, not every hop. The existing `PROGRESSIVE_DRAFT` feature already
   fits: draft cheap, finalize premium.
4. **Pin gpt-image-2's quality knob.** It spans $0.01→$0.40 by quality; default it to low/standard
   for drafts so it stays in the high-value zone.
5. **Spend the model budget on the UNSATURATED axis.** Layout is solved by the (free) clause;
   medium fidelity + label legibility are not. The labelled-map A/B (the follow-up) is where extra
   model spend can actually move effect — measure there before paying premium per render.

## Recommendation

1. **We tried the field — it works**, and the layout clause is the dominant, model-independent
   lever (so `06`'s "wire `expected_layout` into the render" call holds regardless of model).
2. **Pilot `riverflow-v2.5-pro`** as an alternate fresh-map render (best quality + medium
   adherence); keep `nano-banana-pro` the safe default. fal models are already swappable
   (tier / `model_override` / `FAL_IMAGE_MODEL_BALANCED`); Recraft/Riverflow are OpenRouter, so a
   first-class alternate needs the new OpenRouter image path this harness proves out.
3. **Follow-up to actually pick a MAP model:** a labelled-map A/B (map prompts with named
   features) + a label-legibility + medium judge — the harness is ready; swap the scene set and
   add the judge axis. That's where `gpt-image-2` / `recraft` earn or lose their place.

Images are under `scripts/bakeoff/out/` (gitignored — regenerable, per the repo's no-tracked-media
guard). `report.json` carries the raw numbers.
