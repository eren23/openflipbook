# Scale Navigation — image/map → consistent zoom across scales

_A forward design doc (not implemented this pass). Grounded in the code, not memory —
every file:line below was read against `main` at `54bab2a`. Where the master plan or the
audit drifted from the code I corrected the ref inline and noted it at the bottom._

## What this is

From an image or a map, navigate across **scales** the way you'd navigate a real place —
consistently and logically:

- **OUTWARD / zoom-out** — city → region → world → planet → star system → galaxy → universe.
  Synthesize the thing that **contains** the source. _Does not exist yet._
- **DEEPER / zoom-in** — place → interior. Step INTO a thing. _Already shipped_ as the
  geometric tap → `place_scene` / `place_submap` enter flow (`apps/web/lib/geo-tap.ts`).
- **AROUND / pan same-scale** — reveal the **logically adjacent** neighbours at the same
  scale ("a proper one", not random). _Exists but is VLM-arbitrary today_
  (`propose_neighbors`, `apps/modal-backend/providers/llm.py:1577`); `EXPAND_MAP_PAN`
  (`generate.py:470`) pans pixels but has no notion of *which* neighbour.

Everything stays style-consistent (one art medium, every hop) and **size/scale-consistent**
(a city stays bigger than a building stays bigger than a room, with the metric to prove it).

This builds **on top of** the geometric world that already merged (PR #14): numeric map +
observer poses + the affine `resolveAbsolutePos` that already gives every entity a true
absolute coordinate "across the universe" (`apps/web/lib/world-geometry.ts:288-320`). The
honest constraint from `GEOMETRIC_WORLD_AUDIT.md` §4b/§6.5: generated→coords geometry is
**relative, not metric** — a detection box wraps a cluster, the only exact bridge is
`WORLD_TOPDOWN_MAPS` (bbox = footprint). So scale navigation cannot *depend* on metric
precision; it has to layer a **coarse absolute rung** (which order of magnitude are we at)
on top of the existing **fine relative `scale`** (how big is one unit of this frame). That
split is the keystone of the whole design.

---

## Phase 0 — The scale ladder (keystone)

Nothing else works without an explicit, ordered, metric-anchored ladder. Add it next to
`ScaleKind` / `ViewLevel` in `packages/config/src/index.ts` (`ScaleKind` is at :8,
`ViewLevel` at :474, `SceneView.level` at :478, `WorldEntityGeo.scale` field at :449
(its doc-comment at :444-448)):

```ts
// Ordered rungs, coarsest → finest. A node's coarse absolute "where on the
// zoom axis am I". Distinct from ScaleKind (relative: component/peer/container)
// and from WorldEntityGeo.scale (fine metric: size of one unit of this frame).
export const SCALE_LADDER = [
  "universe", "galaxy", "star_system", "planet",
  "world", "region", "city", "district", "place", "room", "object",
] as const;
export type ScaleTier = (typeof SCALE_LADDER)[number];

// Order-of-magnitude METRIC anchor (metres) per rung — the bridge that makes
// the ladder metric-conserving. One representative span, log-spaced; ~27 orders
// of magnitude end to end, so callers store/compare in LOG space (Phase 5).
export const SCALE_TIER_METERS: Record<ScaleTier, number> = {
  universe: 8.8e26, galaxy: 9.5e20, star_system: 1.5e13, planet: 1.3e7,
  world: 1.3e7, region: 3e5, city: 1.5e4, district: 1.5e3,
  place: 1.2e2, room: 1.0e1, object: 1.0e0,
};

export function tierIndex(t: ScaleTier): number { return SCALE_LADDER.indexOf(t); }
// Index delta on the ladder (signed): ascend = +1 per rung up, descend = -1.
export function tierStep(from: ScaleTier, to: ScaleTier): number {
  return tierIndex(to) - tierIndex(from);
}
// Per-transition METRIC multiplier = ratio of rung metres. city→region ≈ 20×;
// the FINE WorldEntityGeo.scale a transition learns should agree in sign+order.
export function tierMetricMultiplier(from: ScaleTier, to: ScaleTier): number {
  return SCALE_TIER_METERS[to] / SCALE_TIER_METERS[from];
}
```

> Note: `world` and `planet` share a metres anchor by design (a "world" is a planet-surface
> framing); `tierStep` still separates them by index so the ladder stays strictly ordered.
> `tierMetricMultiplier` of `1` there is intentional and INV-2 (below) treats a multiplier of
> exactly 1 between distinct adjacent rungs as legal.

**Store an additive `scale_tier?: ScaleTier` everywhere a node's frame is described**, all
optional, all back-compat:

- `NodeDoc` / `NodeInsert` / `NodeRow` in `apps/web/lib/db.ts` (alongside the existing
  `relation?` / `scale?` at :119-120, :139-140, :157-158) + `toRow` default (:166).
- `CreateBody` in `apps/web/app/api/nodes/route.ts:22` (alongside `relation` / `scale`).
- `SceneView` in `packages/config/src/index.ts:478` **and its Pydantic mirror**
  `class SceneView` in `apps/modal-backend/generate.py:101` (TS↔Py parity is load-bearing —
  the field round-trips through the generate request and back onto the node).
- `WorldEntityGeo` in `packages/config/src/index.ts:420` — so a map entity can carry which
  rung it lives at, independent of its fine `scale`.

**This EXTENDS, it does not replace.** `scale_tier` is the coarse absolute rung;
`WorldEntityGeo.scale` (config:449) stays the fine per-frame metric that
`resolveAbsolutePos` composes (world-geometry.ts:295). A node has both: "I'm at the `city`
rung" (coarse) and "one unit of my interior = 0.31 of my parent's units" (fine, learned by
`deriveGeoFromExtraction`, world-map.ts:374-376).

**Seed the rung cheaply.** Extend `view_estimator.estimate_view`
(`apps/modal-backend/providers/view_estimator.py:61`, returns `{level, projection,
pitch_deg}`) to **also** guess `scale_tier` from the same one VLM call, with a deterministic
fallback off `ViewLevel` when it abstains: `map → city`, `building → building`(→`place`),
`street → district`, `eye → room`. That keeps a fresh generated-first session seeded with a
rung for free — the same place §6.1 of the audit already estimates the camera. The Python
`ViewEstimate` TypedDict (view_estimator.py:19) and its TS mirror `ViewEstimate`
(config:511) both gain the optional field.

---

## Phase 1 — OUTWARD (the genuinely new direction)

OUTWARD synthesizes the **parent that contains the source** and reparents the source under
it. It is isolated and additive, modelled exactly on the existing self-contained `expand` /
`edit` branches in `generate.py` (the `EXPAND_MAP_PAN` branch at :470-540 and the edit
branch at :408-450 are the templates — they return early and never touch the tap/query
single-`final` path).

### Wire

- New `mode: "ascend"` — add to `GenerateMode` (`packages/config/src/index.ts:3`, currently
  `"query" | "tap" | "edit" | "expand"`). The Pydantic `GenerateBody.mode` (generate.py:131)
  is a free `str`, so no Python enum change is forced, but document it there.
- New isolated branch in `generate.py`, gated `SCALE_LADDER_NAV` (master) **and**
  `SCALE_OUTWARD`, both default-off via `env_flag` exactly like `EXPAND_MAP_PAN`
  (generate.py:470) and `WORLD_MODE` (generate.py:181-182). Flag off → the branch never
  runs, zero behaviour change.

### Which model, and why — a PURE decision

Add `select_outward_op(from_tier, to_tier)` to
`apps/modal-backend/providers/model_router.py` (pure, sits beside `select_operation` at
:37-54; `MODEL_SLOTS` already declares `outpaint → fal-ai/bria/expand` at :22 and
`zoom_continue → fal-ai/flux-pro/kontext` at :21). The decision keys off the **magnitude of
the tier delta**, mirroring the audit's model bakeoff (§6.4: Kontext is *poor* at
top-down→oblique reprojection; BRIA outpaint is the seamless pixel-preserving "pan the world
outward" winner):

| Case | Tier hop | Op | Model | Why |
|---|---|---|---|---|
| **Same-plane small hop** | `city → region` (Δtier 1, same projection plane) | `outpaint_zoomout` | **BRIA** via a new **centered** `expand_image_zoomout` | The source's pixels are preserved and become the **central sub-region** of a bigger frame painted around it. No reprojection, so no §6.4 failure. Style is conserved by construction (the original pixels stay). |
| **Medium-flip large hop** | `planet → star_system` (the view *kind* changes: surface → orbital) | `scale_parent_fresh` | reference-conditioned **fresh gen** (`generate_image(..., reference_urls=[source])`) | Outpaint can't turn a planet surface into a starfield with the planet as a dot — that's a new framing. So generate fresh, conditioned on the source as a visual reference + a planner clause. Gated additionally by `SCALE_OUTWARD_RERENDER` (default off — the riskier path). |

```python
def select_outward_op(from_tier: str, to_tier: str) -> str:
    """Pure: which OUTWARD op synthesizes the parent. Small same-plane hop →
    centered BRIA outpaint (source becomes the central sub-region). Medium-flip
    large hop → reference-conditioned fresh gen. No image model is chosen here
    beyond the op label; resolve_model(op) maps it to a slug + env override."""
    if _is_medium_flip(from_tier, to_tier):   # surface↔orbital↔galactic boundaries
        return "scale_parent_fresh"
    return "outpaint_zoomout"
```

`resolve_model("outpaint_zoomout")` reuses the existing `outpaint` slot
(`fal-ai/bria/expand`, model_router.py:22); the fresh op is tier-based like `fresh`
(model_router.py:20).

### The new provider primitive — `expand_image_zoomout`

Today `expand_image` (`apps/modal-backend/providers/image_edit.py:248`) outpaints in **one
direction** (west/east/north/south) — `_expand_args_for` (:184-201) grows the canvas on one
side and pins the original to an edge. OUTWARD needs the source at the **center** with the
**full margin** painted on all sides in one call, so the source becomes a recognizable
central sub-region:

```python
def _zoomout_args_for(image_url, factor, width, height):
    """Source CENTERED on a canvas `factor`× larger each axis; full margin
    outpainted. original_image_location = the centering offset (vs the edge
    offsets _expand_args_for uses)."""
    cw, ch = int(width * factor), int(height * factor)
    loc = [(cw - width) // 2, (ch - height) // 2]
    return {"image_url": image_url, "canvas_size": [cw, ch],
            "original_image_size": [width, height], "original_image_location": loc}

async def expand_image_zoomout(image_data_url, factor=3.0, ...):
    # Reuses _img_dims/_dims_from_data_url (:204-237) so BRIA gets the parent's
    # REAL pixel size (else it rescales+seams), and _expand_first_image (:239).
```

Everything else (the `fal_subscribe` call, `_expand_first_image`, dims-from-header) reuses
`expand_image`'s existing machinery (:268-282).

### The planner clause (fresh-gen path only)

A new `render_mode: "scale_parent"` clause, slotted like the existing `place_scene` /
`place_submap` clauses (the planner already branches on `render_mode`, e.g. generate.py:816
`render_mode != "place_scene"`; the enter-clauses live in `llm.py` `plan_page`):

> "Render the {N+1 rung} that CONTAINS this {N rung}. Place the source as a small,
> recognizable sub-region within it (a city as one district of the region; a planet as one
> dot in the system). Keep the exact palette, art medium and style — a wider view of the
> same world, not a new invention."

### Zoom clamp + intermediate rungs

Cap the **visual** zoom per hop at ~×3-4 (`expand_image_zoomout(factor≈3)`). When the
**metric** jump between rungs is large (e.g. `planet → star_system` is ~10⁶× by
`tierMetricMultiplier`), the visual zoom and the metric span **decouple** (Phase 4 INV-2,
Phase 5 log-space) — and the branch may auto-insert one or two intermediate synthesized
rungs so no single hop tries to cram 6 orders of magnitude into one ×3 outpaint. The clamp
is the same defensive instinct as `world-map.ts:375`'s `Math.min(Math.max(…, 1e-3), 10)`
scale clamp.

### STATE — OUTWARD inverts the parent pointer

This is the one structurally novel write. DEEPER/AROUND append a child; OUTWARD inserts a
new **root** above the current root and re-points the old root at it. Persist atomically:

1. Insert the synthesized parent **P** with `parent_id: null`, `relation: "ascend"` (a new
   `NodeRelation` value — see Phase 5), `scale_tier: parentTier`,
   `scene_view.scale_tier = parentTier`.
2. Atomically re-point the old root **C**: `C.parent_id = P.id`.
3. Geo-seed: embed C's whole map as **one sub-entity** inside P, with a learned `scale =
   meters(C) / meters(P)` (i.e. `1 / tierMetricMultiplier(parentTier → childTier)`). This is
   the **same math** as `deriveGeoFromExtraction` learning a parent's `scale` (footprint ÷
   interior extent, world-map.ts:374-376) — just run **"from the top"**: P's footprint ÷ C's
   extent. This is exactly what conserves C's absolute size (INV-1).

The reparent is **cycle-guarded** (P has no ancestors; `resolveAbsolutePos` is already
cycle-guarded via its `seen` set, world-geometry.ts:299-309), **abort-safe** (if step 2
fails, delete P and abort — C is untouched), and done under the same optimistic-concurrency
loop the geo writes already use (`optimisticReplace`, world-map.ts:264). The atlas needs no
special case: `layoutPages` already nests generically — roots are laid left-to-right
(world-layout.ts:143-149) and a re-rooted C simply becomes a child of P, a bigger enclosing
tile. (Caveat for implementation: today every node with `parent_id: null` is laid as a
separate root at a left-to-right cursor; reparenting C means it stops being a root and P
becomes one — verify `layoutPages` re-runs over the full node set on reparent, which it does
since it rebuilds `childrenOf` from scratch each call, world-layout.ts:82-88.)

---

## Phase 2 — AROUND (logical, not random)

Today AROUND is `propose_neighbors` (llm.py:1577): a pure VLM survey, no geometry, no facts,
no scale constraint — "favour variety across scales" (llm.py:1608) is the opposite of what we
want here (we want **peers at the SAME scale**). The fix is a **priority cascade** that
prefers ground truth and only falls to the VLM cold:

New pure module `apps/web/lib/scale-neighbors.ts` — `selectNeighbors(...)` layering three
sources, each neighbour carrying a **bearing** so it lands in the right direction:

1. **Geometry first.** `neighborsOf` (world-geometry.ts:232) / `siblingsOf`
   (world-geometry.ts:281) over entities with the **same `parent_id` and same `scale_tier`**
   — these already return real bearings (`Math.atan2(dy, dx)`, world-geometry.ts:244). When
   the map is seeded this is the truth.
2. **Codex facts.** When geometry is thin, same-tier same-region siblings from the codex
   (the `Entity` registry — `facts`, `aliases`, config:362) give *named* logical peers (the
   other lighthouses on this coast) without a VLM call.
3. **Constrained VLM, cold-start only.** Extend `propose_neighbors` (llm.py:1577) with two
   **optional** params — `known_neighbors: list[str] | None` and `scale_tier: str | None` —
   and a clause: "propose PEERS at the SAME scale ({scale_tier}); these are already known:
   {known}; do not repeat them or the focal subject." Empty params → **today's exact
   behaviour** (back-compat). This only runs when (1) and (2) are empty.

Persist each neighbour as today — `relation: "expand"` (the existing AROUND relation;
`useExpandBloom` already persists `relation: "expand"` + `scale`,
`apps/web/hooks/useExpandBloom.ts:119-120`) — **plus** `scale_tier` (the peer's rung == the
source's) and the bearing. Gated `SCALE_AROUND_LOGICAL`; flag off → the arbitrary VLM path
exactly as it ships now.

---

## Phase 3 — DEEPER (reuse, don't rebuild)

DEEPER already works and is the most-proven path (audit §6.1: "tap → enter loop closed live,
city → Unseen University → courtyard"). **Reuse it unchanged**:

`geo-tap.ts` `geoTapRequest` (apps/web/lib/geo-tap.ts:64) → `render_mode`
`place_submap` (Kontext `zoom_continue`, model_router.py:52) or `place_scene` (guarded fresh
gen, model_router.py:54) → `deriveGeoFromExtraction` seeds the child frame and **learns the
child's `scale`** (world-map.ts:369-377), which is what already gives DEEPER its
size-consistency (a child's local pos resolves to a true absolute coordinate via
`resolveAbsolutePos`).

**The only addition:** stamp `scene_view.scale_tier = childTier` on the entered node (one rung
below the parent's tier; clamp at `object`). That makes DEEPER and OUTWARD share **one
ladder** — a tap-in is a `tierStep` of −1, an OUTWARD is +1, and a node's tier is consistent
no matter which direction reached it. No generation change, no new model.

---

## Phase 4 — Metric-conservation invariants (the correctness core)

Four invariants. INV-1 and INV-2 are **pure functions with golden tests** extending
`apps/web/lib/world-geometry.test.ts` (the existing parity/golden suite the audit §2 calls
"parity+fuzz").

- **INV-1 — absolute position conserved across transitions.** A transition (OUTWARD, DEEPER)
  must not move an entity's absolute world coordinate. `resolveAbsolutePos`
  (world-geometry.ts:295) is unchanged; OUTWARD satisfies it **by construction** because the
  embedded child gets `scale = meters(C)/meters(P)` (the same footprint÷extent law as
  `deriveGeoFromExtraction`, world-map.ts:374-376), so resolving any of C's descendants
  through the newly inserted P yields the same `(x, y)` as before the reparent. **Golden
  test:** seed a small map, run the OUTWARD reparent, assert `resolveAbsolutePos(leaf)` is
  byte-identical before/after for every leaf.
- **INV-2 — metric span monotonic on the ladder.** Going OUTWARD must strictly **increase**
  the metric span; DEEPER must strictly decrease it. `tierMetricMultiplier(from, to)`
  (Phase 0) must be `> 1` for ascend, `< 1` for descend (or `== 1` only between the
  deliberately-equal `world`/`planet` rungs). A transition whose learned fine `scale`
  disagrees in sign with the tier step is a **mis-classified rung → reject** (don't persist;
  log + fall back). Pure, golden-tested.
- **INV-3 — style lock propagates EVERY hop.** The `session_style_anchor` /
  `style` reference (the medium-lock lever from Workstream A2 — `session_style_anchor` is
  already threaded, generate.py:152/654; `style_anchor` is prepended at generate.py:804-810)
  rides every OUTWARD / AROUND / DEEPER generation. For OUTWARD's outpaint path style is
  conserved automatically (original pixels stay); for the fresh-gen path it's the explicit
  `reference_urls` + the `scale_parent` clause. Enforced at the call site, not a separate
  check.
- **INV-4 — one ladder.** `scale_tier` (coarse) and the fine `WorldEntityGeo.scale` must
  agree: a node deeper on `SCALE_LADDER` has a smaller resolved metric span. They are two
  resolutions of the SAME axis, never a parallel system (this is the checklist's load-bearing
  item — see EVALUATOR CHECKLIST #2).

---

## Phase 5 — State + UX

**State (all additive, all back-compat):**

- New optional `scale_tier` column on the node (Phase 0) — `relation` gains the new
  `"ascend"` value in the `NodeRelation` union (config:12) and in the db.ts string unions
  (`"descend" | "expand"` at db.ts:119/139/157/174/196, the nodes route at
  nodes/route.ts:22). Defaulted on read (`toRow`, db.ts:174) so pre-`ascend` rows are
  unaffected.
- OUTWARD reparents the old root (Phase 1 STATE).
- **Atlas multi-scale nesting is already supported.** `atlas-view.tsx` already computes each
  node's absolute scale-level by BFS over `scaleStep` (`lvl + scaleStep(child)`,
  atlas-view.tsx:222) and feeds it to `lodOpacity` (world-layout.ts:341, called at
  atlas-view.tsx:528/593) so "small stuff reveals when you zoom in". **Feed `scale_tier` in
  when present** (it's a better, absolute level than the relative BFS), and **fall back to
  the BFS `scaleStep` when absent** — a drop-in, since both produce the same integer-level
  input `lodOpacity` consumes.
- **Store metric span in LOG space.** The ladder spans ~27 orders of magnitude
  (`SCALE_TIER_METERS`); comparing/feeding raw metres is numerically unstable and would
  saturate `lodOpacity`'s `Math.log2` (world-layout.ts:350). Persist/compare
  `log10(meters)`; the LOD math is already octave-based (world-layout.ts:350-351), so this is
  natural.

**UX (the existing primaries stay untouched):**

- `tap = ENTER` (DEEPER) and `expand = AROUND` stay exactly as they are — additive-only, no
  muscle-memory change.
- A **new, distinct "zoom out / step back" control** (its own button + keyboard shortcut,
  **never bound to tap**) fires `mode: "ascend"`, behind `SCALE_OUTWARD`. Surface it in the
  existing **`SpatialPath`** zoom-out stack (`apps/web/components/PlayPage/SpatialPath.tsx`),
  which already renders ancestry as nested cards you click to zoom out to
  (SpatialPath.tsx:11-15) — OUTWARD adds a card *above* the current root rather than only
  navigating to an existing one.

**Flags (all default-off except where noted):**

| Flag | Gates |
|---|---|
| `SCALE_LADDER_NAV` | master — nothing in this doc runs without it |
| `SCALE_OUTWARD` | the OUTWARD branch + the zoom-out UI control |
| `SCALE_AROUND_LOGICAL` | the Phase-2 priority cascade (off → today's arbitrary VLM bloom) |
| `SCALE_OUTWARD_RERENDER` | the medium-flip fresh-gen OUTWARD path only (the riskier one) |

All new fields optional; **TS↔Py schema parity maintained** (the `SceneView` Pydantic mirror
at generate.py:101 tracks the config:478 interface; `ViewEstimate` mirrors at config:511 ↔
view_estimator.py:19).

---

## The 3 biggest risks + de-risking

1. **Compounding style/content drift across hops.** Each generated hop can nudge the art
   medium or invent content; over a 5-hop OUTWARD climb that compounds into a different
   world. The audit already measured this is real and *situational* (§6.5 B3: region
   conditioning is **+0.33/10 mean, variance −4↔+4** — it helps on legible crops, injects
   top-down artifacts on ambiguous ones).
   **De-risk:** (a) **style lock every hop** (INV-3 — the medium-lock anchor, not just
   palette); (b) **prefer outpaint** for OUTWARD wherever possible (`expand_image_zoomout`
   keeps the original pixels → zero drift on the small-hop path; the fresh-gen path is gated
   off behind `SCALE_OUTWARD_RERENDER`); (c) **codex fact-sheet** so content is *named*, not
   re-invented (Phase 2 source 2, the `Entity.facts`); (d) **A/B with the shipped
   `coherence_runner`** (`tests/continuity_bench/coherence_runner.py`, `make eval-coherence`)
   at **N ≥ 10** before trusting any path — the audit explicitly flags N=3 as too noisy
   (§6.5 B3).

2. **Metric blowups across 27 orders of magnitude.** A naive "visual zoom == metric span"
   coupling makes a `planet → star_system` hop either an unreadable map or a number that
   overflows the LOD math.
   **De-risk:** (a) **decouple visual-zoom from metric span** — visual zoom is clamped ~×3-4
   per hop, metric span follows the ladder independently; (b) **log-space LOD** (Phase 5 —
   the octave math already wants log, world-layout.ts:350); (c) **INV-2** rejects
   mis-classified rungs that would imply a non-monotonic span; (d) **clamps** modelled on the
   existing `Math.min(Math.max(scale, 1e-3), 10)` guard (world-map.ts:375) plus auto-inserted
   intermediate rungs.

3. **Parent-inversion tree corruption.** OUTWARD is the only operation that rewrites an
   existing edge (`C.parent_id`), and a half-applied reparent (P inserted, C not re-pointed,
   or a cycle) corrupts navigation and `resolveAbsolutePos`.
   **De-risk:** (a) **atomic reparent** under the existing `optimisticReplace` loop
   (world-map.ts:264) — insert P then re-point C, or roll back; (b) **cycle-guard** (P is a
   fresh root with no ancestors; `resolveAbsolutePos` is already cycle-guarded,
   world-geometry.ts:299-309); (c) **abort-safe** (failure leaves C untouched, deletes the
   orphan P); (d) **regression tests** asserting the tree stays acyclic and every leaf's
   absolute position is conserved (INV-1) after a reparent.

---

## Open questions

- **Rung classification confidence.** `view_estimator` is one VLM call that "degrades to the
  top-down default on any failure" (view_estimator.py:62-63). A wrong `scale_tier` on an
  OUTWARD hop picks the wrong model AND the wrong metric multiplier. Do we gate OUTWARD on a
  confidence floor and ask the user when unsure (the World-Mode `clarifiers` UX already
  exists, ResolveClickResponse.clarifiers config:159)?
- **`world` vs `planet` rung.** They share a metres anchor; is "world" even a distinct rung,
  or a synonym we should collapse to keep the ladder strictly metric-monotonic?
- **AROUND across a seam.** A same-tier neighbour that lives under a *different* parent (the
  next city in the region) — does `selectNeighbors` cross the `parent_id` boundary, and if so
  whose frame owns the bearing?
- **Outpaint factor vs rung ratio.** A fixed ×3 `expand_image_zoomout` rarely equals the
  rung's true metric multiplier. Is "the source is *a* sub-region" (recognizable but not
  to-scale) good enough, or do we need the factor to track `tierMetricMultiplier` (and then
  clamp + intermediate-rung)?
- **BRIA centered-canvas limits.** `_zoomout_args_for` assumes BRIA accepts an arbitrary
  centered `original_image_location`; `scripts/verify-fal-models.py` should confirm the
  live schema before this is trusted (same caution the router already documents,
  model_router.py:8-12).

---

## Critical files

- `packages/config/src/index.ts` — `GenerateMode` :3, `ScaleKind` :8, `NodeRelation` :12,
  `WorldContextEntity` :95, `NodeRecord`/`NodeCreateRequest` :271-291, `WorldEntityGeo`
  :420-451 (the `.scale` field at :449), `ObserverPose` :454, `ViewLevel` :474,
  `SceneView`(+`.level`) :478,
  `ProjectedEntity` :491, `ViewEstimate` :511. **New:** `SCALE_LADDER` / `SCALE_TIER_METERS`
  / `ScaleTier` / `tierStep` / `tierMetricMultiplier`; `scale_tier?` on the above; `"ascend"`
  in `NodeRelation`; `"ascend"` in `GenerateMode`.
- `apps/web/lib/world-geometry.ts` — `project`/`projectScene` :66-129, `estimateGeoFromBBox`
  :165, `neighborsOf` :232, `siblingsOf` :281, `resolveAbsolutePos` (affine) :295-320,
  `localExtent` :344. (Unchanged; INV-1/INV-2 golden tests extend
  `world-geometry.test.ts`.)
- `apps/web/lib/world-map.ts` — `applyGeoUpsert` (source authority) :78, `deriveGeoFromExtraction`
  (learns parent `scale` = footprint÷extent, clamp :375) :331-380, `upsertEntityGeos`
  /`optimisticReplace` :259-285.
- `apps/web/lib/world-layout.ts` — `layoutPages` (nests generically) :78-152, `scaleStep`
  :325, `lodOpacity` :341, `fitCamera` :361.
- `apps/web/lib/geo-tap.ts` — `geoTapRequest` (DEEPER, reused) :64-156, `MAP_IMAGE_FRAME` :24.
- `apps/web/lib/db.ts` — `NodeDoc`/`NodeInsert`/`NodeRow` (+`relation`/`scale`/`scene_view`)
  :101-164, `toRow` :166, `insertNode` :181. **New:** `scale_tier?` + `"ascend"`.
- `apps/web/app/api/nodes/route.ts` — `CreateBody` :22 (+`scale_tier`, `"ascend"`).
- `apps/web/components/atlas-view.tsx` — BFS scaleStep→level :222, `lodOpacity` calls
  :528/593 (feed `scale_tier`, fall back to BFS).
- `apps/web/components/PlayPage/SpatialPath.tsx` — zoom-out stack :11-15 (the OUTWARD control's
  home).
- `apps/web/hooks/useExpandBloom.ts` — persists `relation:"expand"` neighbours :119-120
  (AROUND adds `scale_tier` + bearing).
- **New:** `apps/web/lib/scale-neighbors.ts` — `selectNeighbors` (Phase 2 cascade).
- `apps/modal-backend/generate.py` — Pydantic `SceneView` :101, `GenerateBody.mode` :131 /
  `scene_view` :174 / `expected_layout` :175, `_layout_clause_for` :196, `_topdown_clause_for`
  :210, edit branch :408-450, EXPAND_MAP_PAN branch :470-540, subject-bloom :542-645,
  `render_mode` compose :799-829, `select_operation`/`continue_image` wiring :853-919,
  `estimate_view` call :1449-1463. **New:** isolated `ascend` branch (gated
  `SCALE_LADDER_NAV`+`SCALE_OUTWARD`); `scale_tier` on the Pydantic `SceneView`.
- `apps/modal-backend/providers/image_edit.py` — `_expand_args_for` :184, `_img_dims` :204,
  `_dims_from_data_url` :228, `_expand_first_image` :239, `expand_image` (directional) :248,
  `continue_image`/`build_zoom_instruction` (Kontext) :104-172. **New:** `expand_image_zoomout`
  + `_zoomout_args_for` (centered outpaint).
- `apps/modal-backend/providers/model_router.py` — `MODEL_SLOTS` :19-25, `resolve_model` :28,
  `select_operation` :37-54. **New:** `select_outward_op` (pure, by tier delta).
- `apps/modal-backend/providers/llm.py` — world-context clause :1209, `propose_neighbors`
  :1577 (+ optional `known_neighbors` + `scale_tier`), `plan_page` (new `scale_parent`
  render_mode clause).
- `apps/modal-backend/providers/view_estimator.py` — `ViewEstimate` :19, `estimate_view` :61
  (+ guess `scale_tier`).
- `tests/continuity_bench/coherence_runner.py` (`make eval-coherence`) — the A/B harness
  reused at N ≥ 10 for the drift de-risk.

---

## EVALUATOR CHECKLIST

1. **Explicit, ordered, metric-conserving ladder + per-transition multiplier + INV-1 golden
   test.** ✅ `SCALE_LADDER` (universe…object, ordered) + `SCALE_TIER_METERS` (order-of-mag
   metre anchor per rung) in `packages/config`; `tierStep` = index delta; per-transition
   multiplier = `tierMetricMultiplier` = ratio of rung metres (Phase 0). INV-1 (absolute
   position conserved) is a pure function over `resolveAbsolutePos` with a golden test
   asserting byte-identical leaf coords across an OUTWARD reparent (Phase 4).
2. **One ladder, not a parallel system — extends `SceneView.level` / `WorldEntityGeo.scale` /
   `resolveAbsolutePos`.** ✅ `scale_tier` is the **coarse absolute rung**;
   `WorldEntityGeo.scale` (config:449) stays the **fine per-frame metric** the affine
   `resolveAbsolutePos` (world-geometry.ts:295) already composes; INV-4 forces them to agree
   in sign/order. DEEPER and OUTWARD stamp the SAME `scale_tier` axis (a tap is `tierStep`
   −1, OUTWARD +1). Nothing is replaced (Phase 0, Phase 3, INV-4).
3. **OUTWARD specifies outpaint-vs-rerender via a PURE `select_outward_op`, and the source
   lands as the center sub-region.** ✅ `select_outward_op(from, to)` in `model_router.py`
   (pure, beside `select_operation`): small same-plane hop → centered BRIA outpaint
   (`expand_image_zoomout`, source centered, full margin painted → source becomes the central
   sub-region); medium-flip large hop → reference-conditioned fresh gen (gated
   `SCALE_OUTWARD_RERENDER`). Reuses the `outpaint`/`fresh` `MODEL_SLOTS` (Phase 1).
4. **AROUND is logical via `neighborsOf`/`siblingsOf` + codex with bearings; the arbitrary
   path is gated off.** ✅ `selectNeighbors` cascade: (1) geometric `neighborsOf`/`siblingsOf`
   same `parent_id`+`scale_tier` with real bearings → (2) codex same-tier same-region facts →
   (3) constrained `propose_neighbors` (peers at the SAME scale, pass `known_neighbors` +
   `scale_tier`) only cold-start. `SCALE_AROUND_LOGICAL` off → today's arbitrary VLM bloom
   verbatim (Phase 2).
5. **DEEPER reuses the existing enter flow and only stamps the rung.** ✅ `geo-tap.ts` →
   `place_submap`/`place_scene` → `deriveGeoFromExtraction` child-frame `scale` seeding, all
   **unchanged**; the sole addition is `scene_view.scale_tier = childTier`. No generation or
   model change; size-consistency already holds via the learned per-frame `scale`
   (Phase 3).
6. **Reuses BRIA / Kontext / the geometric world — no new image models.** ✅ OUTWARD small-hop
   = existing BRIA (`fal-ai/bria/expand`, model_router.py:22) via a new *centered* arg
   shaper; OUTWARD medium-flip = the existing `generate_image` fresh path; DEEPER = existing
   Kontext `zoom_continue` (model_router.py:21) + fresh; AROUND = existing
   `propose_neighbors` + geometry. The only new *code* is arg shapers / pure selectors / a TS
   neighbour module — zero new models (Phases 1-3, Critical files).
7. **Additive + flag-gated + back-compat + TS↔Py parity.** ✅ Every new field optional
   (`scale_tier?`, `known_neighbors?`); every behaviour behind `SCALE_LADDER_NAV` (master) +
   `SCALE_OUTWARD` / `SCALE_AROUND_LOGICAL` / `SCALE_OUTWARD_RERENDER`, all default-off;
   `"ascend"` added to unions without breaking the `?? "descend"` defaults (db.ts:174); the
   `SceneView` Pydantic mirror (generate.py:101) + `ViewEstimate` mirror (view_estimator.py:19)
   track their config interfaces (Phase 5).
8. **The three risks are addressed (drift, blowups, inversion).** ✅ Drift → INV-3 style lock
   every hop + prefer outpaint (zero-drift small hop) + codex fact-sheet + `coherence_runner`
   A/B at N ≥ 10. Blowups → visual-zoom/metric-span decoupling + log-space LOD + INV-2 +
   `world-map.ts:375`-style clamps + intermediate rungs. Inversion → atomic reparent under
   `optimisticReplace` + cycle-guard (`resolveAbsolutePos` `seen` set) + abort-safe +
   INV-1 regression tests (Risks section).
