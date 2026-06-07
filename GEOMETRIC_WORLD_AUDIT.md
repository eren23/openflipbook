# Geometric World — Audit & Gap-Closing Plan

_Grounded in the code (not memory). Verified against the live Ankh-Morpork run that
seeded **0 geo entities**._

## 0. The original vision (the target)

One persistent 2D coordinate world. Every entity has a map `(x,y)` + `height` +
`footprint` + `elevation`. An observer has a pose `(x,y, eye_height, gaze, fov, pitch)`.
A rendered scene is a **view** of the in-frame entities from that pose — and there is
**no single correct view** (map / building / street / eye). Tapping computes, _from
coords_, what's in the tapped area and whether it's a sub-map or a scene. Anchors snap
entities to coords and know their neighbours. A VLM **grounding loop** audits each render
against the expected layout and repairs it. A **living, NL-editable** entity list with an
edit **blast-radius**. (Driven by the two sketches: a 2D map + `B1/B2/T1/T2` rendered from
two observer poses.)

## 1. The core realization (what Ankh-Morpork exposed)

There are **two directions**, and we built only one:

- **Authored-first** `coords → render`: you have/author the world map, project it, steer
  + ground the render, NL-edit it. ← **built + tested**, but **not wired** into the live app.
- **Generated-first** `render → world`: you generate a free-form image (the Ankh map),
  then read the geometry **back out** of it. ← **essentially not built.** A normal session
  is generated-first, so the geometric world **never bootstraps**.

## 2. Component status (honest)

| Component | Built | Tested | Wired live | Works e2e |
|---|:--:|:--:|:--:|:--:|
| Engine: project / projectScene / crop / neighbors | ✅ | ✅ parity+fuzz | ✅ pure | ✅ |
| Z-axis (elevation + pitch) | ✅ | ✅ | ✅ | ✅ |
| `world_map` persistence (Mongo) | ✅ | ✅ | ✅ | ✅ |
| Seeding bridge `estimateGeoFromBBox` | ✅ | ✅ | ⚠️ | ❌ **seeds 0** (needs bboxes; assumes top-down) |
| Layout-steering clause (P3) | ✅ | ✅ (+0.5 A/B) | ⚠️ gated in `generate.py` | ❌ **inert** (no `expected_layout` sent) |
| Grounding verify→repair (P4) | ✅ | ✅ | ⚠️ gated in SSE | ❌ **inert** (nothing to diff) |
| NL-edit + blast-radius (P5) | ✅ | ✅ | ✅ codex | ✅ _when geo seeded_ |
| click-route (P6) | ✅ | ✅ | ❌ | ❌ taps use old World Mode |
| ObserverGazeEditor / world-overlay | ✅ | ✅ | ❌ | ❌ not mounted |
| **Camera / view-level estimation (image→pose)** | ❌ | — | ❌ | ❌ **missing** |
| **Reliable localization (force bboxes / detector)** | partial | — | ❌ | ❌ extractor bbox is **optional** → 0 |
| **Coordinate overlay on images** | ❌ | — | ❌ | ❌ **missing** |
| Send geometry in generate request | ❌ | — | ❌ | ❌ play page sends none |
| Store `scene_view`/`expected_layout` on node | type only | — | ❌ | ❌ never written |
| Atlas geo overlay | ❌ | — | ❌ | ❌ coord-system mismatch |

## 3. The gaps, by root cause (the four ROOTs)

- **ROOT 1 — No perception pass (`image → geometry`).** _(Problem 1: the 2.5D map.)_
  We never look at a render to estimate its camera/view-level or localize entities. The
  only `image→geometry` is `estimateGeoFromBBox`, which (a) needs bboxes the extractor
  marks **optional** and skips, and (b) hard-assumes a **flat top-down** map (wrong for a
  2.5D render). → the world never seeds from a generation, and at the wrong angle if it did.

- **ROOT 2 — The generate request is geometry-blind.** _(Problem 2: invented placement.)_
  The play page sends no `scene_view`/`expected_layout`; nodes never store one. So
  steering (P3) + grounding (P4) are **inert live** — the model free-styles placement and
  nothing audits it.

- **ROOT 3 — Going-in is geometry-blind.** The tap handler uses shipped World Mode
  (subject → fresh prompt), not `click-route → observer pose → steered+grounded generate`.
  `click-route` is built+tested but **unmounted**.

- **ROOT 4 — No visibility.** No overlay to SEE what geometry an image has → impossible to
  debug or trust.

## 4. Fix plan (root-cause, ordered so each unblocks the next)

- [x] **FIX 0 — Coordinate overlay layer.** ✅ `GeometryOverlay` draws each entity's
  localized box over the image; `⊞ geo` toggle in the node action row. Live on the
  Ankh map. _Closes ROOT 4._
- **FIX 1 — Perception pass (`image → world`).**
  - [x] **1a — Localize (force bboxes).** ✅ run the detector after extraction → every
    entity gets a box (Ankh: 0 → **7/7**); the world map seeds (0 → 7 entities). _The
    keystone — ROOT 1's data gap is closed._
  - [x] **1b — Estimate view-level + camera.** ✅ `view_estimator.estimate_view` →
    `{ level, projection, pitch_deg }`, rides on the extract response. We now *know*
    the Ankh map is oblique, not top-down.
  - [x] **1c — Back-project with the camera.** ✅ oblique/perspective → height from the
    box's vertical extent (varied, not flat h4); top_down → box-as-footprint. _Honest:
    relative, not metric (a box wraps a cluster)._

**Perception half (image → world) is DONE: localize + classify camera + back-project.**
Remaining = the **consume/integrate** half (FIX 2 + 3) — make *generation* geometry-aware.
- [ ] **FIX 2 — Thread geometry through generation + store it.** When a `world_map` exists:
  compute `scene_view` + `expected_layout` (project the in-frame entities from the observer),
  send them in the generate request (`WORLD_GEOMETRY_GEN` on), store them on the node, turn
  grounding on. → steering + grounding go live; the overlay (Fix 0) gets data. _Closes ROOT 2._
- [ ] **FIX 3 — Wire click-route into the tap handler.** Tap → `click-route` → observer pose
  → Fix 2's steered+grounded generate. → going-in becomes geometry-driven. _Closes ROOT 3._
- [ ] **FIX 4 (later) — Atlas geo overlay** once the geo↔node-layout coord relationship is decided.

## 5. The honest bottom line

The **authored-first** pipeline (engine → steer → ground → NL-edit) is real, tested, and
strong — but **nothing feeds it geometry in the live app**, and the **generated-first
perception** that a normal session needs **does not exist**. Closing ROOT 1 (perception) is
the load-bearing fix; ROOT 2 makes it act on generation; ROOT 3 makes tapping use it; ROOT 4
(the overlay) makes all of it visible. Order: **0 → 1 → 2 → 3.**
