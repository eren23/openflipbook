# 00 — Consistency research: the decisions that parameterize Branch 2

Purpose: turn the consistency/geometry questions into concrete, code-grounded decisions
so Branch 2 (`feat/systematic-consistency`) builds the right thing. Each call below is
either CONFIRMED (code + literature agree) or PENDING the paid bakeoff (`01`'s design).
Detail + sources in `01`–`05`.

## The verdicts

**Models per task** (`01`). Keep `nano-banana-pro` (fresh map + entity-edit — the one path
where the style ref + identity actually work), `flux-pro/kontext` (zoom-continue/DEEPER),
`bria/expand` (directional map-pan). The reference-image "no-op" is **endpoint-specific**, not
model-wide: fal *text-to-image* slugs ignore `image_urls`; the *`/edit`* slugs honour them (up
to 14 refs + identity). So the one model call to **change** is OUTWARD `scale_parent_fresh` —
today it passes a ref through the text-to-image endpoint (a no-op) → route it through the edit
endpoint (or drop the inert ref). [confirmed by code + fal docs]

**Update (`07`, paid broad bakeoff):** tried the whole field — gpt-image-2, Recraft v4.1,
Riverflow v2.5 vs the incumbents. The layout clause saturates fidelity for ALL of them (tight
0.94–0.99), so effect is model-independent and the ratio is dominated by price. The current
default `nano-banana-pro` is ~7× worse price/effect than the cheap-compliant models
(riverflow-fast / seedream / gpt-image-2-low) at equal layout fidelity; `riverflow-v2.5-pro` leads
on quality + medium (pilot it for the final render). Re-price the tiers; pay premium only on the
final artifact; the label-legibility axis is the untested follow-up. Price-to-effect table in `07`.

**Prompting** (`02`). The MEDIUM-LOCK *text* clause is the universal style workhorse (refs only
bite on edit paths). Coordinate constraints should stay **coarse relative bins** (`h_pos`/`v_pos`/
`size`), never raw `x_pct` — Gemini-class structured prompting reports >90% spatial compliance on
relative/grid language; numeric coords are untested. Whether our `layout_constraints` bins
*actually* steer the fresh render is the **single most decision-relevant unknown** → the S5 A/B
(feed the bins into the fresh nano-banana-pro render, score with the existing `grounding.diff`).
[PENDING bakeoff]

**Coordinate injection + entity edits** (`03`). Keep the coordinate-free LLM boundary — the
LLM emits relations, the deterministic solver computes coordinates (Open-Universe confirms
LLM-emitted metric coords perform poorly; this is the right architecture). Hosted-API gen can't
use ControlNet/GLIGEN spatial control, so bins + the grounding loop are the available levers.
Make entity add/move/update/delete **verifiably faithful** with a project→apply→re-project→
detect-diff loop (assert the edited entity moved and the others didn't). [confirmed]

**Recursion** (`04`). The pipeline is linear at the top with recursion contained in two places:
the solver's relation fixpoint, and a one-level persisted frame tree (DEEPER learns
`parent.footprint/localExtent`; OUTWARD reparents up `SCALE_LADDER`). The honest gap: B1's
`inside` is flat-v1 (the `parent_id` + learned-`scale` model exists but the solver emits
`parent_id:null`). Recommendation: promote `inside` to the DEEPER nesting model (small solver
change, already guarded by `geometry_checks` cycle/parent/scale invariants); cap **~2 frame
levels per render**, unbounded in the persisted tree (log-space, cycle-guarded). [confirmed by
hierarchical-scene literature: 3–4 semantic levels, constraints enforced per level]

**Baseline methodology** (`05`). Layer the checks: deterministic anchors (`geometry_checks` +
INV-1/INV-2 chains) run **free every commit**; VLM-judged evals spend only on the perceptual
residue, **on a label**. Two missing pieces designed: (a) a baseline-drift guard (committed
`tests/eval_baselines.json` thresholds + a free schema/threshold check + a paid compare), and
(b) a multi-hop `chain_runner.py` that walks k real OUTWARD/DEEPER hops and reports a
**`half_life`** (hops until drift crosses a floor — Risk #1, currently unmeasured). Gate on
**relative lifts + drop-vs-baseline bands**, not absolute scores — VLM judges are rankers
(Spearman ~0.6), not calibrated meters, and they under-penalize misalignment.

## What Branch 2 builds (each line traces to a finding)

| Branch 2 target | Parameterized by | Status |
|---|---|---|
| Wire `expected_layout` → fresh render | `02` S5 A/B decides if bins steer | gated on bakeoff |
| Fix OUTWARD `scale_parent_fresh` ref no-op (→ edit endpoint) | `01` R4 (S4) | gated on bakeoff |
| Verifiable entity edit/delete loop | `03` | confirmed — buildable now |
| Promote `inside` to real sub-frame nesting | `04` | confirmed — buildable now |
| Multi-hop drift `chain_runner` + `half_life` | `05` | confirmed — buildable now |
| Baseline-drift guard | `05` | confirmed — buildable now |
| Live grounding signal + runtime INV-2 | `05` + existing geometry_checks | confirmed — buildable now |

## Next: the paid bakeoff

`01`'s design (~90 generations, <$25, Gemini judge, `FAL_IMAGE_MODEL_BALANCED=nano-banana-pro`
override) answers the two gated questions (do layout bins steer? does the edit endpoint fix the
OUTWARD ref no-op?) plus confirms the per-task model calls. Its results append here as `06`.
