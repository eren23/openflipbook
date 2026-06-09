# 02 — Prompting: the recipe per model + the unanswered layout question

_Code-grounded. The prompt clauses live in `providers/llm.py`, `providers/image.py`
(`conditioning_preamble`), `providers/image_edit.py` (`build_zoom_instruction`), and
`providers/geometry_prompt.py`. The open question — do the `layout_constraints` bins actually
move pixels? — is `SESSION_AUDIT.md:66-70`; this doc designs the A/B that answers it._

## The clauses that exist today

### MEDIUM-LOCK (the universal workhorse)
`llm.plan_page` system clause (`llm.py:1131-1143`). Fires whenever a `style_anchor` is present.
Three moves, all empirically chosen:
1. Name the medium explicitly and forbid drift ("never photorealism, a 3D render, or isometric
   line-art — however much the subject might invite it").
2. **Begin** the prompt with a leading medium clause ("Hand-drawn engraving with cross-hatching
   and sepia ink, …").
3. **End** with a one-line lock ("Rendered strictly as <medium> — not photoreal, not 3D…").

This is the only style guard that works on **every** path including the fresh-gen no-op and
seedream (`SESSION_AUDIT.md:29-39`). The bracket-the-prompt (front + back) structure matches what
the literature recommends for these models: front-load the non-negotiables and restate
prohibitions. Gemini-3-Pro-Image structured prompting reports ~91% mandatory-compliance / ~94%
prohibition-compliance when constraints are stated as explicit MUST/MUST-NOT clauses. [SCHEMA for
Gemini 3 Pro Image, arXiv 2602.18903]

### Reference-image preamble (edit/continue paths only)
`conditioning_preamble` (`image.py:137-201`) emits an ordered, **role-weighted** legend: image 1
= region (strongest), then parent, then anchor, then the persistent **style** exemplar. The order
*is* the weight. The `place_scene` variant tells the model image 1 is the EXTERIOR and to draw
the architecturally-continuous INTERIOR (`image.py:154-163`) — the fix for "did you only zoom in?".
Reminder from `01`: this preamble only bites where the endpoint honors refs (edit/continue);
on the text-to-image fresh/expand path it rides along inertly.

### Kontext zoom instruction
`build_zoom_instruction` (`image_edit.py:116-152`): "zoom into <title> … keep the exact walls,
buildings, towers and landmarks … same hand-drawn engraving style … SAME overhead map viewpoint;
do not reinvent / restyle / switch to eye-level." Named sub-areas are worked in as **features to
draw**, never as captions (Kontext garbles label text), and it appends the layout clause if
present (`image_edit.py:150-152`).

### Layout-constraint clause (the unverified one)
`geometry_prompt.layout_constraints` (`geometry_prompt.py:14-28`): builds, nearest-first,
`"<label> — <size>, <h_pos> <v_pos>"` joined into:
> "SCENE LAYOUT (place these exactly where stated — nearest listed first, keep their relative
> positions, sizes and front-to-back order): …"

Bins come from `providers/geometry.py`: `_h_pos` (far-left/left/center/right/far-right at
0.2/0.4/0.6/0.8), `_v_pos` (top/mid/bottom at 0.4/0.66), `_size_bin` (tiny→huge). The repair
variant (`geometry_prompt.py:35-66`) emits "add a <x> (…)" / "move the <x> to <h_pos> <v_pos>".

## The prompt recipe, per model

| Model / path | Recipe that the code uses / should use |
|---|---|
| **nano-banana-pro fresh (t2i)** | MEDIUM-LOCK front+back; descriptive NL placement (bins); labels as a `Labels to include:` list (`generate.py:967-968`) — but NOT for `place_scene` (turns interior into a captioned diagram). No bounding-box input exists; NL only. |
| **nano-banana-pro/edit** | image_urls = [subject, style exemplar]; role preamble; keep the edit instruction minimal + medium-locked. Honors up to 14 refs + identity for 5 people. [fal] |
| **Kontext (zoom/continue)** | singular `image_url`; carry style **in the instruction text** (no 2nd ref slot); features-not-captions; "SAME viewpoint, do not reinvent." |
| **BRIA (outpaint)** | `prompt` = the medium ("…drawn in the SAME style …, NOT a photograph"); MUST be non-empty or it auto-prompts photoreal (`generate.py:557-565`; [Bria docs]). |
| **seedream (t2i pro)** | MEDIUM-LOCK text only; no ref slot in the t2i slug (`image.py:115-120`). |

## How to phrase coordinate/layout constraints for best compliance (from the literature)

- **Relative/directional language beats raw numbers — and is what the bins already use.** Public
  testing of nano-banana shows descriptive spatial constraints ("rule of thirds horizontally and
  vertically", "left/right eye socket", "1/3 vs 2/3 split") are followed precisely; numeric
  coordinates were **not** validated to help. [minimaxir, *Nano Banana can be prompt engineered*]
  → the `far-left … far-right` / `top|mid|bottom` bins are the *right* abstraction; sending raw
  `x_pct` would likely be no better and possibly worse.
- **State each placement as an explicit instruction, nearest-first** (the clause already does).
  Structured MUST-style phrasing is what drives the >90% compliance numbers. [arXiv 2602.18903]
- **Don't over-specify count + position + size + order in one run** — T2I models degrade on
  multi-attribute compositional prompts (attribute swaps, spatial misalignment). [T2I-CompBench,
  arXiv 2307.06350] If the bins underperform, the fallback is fewer salient anchors (the 2–3
  nearest), not more detail.
- **Consider a coarse grid hint.** Some practitioners get tighter layout by naming a 3×3 grid
  ("top-left cell, centre cell") — which is exactly what `_h_pos`×`_v_pos` already encodes
  (5×3). Phrasing the clause as a grid ("in the top-left region of the frame") may read more
  naturally to the model than "far-left top".

## OPEN QUESTION: do `layout_constraints` bins actually steer the render?

**Status:** built deterministically, **not wired into the fresh B1 render**, and steering is
**UNVERIFIED** (`SESSION_AUDIT.md:66`). Note the clause *is* appended in the tap path
(`generate.py:971-974`, behind `_world_geometry_gen_on()` / `WORLD_GEOMETRY_GEN`) and rides into
the Kontext zoom — but no one has measured whether the pixels move. The grounding diff
(`grounding.py:63-113`) already gives the exact instrument to measure it.

### The A/B that answers it

**Design (paid, Gemini-judged, shares S5 budget with `01`):**
- **Inputs:** ~10 hand-authored `expected_layout` lists (3–6 entities each) spanning the bins
  (corners, centre, mixed sizes, front-to-back overlap). Use real `ProjectedEntity` dicts so the
  clause text is production-identical.
- **Arms:**
  - **A (control):** prompt with NO layout clause.
  - **B (bins):** same prompt + `layout_constraints(...)`.
  - **B′ (grid rephrase):** same, but the clause phrased as a 3×3/5×3 grid ("in the top-left
    region…") — tests the phrasing hypothesis above.
  - *(optional)* **C (numeric):** append `x_pct/y_pct` to see if raw coords help or hurt.
- **Model:** nano-banana-pro (the default fresh model) — the one that actually ships.
- **Metric (no new tooling):** run `detector.detect` → `grounding.diff(expected, observed)` and
  compare **mean `score`**, **presence**, and **pos_agree** (`grounding.py:103-106`) across arms.
  This is the same UniDet-centroid-vs-expected method as T2I-CompBench [arXiv 2307.06350], so it's
  a defensible number, and `POS_TOL=0.2` (`grounding.py:25`) lines up with the bin width.
- **Decision rule:** if B's mean grounding score beats A by a meaningful margin (e.g. ≥ +0.1 and
  pos_agree up), **wire `expected_layout` into the fresh render** (deferred item
  `SESSION_AUDIT.md:84-85`) and prefer whichever of B/B′ wins. If B ≈ A, the bins don't steer
  nano-banana-pro — keep them for the **grounding target only** (the verify/repair loop still
  uses them) and don't spend prompt tokens on the fresh path.
- **Cost:** ~10 layouts × 4 arms ≈ 40 gens + 40 detector calls → a few dollars; folds inside the
  `01` ~$25 envelope.

**Why this is the highest-value experiment:** it's the difference between "the geometry engine
*describes* a layout the model ignores" and "the geometry engine *controls* the layout" — and it
needs zero new infrastructure (the clause, the detector, and the diff all exist).

## Sources

- SCHEMA for Gemini 3 Pro Image (structured prompting, compliance rates) — arXiv 2602.18903
- minimaxir, *Nano Banana can be prompt engineered…* — https://minimaxir.com/2025/11/nano-banana-prompts/
- DeepMind Nano Banana prompt guide — https://deepmind.google/models/gemini-image/prompt-guide/
- Google Cloud, *Ultimate prompting guide for Nano Banana* — https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana
- T2I-CompBench (spatial-relationship metric) — arXiv 2307.06350 (NeurIPS 2023)
- Bria Expand prompt behaviour — https://docs.bria.ai/image-editing/v2-endpoints/image-expansion
