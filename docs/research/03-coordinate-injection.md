# 03 — Coordinate injection, entity edits, and verifiable faithfulness

_Code-grounded. Covers (a) how coordinates reach the model today + alternatives from the
literature, (b) how add/move/update/delete works through `EntityGeoEdit` and how to make edits
verifiably faithful, and (c) the metric-vs-relative bridge. Builds on `SESSION_AUDIT.md`
("generated→coords is relative, not metric; only `WORLD_TOPDOWN_MAPS` gives exact seeding")._

## How coordinates are injected today

The whole system is **fal-only, no ControlNet** by deliberate choice — geometry steers via
**layout-as-prompt text**, not a structure-control model (`model_router.py:8-13`). The pipeline:

1. **Geometry → bins.** `geometry.project_scene` (`providers/geometry.py:185-191`) projects each
   `WorldEntityGeo` (world pose + footprint + height) through a flat-ground 2.5D pinhole into a
   `ProjectedEntity` with continuous `x_pct/y_pct/w_pct/h_pct` **and** coarse bins `h_pos`
   (5 levels), `v_pos` (3), `size` (5) — `geometry.py:97-127`.
2. **Bins → prompt text.** `geometry_prompt.layout_constraints` (`geometry_prompt.py:14-28`)
   serialises the bins, nearest-first, into the "SCENE LAYOUT (place these exactly where stated…)"
   clause. The continuous `x_pct` is **dropped** — only the bin words are sent.
3. **Clause → render.** Appended to the composed prompt behind `WORLD_GEOMETRY_GEN`
   (`generate.py:971-974`); also threaded into the Kontext zoom (`image_edit.py:150-152`).
4. **Verify against the same coords.** The grounding loop detects objects and diffs the
   **continuous** rects via IoU + centroid (`grounding.py:63-113`) — so the bins drive the
   prompt, the rects drive the check.

**Honest status:** sending bins (not pixels) is the right abstraction (see `02`), but whether the
bins move the *fresh* render is **unverified** (`SESSION_AUDIT.md:66`) — that A/B is in `02`.

### Alternatives from the literature (and why the project doesn't use them)

| Technique | What it gives | Why not here (today) |
|---|---|---|
| **ControlNet / T2I-Adapter** (depth, seg, canny, pose) | Hard structural control — exact layout from a condition map | Needs a self-hosted SD/Flux + ControlNet stack; fal's hosted gen endpoints don't expose it. Explicitly rejected (`model_router.py:8-13`). |
| **GLIGEN** (grounded gen) | Bounding-box + label grounding via gated self-attention; box coords as Fourier-embedded tokens; open-set | Same: a model-architecture feature, not a hosted-API knob. The closest hosted analogue is descriptive bins. [GLIGEN arXiv 2301.07093] |
| **Regional prompting** (hard binding + soft refine) | Per-region prompts in one image | Hosted nano-banana-pro has no region input; NL "in the top-left region" is the degraded form. [arXiv 2411.06558] |
| **Inference-time spatial alignment** (energy/attention guidance on box centroids) | Pushes objects toward target boxes at sampling time, no retrain | Needs sampler access (latents/attention), which fal doesn't expose. [InfSplign arXiv 2512.17851] |
| **Layout-as-text (the bins, current)** | Cheap, model-agnostic, deterministic, unit-testable, gives the verifier a target | Weakest control, compliance unverified — but the only one a hosted API allows, and descriptive position language *does* land on these models. [minimaxir] |

**Takeaway:** given the fal-only constraint, layout-as-text is the correct choice; the upgrade
path is not ControlNet but a **verify→repair** loop that *measures* compliance and corrects it
(which the code already has — below). If hard control ever becomes a requirement, it forces a
self-hosted Flux+ControlNet/GLIGEN backend, a much larger change.

## Entity add / move / update / delete (`EntityGeoEdit`)

The NL-editable map is the structured-edit half — coordinates flow the *other* way (user
intent → geometry), and never come from the image model.

- **Wire type** (`packages/config/src/index.ts:700-711`): discriminated union
  `move{target,dx,dy}` | `set_height{target,height}` | `set_appearance{target,visual}` |
  `remove{target}` | `add{label,pos,height?,footprint?}`. World coords: origin top-left, +x east,
  +y south (`index.ts:698`).
- **NL → edits** (`llm.edit_entities_nl`, `llm.py:2237-2267`): one `_complete_json` call at
  `temperature=0.0`; the system prompt (`ENTITY_EDIT_SYSTEM`, `llm.py:2121-2135`) hands the model
  only the entity roster (id + label + geo) and forbids inventing ids. `parse_entity_edits`
  (`llm.py:2152-…`) is a **tolerant coercer**: unknown op, `target ∉ valid_ids`, or ill-typed
  field → the edit is dropped, never raises (`llm.py:2153-2155`). A bad completion degrades to a
  thinner/empty plan, not a wrong mutation. The LLM emits relative `dx/dy` (a *shift*), not
  absolute positions — so it never has to know the metric scale.
- **Apply** (`applyEntityEdit`, `apps/web/lib/world-map.ts:171-208`): pure function. `add` mints a
  `geo_user_<slug>` id with defaults; `remove` filters; `move` adds the delta; `set_height` /
  `set_appearance` overwrite; all stamp `source:"user"` + `updated_at`. `applyEntityEdits`
  (`world-map.ts:322-…`) wraps it with optimistic-concurrency retry.
- **Blast radius** (`blastRadius`, `world-map.ts:218-236`): which saved nodes reference an edited
  entity → the re-stage candidates, including **frame-siblings** when `geos` is supplied (moving
  the Tower of Art re-stages every interior that shows things around it). Built from
  `appears_on_node_ids` via `buildGeoReferences` (`world-map.ts:241-…`). Served by the
  `/edit-entities` endpoint (`generate.py:1645-1675`).

## Making edits verifiably faithful (grounding diff before/after)

The grounding machinery already gives the before/after instrument — it just isn't pointed at the
entity-edit path yet.

**What exists:**
- `grounding.diff(expected, observed)` (`grounding.py:63-113`) → `GroundingReport{matched,
  missing, extra, score, mean_iou}`, with the extras penalty (`grounding.py:107-110`) so a clean
  match + a hallucinated object can't score 1.0.
- `run_grounding_loop` (`grounding.py:136-168`): bounded detect→diff→repair→re-verify, **returns
  the best-scoring image, never merely the last**, stops when nothing is `_actionable`.
- Live wiring in the **tap** render (`generate.py:284-336`, behind `VLM_GROUNDING` /
  `VLM_GROUNDING_REPAIR`): `_verify` = `detector.detect` + `diff`; `_repair` =
  `geometry_prompt.repair_instruction` (`geometry_prompt.py:35-66`) → `edit_image` with a minimal
  "fix just these" instruction.

**The gap + the fix — verifiable entity edits:** the `/edit-entities` flow mutates *geometry* and
stales nodes (blast radius), but re-staging a node and **confirming the edit took** is not closed
in code. Proposed loop (reuses everything above):

1. **Before:** project the node's pre-edit scene → `expected_before`; run `diff` against the
   current render → baseline report.
2. **Apply** the `EntityGeoEdit`(s); **re-project** → `expected_after` (the move/add/remove is now
   in the geometry, so `expected_after` differs in exactly the edited entity's bin).
3. **Restage** the affected node, then **verify**: `detector.detect` the new render →
   `diff(expected_after, observed)`. The edit is **faithful** iff the moved/added entity is now
   `matched` at its new bin (`pos_ok`) and removed ones are absent (not in `matched`, not in
   `extra`).
4. **Repair/abort:** if not, run the bounded loop with `repair_instruction(expected_after, …)`;
   if it still fails, surface "couldn't place X" rather than silently shipping a wrong frame.

This turns "we edited the map and re-rendered" into "we edited the map and **proved** the render
reflects it" — a regression target, not a vibe. It is also the natural place to assert the
**inverse**: an edit must NOT perturb un-edited entities (compare `expected_before` vs
`expected_after` deltas to the observed deltas — the in-context edit models claim to leave
unmentioned content alone; verify it [Kontext arXiv 2506.15742]).

## Metric vs. relative — the bridge options

The standing finding: **generated→coords is relative, not metric**; the only exact path is
`WORLD_TOPDOWN_MAPS` (`generate.py:236-252`, `SESSION_AUDIT.md:52-53`).

- **Why relative.** A normal (often 2.5D) render is read back by monocular estimation
  (`estimateGeoFromBBox`, used in `world-map.ts:380`) — a bbox under an unknown oblique camera
  gives a *bearing/size approximation*, not metres. Bins absorb that ambiguity honestly.
- **The exact lever (already shipped).** `WORLD_TOPDOWN_MAPS` forces a flat orthographic overhead
  render (`generate.py:248-252`), so a detection bbox **is** the world footprint — the one place
  bbox→world is metric. The top-down branch of `estimateGeoFromBBox` is therefore left
  **un-clamped on purpose** (`SESSION_AUDIT.md:105-108,137-144`): a building spanning 80% of the
  frame must seed an ~80-unit footprint; the oblique clamp exists only to tame monocular-depth
  blowups, which top-down doesn't have.
- **Bridge options, cheapest first:**
  1. **Top-down maps as the metric anchor (current).** Seed the metric ladder from top-down
     renders; let oblique scenes stay relative. No new model. Recommended default.
  2. **Anchor-pair scale calibration.** When two entities have both a known world distance (from
     the geo map) and a detected pixel separation, solve a single scale factor for that frame —
     upgrades a relative oblique read to metric without a depth model. Cheap, deterministic, fits
     the existing `neighbors_of` bearings (`geometry.py:207-228`).
  3. **Monocular depth / metric-depth model** (e.g. a Depth-Anything-class endpoint) to lift
     oblique bbox → metric. Most general, but adds a model + the fal-only posture forbids it
     today; only worth it if oblique scenes must be metrically composited.
  4. **Keep the two planes explicit.** Metric where it's earned (top-down + anchor-pairs),
     relative elsewhere, and never silently mix them in one ladder — matches the current honest
     stance. The `scale_tier` field (`index.ts:580-582`) already lets a view declare its rung so
     downstream code knows which regime it's in.

## Sources

- GLIGEN — arXiv 2301.07093 ; https://gligen.github.io/
- Region-Aware T2I (hard binding + soft refinement) — arXiv 2411.06558
- InfSplign (inference-time spatial alignment) — arXiv 2512.17851
- T2I-CompBench (centroid+IoU spatial metric, mirrors `grounding.diff`) — arXiv 2307.06350
- FLUX.1 Kontext (in-context edits preserve unmentioned content) — arXiv 2506.15742
- minimaxir, *Nano Banana can be prompt engineered* — https://minimaxir.com/2025/11/nano-banana-prompts/
- IP-Adapter (loose ref conditioning, needs spatial control to be added) — https://www.mercity.ai/blog-post/understanding-and-training-ip-adapters-for-diffusion-models/
