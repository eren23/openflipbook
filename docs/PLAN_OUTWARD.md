# B2 execution plan — OUTWARD and on

_The design lives in `PLAN_SCALE_NAV.md` (evaluator-accepted). This is the **execution
roadmap** for the rest of B2, in build order, using the rhythm that worked for B1: a pure,
golden-tested core first → an independent audit → integration → a live UI proof. The
**keystone is already merged** — `SCALE_LADDER` / `SCALE_TIER_METERS` / `tierStep` /
`tierMetricMultiplier` / `tierTransitionValid` (INV-2) in `packages/config`, 5 golden tests._

## Where we are

- ✅ **Keystone** — the metric-conserving scale ladder + INV-2, tested. The foundation
  every direction stands on.
- ⏳ Everything below is unbuilt. Each phase is independently shippable behind its flag.

Master flag: `SCALE_LADDER_NAV` (off → the whole feature inert, prod byte-identical).
Sub-flags: `SCALE_OUTWARD`, `SCALE_AROUND_LOGICAL`, `SCALE_OUTWARD_RERENDER`.

---

## Phase A — `scale_tier` plumbing (additive, low-risk, do first)

Thread the optional `scale_tier?: ScaleTier` everywhere a frame is described, so OUTWARD/
DEEPER have a rung to read/stamp. All optional, all back-compat.

- `SceneView` (`packages/config/src/index.ts`) **and its Pydantic mirror** (`generate.py`
  `class SceneView`) — **update the parity fixture** `packages/config/src/world-geo-fixture.json`
  (the `test_geo_schema` SceneView keys + sample) in the SAME change, or the parity gate fails.
- `WorldEntityGeo` (config) — a map entity can carry its rung.
- `NodeDoc`/`NodeInsert`/`NodeRow` + `toRow` (`apps/web/lib/db.ts`), `CreateBody`
  (`apps/web/app/api/nodes/route.ts`) — persist + restore alongside the existing `relation`/`scale`.
- Seed it cheaply: extend `view_estimator.estimate_view` (`providers/view_estimator.py`) to
  also guess `scale_tier`, with a deterministic `ViewLevel→tier` fallback (`map→city`,
  `building→place`, `street→district`, `eye→room`). Mirror the `ViewEstimate` TypedDict ↔ TS.

**Verify:** `test_geo_schema` parity stays green; a node round-trips its `scale_tier`. No new
required field anywhere.

---

## Phase B — OUTWARD (`mode:"ascend"`) — the genuinely new direction

The structurally-novel part (the design's risk #3: inverting the tree). Build the pure core +
tests first, **then audit**, then integrate.

### B.1 — pure core (test first)
- `select_outward_op(from: ScaleTier, to: ScaleTier) -> "outpaint" | "rerender"` in
  `providers/model_router.py` (a pure decision beside `select_operation`): **outpaint** for a
  same-medium hop (city→region — BRIA paints more of the same plane); **rerender** when the
  medium flips (planet→star_system — a map becomes an orbit diagram). Golden-test the boundary.
- **INV-1 golden test** extending `apps/web/lib/world-geometry.test.ts`: seed a small map, run
  the reparent (below) in a pure helper, assert `resolveAbsolutePos(leaf)` is byte-identical
  before/after for every leaf (the embedded child gets `scale = meters(C)/meters(P)`, the same
  footprint÷extent law as `deriveGeoFromExtraction`).
- A pure `reparent(nodes, childId, parent)` in `apps/web/lib/world-map.ts` (or a new
  `scale-tree.ts`): insert P with `parent_id:null` + `relation:"ascend"`, re-point the old
  root's `parent_id → P`, cycle-guard (reuse `resolveAbsolutePos`'s `seen` set), abort-safe
  (only mutate after P fully persists). Golden-test reparent + the abort/double-ascend cases.

### B.2 — provider + planner
- `expand_image_zoomout(image, factor)` in `providers/image_edit.py` — BRIA outpaint with the
  source **centred** in a larger canvas (so the source becomes the central sub-region of the
  parent). Reuse the existing `expand_image` plumbing; clamp the visual zoom to ~×3–4/hop and
  auto-insert an intermediate rung when the metric jump is large (Risk 2).
- A `render_mode:"scale_parent"` planner clause for the fresh-gen path ("render the {N+1}
  that contains this {N}; place it as a recognisable sub-region; keep palette + medium").
- INV-3: `session_style_anchor` / the `style` ref rides every hop (outpaint conserves pixels;
  fresh-gen passes `reference_urls` + the clause).

### B.3 — integration
- `mode:"ascend"` branch in `generate.py`, modelled on the isolated `EXPAND_MAP_PAN` / edit
  branches (return early; never touch the tap/query path). Gated `SCALE_LADDER_NAV` + `SCALE_OUTWARD`
  (+ `SCALE_OUTWARD_RERENDER` for the medium-flip path, default off).
- Web: a thin proxy route; a **distinct** "zoom out / step back" control in `page.tsx`
  (never bound to tap — tap stays ENTER), firing `mode:"ascend"`; surface in the existing
  `SpatialPath` zoom-out stack. Reparent via a new/extended nodes route, atomic.

**Audit checkpoint** after B.1 (independent review of the reparent + INV-1) before integrating.

---

## Phase C — AROUND (logical, not random)

Make the existing `expand` bloom logical: a new pure `apps/web/lib/scale-neighbors.ts`
`selectNeighbors(focusId, geoMap, codex, tier)` layering (1) geometry `neighborsOf`/
`siblingsOf` (real bearings, same `parent_id` + `scale_tier`) → (2) codex facts → (3) a
constrained `propose_neighbors` (pass `scale_tier` + known facts, "peers at the SAME scale")
only as cold-start. Persist as today (`relation:"expand"`) + the rung + a bearing. Gated
`SCALE_AROUND_LOGICAL` (off → today's arbitrary bloom). Golden-test the cascade + bearings.

---

## Phase D — DEEPER (reuse, don't rebuild)

The shipped geo-tap enter flow is unchanged; the **only** addition is stamping
`scene_view.scale_tier = childTier` on enter so DEEPER and OUTWARD share one ladder. Size
consistency already holds via the learned per-frame `scale`. One small change + a test.

---

## Phase E — invariants live + the drift number

- **INV-4 (one ladder) — SHIPPED.** `ladderDisagreement(parentTier, childTier, learnedScale)`
  in `world-map.ts` (pure, unit-tested); `deriveGeoFromExtraction` warns + keeps the learned
  scale on a sign disagreement, never blocks.
- **OUTWARD drift A/B — deferred to when rerender is enabled (paid + manual).** The default
  OUTWARD path is the **centered BRIA outpaint, which is zero-drift by construction** (the
  source's pixels are preserved as the central sub-region), so there is no drift to measure
  while `SCALE_OUTWARD_RERENDER` is off — which it is by default. Only the medium-flip *fresh*
  path can drift; before enabling `SCALE_OUTWARD_RERENDER`, run an **N≥10 A/B** reusing the
  `coherence_runner` harness (`make eval-coherence`) — the design's risk #1 — and keep the flag
  off until the number justifies it. Not run here (paid; needs a live session + keys).

---

## Risks (from the design) + how this order de-risks them

1. **Compounding drift across hops** → INV-3 style lock every hop + prefer outpaint + the
   coherence A/B before trusting rerender.
2. **Metric blowups** (27 orders of magnitude) → store/compare span in **log space**; cap
   visual zoom per hop + auto-insert rungs; clamp the learned `scale` (as `deriveGeoFromExtraction`
   already does).
3. **Tree-inversion corruption** → reparent is pure + golden-tested first (B.1), atomic +
   cycle-guarded + abort-safe; INV-1 proves no leaf moves.

---

## Build order (one focused pass each, like B1)

`A (plumbing) → B.1 (pure reparent + select_outward_op + INV-1, AUDIT) → B.2/B.3 (OUTWARD
integration + UI, live proof) → C (AROUND) → D (DEEPER) → E (invariants + drift number)`.

Each phase: pure core + golden tests → independent audit on the risky ones → integration →
live UI proof → PR.

---

## Beyond B2 — the roadmap's last milestone

After B2, the remaining roadmap item is the **on-ramp** (provider-freedom → eval → worlds →
**on-ramp**): make the whole thing approachable for a first-time user — sensible default
flags, a guided first session, and the BYO-keys path documented. Scope it once B2 lands.
