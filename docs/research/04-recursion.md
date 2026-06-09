# 04 — Recursion in the description→map pipeline

_Code-grounded, same discipline as `docs/SESSION_AUDIT.md`: what recursion actually exists
today, where deeper recursion is genuinely needed vs. where flat-v1 is the honest call, and a
concrete recommendation for nesting depth + the data model. Every claim pinned to a file:line
in this worktree. Literature only where it changes the recommendation._

## 1. The recursion that is built: PARSE → SOLVE → SEED → RENDER

The B1 "describe a place → logical object world" path is **not** recursive at the pipeline
level — it is a single linear pass (one LLM parse, one pure solve, one seed, one render). The
recursion that exists is **inside the solver**, where placement is resolved by a
relation-dependency fixpoint rather than a single sweep.

- **PARSE** — `providers/llm.py plan_world_from_description` → a `SceneGraph` of *relations
  only*, never coordinates. The endpoint is `generate.py:1693 plan_world_endpoint`; it is
  gated by `WORLD_FROM_DESCRIPTION` (403 when off, `generate.py:1713`).
- **SOLVE** — `providers/layout_solver.py solve_layout` (`:292`). Pure, deterministic,
  golden-tested (`tests/world_bench/test_layout_solver.py`).
- **SEED** — the client POSTs `solved` to the existing `/api/world/[id]/map` →
  `upsertEntityGeos`; the solver emits exactly that shape (`layout_solver.py:260 _emit`,
  `source:"derived"`, `confidence 0.6`).
- **RENDER** — `geometry_prompt.layout_constraints` + the grounding loop (description-driven
  pixels today; see §3.1).

### The genuinely recursive step: relation-dependency resolution in SOLVE

`solve_layout` places `subject` relative to an already-placed `object`. Since a relation chain
can be deep (a lamp `on_top_of` a desk that is `on_wall`), placement is iterated to a
**fixpoint**, not done in one pass:

```
for _ in range(len(insts) + 2):        # layout_solver.py:336
    changed = False
    for it in insts:
        ... place it relative to its (now-resolved) object ...
    if not changed: break
```

This is the local form of the literature's *coarse-to-fine, parent-then-child* recursion
([SceneHGN](http://geometrylearning.com/scenehgn/), [HLG](https://arxiv.org/pdf/2508.17832)):
anchors (walls / root objects) resolve first (`layout_solver.py:332` seeds root anchors at
centre), then their dependents, until stable. The fixpoint cap (`len(insts)+2`) bounds it; a
relation whose object never resolves drops to a soft clarifier + centre default
(`layout_solver.py:356-363`). It is iteration over a dependency DAG, **flattened into one
frame** — not nesting into sub-frames.

### Why the LLM emits relations, not coordinates (the load-bearing choice)

The audit's ROOT-2 failure was "the model free-styles placement." The pipeline closes it by
splitting roles: the LLM emits **structure** (`SpatialRelation` between refs); the
deterministic solver emits **geometry**. The parse boundary even drops a stray coordinate.

This is now an independently-confirmed result in the literature, which **sharpens the
recommendation to keep it**: the Open-Universe indoor-scene work found that *"tasking an LLM
with directly specifying metric location coordinates leads to poor performance due to mismatch
with natural language in training data,"* and instead has the LLM emit *"a declarative program
describing objects and spatial-relation constraints"* solved separately
([arXiv 2403.09675](https://arxiv.org/html/2403.09675v1)). [SceneCraft](https://arxiv.org/html/2403.01248v1)
and [GraLa3D](https://arxiv.org/html/2412.20473) follow the same split (LLM → scene-graph
constraints → solver). OFB's PARSE→SOLVE split is the same architecture, arrived at from the
same failure.

## 2. Where deeper (sub-frame) recursion is genuinely needed

The data model already *describes* recursion that the solver does **not yet build**: a true
tree of nested frames.

- **`WorldEntityGeo.parent_id` + `pos` local to the parent + a learned `scale`** is the
  documented nested-frame model (`packages/config/src/index.ts:503-531`): a place you ENTER
  is its own little world; its sub-entities carry `parent_id` and a `pos` in the parent's
  local frame, so the interior is fixed once and stays consistent across views.
- The **DEEPER (tap-enter)** path already exercises this for real:
  `apps/web/lib/world-map.ts deriveGeoFromExtraction` (`:363`) seeds extracted sub-entities
  with `parent_id` and **learns the parent's `scale`** = `parent.footprint / localExtent(geos)`,
  clamped `[1e-3, 10]` (`:411`). That is one real level of recursion in the persisted world.
- **OUTWARD (ascend)** is the *inverse* recursion — reparenting the current root under a
  freshly-synthesized container — on the same metric ladder (`SCALE_LADDER`,
  `index.ts:16`; `model_router.coarser_tier :75`, `select_outward_op :94`).

So the world model is a tree (`parent_id` chains, resolved by `resolveAbsolutePos`), and
DEEPER/OUTWARD walk it one rung at a time. The **gap** is that the *description→map solver*
(B1) flattens everything into one frame:

### Flat-v1 vs. deferred (honest split)

| Path | Recursion today | Status |
|---|---|---|
| SOLVE relation chains | fixpoint within ONE frame (`layout_solver.py:336`) | **built** |
| `inside` nesting (B1) | **flat**: prop sits within container footprint, same frame, `parent_id:null` (`layout_solver.py:172-176`, `:265`) | **deliberate flat-v1** |
| DEEPER tap-enter | one real sub-frame level, learned `scale` (`world-map.ts:405-416`) | **built** |
| OUTWARD ascend | one reparent level up the ladder | **built (single-hop, flag-off)** |
| Multi-hop OUTWARD/DEEPER chains | drift across hops **unmeasured** (Risk #1, `PLAN_OUTWARD.md:118`) | **deferred / unmeasured** |

The `inside` relation is the clearest deferral: `solve_layout` marks it `nested:True` and
returns the container's `(ox,oy)` with **no translation and `parent_id` left null on emit**
(`layout_solver.py:172-176`, `:265`) — it is exempt from de-overlap (`:204`) but it does **not**
become a child frame with its own `scale`. The comment says so explicitly: *"true sub-frame
nesting is deferred — see docs/PLAN_PLACE_TO_WORLD.md."* This is the right call for v1 (a mug
on a shelf does not need its own coordinate universe), but it means a described place is
**one flat level**, whereas a tapped-into place is **two**.

## 3. Where recursion is NOT needed (and shouldn't be added)

- **3.1 Render is not recursive, and the seed already carries the layout.** B1 renders a
  single description-driven image; `expected_layout` is **not wired into the fresh render**
  (`SESSION_AUDIT.md:66-70`). The logical layout lives in the seeded geos (tap-routable),
  not necessarily the pixels. Making the render *recursively* refine sub-regions would be
  premature: the honest first fix is to wire `expected_layout` to *steer* the single render,
  not to recurse it. The grounding loop already does one bounded repair pass — that is the
  correct amount of render-side iteration for a relative-not-metric pipeline.
- **3.2 Over-packing into sub-frames is a trap.** The literature warns recursion *propagates*
  error: autoregressive/iterative generation suffers *"compounding errors as generated frames
  become the context for future steps"* ([Pathwise](https://arxiv.org/html/2602.05871),
  [BAgger](https://arxiv.org/pdf/2512.12080)). Every extra recursion level the *generator*
  performs is another place drift enters. OFB's design keeps the recursion in the
  **deterministic solver + persisted geo tree** (no drift) and limits the *generator* to one
  hop at a time with a style anchor every hop (INV-3, `PLAN_OUTWARD.md:123`). That layering is
  correct and should be preserved.

## 4. Recommendation — recursion depth + the nested-frame data model

### 4.1 Depth: cap meaningful nesting at ~2–3 frame levels per render, unbounded in the tree

The hierarchical-scene literature converges on **3–4 semantic levels** (SceneHGN:
room → functional region → object → part; HLG: room → anchors → tabletop/contents). OFB's
`SCALE_LADDER` is 11 rungs (`index.ts:16-19`), but those are *navigation* rungs across whole
sessions, not levels rendered in one image. Recommendation:

1. **Persisted tree: unbounded** — `parent_id` chains can be arbitrarily deep across a
   session (OUTWARD/DEEPER each add a rung). `resolveAbsolutePos` already walks the chain with
   a cycle guard, and `geometry_checks._parent_cycles` (`geometry_checks.py:113`) blocks
   cycles. Keep it unbounded; the metric span is stored/compared in **log space** to survive
   ~27 orders of magnitude (`index.ts:22-24`, `PLAN_OUTWARD.md:126`).
2. **Per-render: ~2 levels (the place + its direct children).** A single rendered frame
   should show one frame and its immediate sub-entities — matching DEEPER today
   (`deriveGeoFromExtraction` seeds children of *one* parent). Rendering 3+ nested levels in
   one image is where the monocular-depth pipeline (relative, not metric — `SESSION_AUDIT.md`)
   stops being trustworthy.
3. **Auto-insert intermediate rungs** when a hop is too large, rather than recursing visually
   — the design already specifies this for OUTWARD (clamp visual zoom ~×3–4/hop, insert a rung
   when the metric jump is large, `PLAN_OUTWARD.md:62-63`). Apply the same to any future
   B1 `inside` promotion: never collapse two ladder rungs into one render.

### 4.2 The nested-frame data model: promote B1 `inside` to the DEEPER model

The data model is already correct — the fix is to make the B1 solver **use** it for `inside`,
exactly as `deriveGeoFromExtraction` does for tap-enter. Concretely, when promoting `inside`
from flat-v1 to a real sub-frame in `layout_solver.py`:

- On emit (`_emit`, `:260`), for an `inside` subject set
  `parent_id = f"geo_plan_{container_ref}"` instead of `None` (today `:265`), and keep its
  `pos` **local to the container** (origin at the container, not the place frame).
- Have the solver compute the container's **learned `scale`** the same way the TS path does —
  `scale = max(container.footprint.w, .d) / localExtent(children)`, clamped `[1e-3, 10]` —
  mirroring `world-map.ts:410-411`. Emit it on the container geo (`scale` field,
  `index.ts:526-531`). This is what makes a nested `pos` resolve to a true absolute position;
  without it the child's local coords are meaningless.
- Run the existing per-frame de-overlap **within each frame** (the children of a container
  de-overlap among themselves, not against the place's other entities) — the literature's
  "constraint enforcement separated across decomposition levels to minimize error propagation"
  ([HLG](https://arxiv.org/pdf/2508.17832)). The current single-frame `_de_overlap`
  (`layout_solver.py:199`) already excludes `nested` items (`:204`); the promotion is to give
  each container its own de-overlap pass instead of excluding nested items entirely.
- **Guardrails already exist:** `geometry_checks.check_geo_entities` validates
  `parent_id` resolution + cycles + `scale > 0` (`geometry_checks.py:92-95`, `:106-108`,
  `:113`), and the live diagnostic already runs on solver output
  (`generate.py:1734`). So promoting `inside` to nesting is *covered by the anchors the day
  it ships* — no new invariant code, just the solver change + golden fixtures.

### 4.3 Keep the LLM coordinate-free at every level

Whatever the nesting depth, the parse boundary stays relations-only (the ROOT-2 fix and the
Open-Universe result). A nested object is still expressed as `inside`/`on_top_of` a ref; the
*solver* picks the local coordinate. Recursion lives in the solver and the persisted tree —
never in what the model is asked to emit.

## 5. One-paragraph verdict

The pipeline is correctly **linear at the top and recursive in two contained places**: a
relation-fixpoint inside the solver (built, bounded, golden-tested) and a one-level frame tree
in the persisted world (built for DEEPER/OUTWARD). The honest gap is that B1's `inside` is
flat-v1 — the *model* exists (`parent_id` + learned `scale`) but the *description solver* does
not yet use it, so a described place is one frame while a tapped place is two. The fix is small
and already guarded: make `layout_solver` emit `inside` as a real child frame with a learned
`scale`, exactly as `deriveGeoFromExtraction` already does. Depth should be **unbounded in the
persisted tree** (log-space metric, cycle-guarded) but **~2 levels per render** with
auto-inserted intermediate rungs — both to match the trustworthy range of the relative-geometry
pipeline and to keep generator-side recursion (where drift compounds) to a single hop.

---

### Sources
- [Open-Universe Indoor Scene Generation (LLM program synthesis, relations not coordinates)](https://arxiv.org/html/2403.09675v1)
- [SceneCraft: LLM agent synthesizing 3D scenes (scene-graph constraints → solver)](https://arxiv.org/html/2403.01248v1)
- [GraLa3D / scene-graph + layout-guided 3D generation](https://arxiv.org/html/2412.20473)
- [SceneHGN: hierarchical graph networks, room→region→object→part](http://geometrylearning.com/scenehgn/)
- [HLG: hierarchical layout generation, recursively decoupled, constraints per level](https://arxiv.org/pdf/2508.17832)
- [Pathwise test-time correction (compounding drift in autoregressive generation)](https://arxiv.org/html/2602.05871)
- [BAgger: backwards aggregation for mitigating drift](https://arxiv.org/pdf/2512.12080)
