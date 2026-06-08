# Geometric World — Audit & Gap-Closing Plan

_Grounded in the code (not memory). Verified against the live Ankh-Morpork run that
seeded **0 geo entities**._

_**Update 2026-06-08** — §0–§5 are the **perception-era** audit (the "0 geo entities"
run). [§6](#6-the-felt-experience-era-2026-06-07--06-08--bringing-this-current) brings
this current through the felt-experience wave: the tree now seeds, loops live, and **reads**.
The §2 status table is historical; §6.4–6.5 are the live status._

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
- [x] **FIX 2 + 3 — Geometric tap (loop closed).** ✅ `lib/geo-tap.ts`: a World-Mode tap on
  the seeded map routes through click-route → an observer pose → `projectScene` →
  `expected_layout`, sent in the generate request. `generate.py` steers on it (P3) + grounds
  against it (P4). Going-in is geometry-driven; the entered scene is laid out by where the
  entities are. Gated (inert unless seeded + WORLD_GEOMETRY_GEN/VLM_GROUNDING). _Closes ROOT 2+3._
- [x] **Metric lever — `WORLD_TOPDOWN_MAPS`.** ✅ forces flat top-down map renders → the seed
  is EXACT (box = footprint), sidestepping the monocular-pose ceiling Codex named. Opt-in.
- [ ] **FIX 4 (later) — Atlas geo overlay** once the geo↔node-layout coord relationship is decided.

## 4b. Codex second-opinion audit (875ab50)

Codex ran `make eval` (green) and found 8 issues. Triage + outcome:

- [x] **#2** FIX 1a centre→top-left clipped only one corner → edge boxes overflow/shift. **Fixed** (clip all 4 edges).
- [x] **#1** extract bridge hard-coded `level:"map"`, only threaded `projection` → scene captures seeded as fake top-down. **Fixed** (only MAP images seed).
- [x] **#6** grounding reported `extra` but never penalized → hallucination scores 1.0. **Fixed** (extras drag the score).
- [x] **#4** no vertical-FOV cull → unbounded `y_pct` (oracle held −1.7) leaks into golden + grounding. **Fixed** (cull both engines; 274→259, parity holds).
- [ ] **#3** recurring `updated` entities never get a bbox (schema/parser/applyUpdate) → drop from geometry on re-appearance. _Deferred — needs the update path to carry + persist bboxes._
- [ ] **#5** oblique height = `h_pct·crop.h·0.5` ignores `pitch_deg`/pose. _Known fudge (already flagged honest)._
- [ ] **#8** overlay maps to the 16:9 wrapper, not the `object-contain` image rect → non-16:9 uploads letterbox + drift. _Deferred._
- #7 "parity gate blesses shared math, not correctness" → true; the fix is fixing the math (#4), which we did.

**Codex's single biggest risk (matches §1):** the system *classifies* the camera but never *recovers or persists a metric observer pose*, so geometry from a generated image is **relative, not metric**. The cleanest path to metric is the top-down-map lever (prompt a flat overhead map → exact bbox→world), not better monocular estimation.

## 5. The honest bottom line

The **authored-first** pipeline (engine → steer → ground → NL-edit) is real, tested, and
strong — but **nothing feeds it geometry in the live app**, and the **generated-first
perception** that a normal session needs **does not exist**. Closing ROOT 1 (perception) is
the load-bearing fix; ROOT 2 makes it act on generation; ROOT 3 makes tapping use it; ROOT 4
(the overlay) makes all of it visible. Order: **0 → 1 → 2 → 3.**

## 6. The felt-experience era (2026-06-07 → 06-08) — bringing this current

§0–§5 are the **perception-era** audit (the "seeds 0 geo entities" run). Since then the
engine got wired, the loop closed **live**, and the work moved from _does the geometry
exist_ to _can you read / control / trust it_. This is the current state; the §2 table is
historical.

### 6.1 Perception gaps — closed, live-proven
- **Tap→enter loop closed live.** `geo-tap.ts` routes a map click → observer pose →
  `projectScene` → `expected_layout` → `generate.py` steers (P3) + grounds (P4). Live chain:
  **city → Unseen University → courtyard** (3 levels); grounding provably fired (hard-gated
  on `expected_layout`, `generate.py:892`).
- **THE "felt-dead" bug (`94a33b1`).** `geoTapRequest` routed taps through the entities'
  _tight_ bbox, but seeds place entities on the full-image frame `{0,0,100,60}` → taps
  landed ~5 world-units off the footprint → no scene → enter/popover never fired. Fixed with
  a shared `MAP_IMAGE_FRAME` used by **both** seed and router (+ regression test). _This was
  the single thing making the world feel inert._
- **Metric lever `WORLD_TOPDOWN_MAPS`** remains the only honest metric bridge: authored→render
  is metric; generated→coords stays _relative_ via `estimateGeoFromBBox` + the top-down clause.

### 6.2 The felt-core (Ph1–6, 7 commits, all gate-green)
The geometry existed but didn't _speak_. Six additive, flag-gated passes:
- **Ph1 — minimap truth** (`3d341a5`): scope to the frame you're inside (`childrenOf` + local
  bounds) — kills city-coords-on-a-sub-part.
- **Ph2 — persist + restore the observer** (`6e340c6`): `insertNode` was silently dropping
  `scene_view`; now written / read / hydrated. → §2 "_Store scene_view on node: never written_"
  row is **closed**.
- **Ph3 — observer/gaze popover** (`27f448d`): ⌘/Ctrl-tap mounts the orphaned
  `ObserverGazeEditor`. → §2 "_ObserverGazeEditor: not mounted_" row is **closed**.
- **Ph4 — revive submap** (`89a8406`): tap empty space → crop a sub-map (`{kind:"submap"}`).
- **Ph5 — atlas anchors** (`4b44b7e`): per-tile coords + gaze tick + "near:" neighbours.
- **Ph6 — zoom-out-stack nav** (`92e25c1`): ancestry as nested cards (`SpatialPath`).

### 6.3 Multi-agent audit verdict (2026-06-08): **incoherent AND illegible**
A 4-agent workflow (UX / coherence / code lenses + a synthesizer re-reading the live
screenshots) returned a two-word verdict:
- **Illegible (A).** Relationship data is all _stored_ (relation, level, depth, scale) but the
  tree rendered every node — big map, sub-part, neighbour, scene — as the same tile + same
  dashed connector. The first A-wave badges rendered in _world space_ → sub-pixel smudges at
  fit-all zoom.
- **Incoherent (B) — the load-bearing one.** An entered place was a from-scratch render, not a
  zoom of its parent. The conditioning primitive was wired but geo tap-ins never triggered the
  aligned path, so every enter fell to a loose nano-banana "fresh" gen.
- **Verified bugs:** **#6** in-session connectors dead (`relation` never set); **#7** popover
  racy (`geoMap` empty until async refetch lands); **B2 nuance** — `continue_image` is called
  with `zoom_instruction`, _not_ the composed prompt, and takes one ref regardless of model →
  carry parent/world context **textually**.

### 6.4 Closed against that verdict (live status)
- **A / legibility — CLOSED.** A-wave (`5b8ec7a` atlas, `bdda9e8` in-page map): `node-kind.ts`
  per-tile type+relation badges. UX PR (`0ab5ba0`): counter-scaled badges (legible at _any_
  zoom), tile **FRAME** coloured by view level (🗺 amber `#d97706` / 🏛 violet `#7c3aed` /
  👁 cyan `#0891b2` / scene slate, red overriding focus), atlas legend. Live-confirmed in the
  atlas screenshot — the tree now reads at a glance.
- **B / coherence — IMPROVED, live-verified (one sample), _not_ eval-proven.** B1 (`75fa188`)
  sets `render_mode` on the geo enter (submap → Kontext zoom-continue; scene → guarded fresh,
  spread-last so it wins). B2 (`612fbd8`) adds a `place_scene`-only "_reproduce its structures,
  colours, landmarks and layout faithfully — a closer, continued view of that exact place, not
  a new invention_" clause. Live: entered the **Spire of Aether → rendered AS the Spire** (a
  faithful blue-crystal tower) vs the audit's old incoherent courtyard. **One sample —
  encouraging, not conclusive.** _The guard is load-bearing:_ map→scene first-enters stay on
  nano-banana (Kontext is poor at top-down→oblique reprojection); Kontext is for scene→scene.
- **#7 popover race — CLOSED (`d9be168`).** The modifier branch refetches
  `/api/world/[sessionId]/map` when the closure's `geoMap` is empty, threading the fresh
  entities into both `geoTapRequest` and the `focusEnt` lookup → the first ⌘-tap after a gen
  opens the popover reliably (the "finicky" cause). _Trade:_ one `await fetch` in the tap path,
  but only when `geoMap` is empty (right after a gen). The stale-closure root is worked around,
  not eliminated (the `geoMap` deps stay out of the big binding effect by design).

### 6.5 Honestly remaining
- [ ] **#6 (minor).** `relation` is never assigned on the in-session `Page` payload — confirmed:
  `play/page.tsx:139` is the _only_ occurrence (the type decl), never set. So in-page-map
  connectors can't tell descend from expand; every in-session node defaults "descend". The
  **atlas** has both (it reads the persisted `relation`); only the rare in-session
  expand-neighbour case is affected.
- [x] **B3 (paid — the coherence verdict) — RAN 2026-06-08, and it's sobering.** A real
  with/without-conditioning A/B (`tests/continuity_bench/coherence_runner.py`, `make
  eval-coherence`): enter each place WITH (region crop ref + B2 faithful preamble) vs WITHOUT
  (fresh), Gemini-judge each for faithfulness vs the parent map crop. On the fresh Brightharbor
  session (N=3, nano-banana-pro): **with 5.00 vs without 4.67 → mean lift +0.33 / 10**, but with
  **huge variance**: Lighthouse **+4.0** (conditioning anchored the right landmark), Cathedral
  +1.0 (both weak), Tidewater Market **−4.0** (the top-down crop's pixels leaked a spurious
  conical-roof building into the oblique render — the fresh gen was already good). **Verdict:
  region-conditioning is _situational_, not a reliable lift** — it helps when the crop is legible,
  hurts when the place is ambiguous or the crop injects top-down artifacts. The single live "Spire"
  sample was a Lighthouse-type win, not representative. A real number needs N≥10–15; and this
  reinforces the map→scene guard (a top-down crop is double-edged for an oblique enter). _The
  judge is gradeable code now; the harness is reusable for the larger run._
- [ ] **Pre-PR hygiene.** Branch is **+13.4k / −471 over 170 files**, based on _pre-merge_
  world-mode → **merge `main` first**. ~~Stray root-level debug pngs~~ — `state-check.png`
  (1.2 MB), `ankh-topdown.png`, `geo-overlay-figure.png`, `geo-overlay-on.png` were tracked
  cruft at the repo root; **removed** (the legit demo artefacts stay under
  `scripts/record-demo/artifacts-geo/`).
- [ ] **Deferred backend depth (Ph7–9).** Per-entity VLM verdicts, detect→confirm→edit loop,
  model-per-category routing. Available, not started.

### 6.6 Revised bottom line
The perception era answered _does the geometry exist and act_ — **yes**: wired, looped,
live-proven. The felt era answered _can you read and trust it_: it is now **legible**
(type/relationship speak at every zoom) and **reliably enterable** (the routing-frame + popover
fixes were the "felt-dead" causes). **Coherence (B) now has a number, and it's honest: B3 = +0.33/10
mean lift, N=3, variance −4↔+4 — region-conditioning is _situational_, not a reliable win.** It
anchors legible landmarks (Lighthouse +4) but injects top-down artifacts on ambiguous map→scene
enters (Tidewater −4). So the felt layer (legibility, reliable enter) is solid; the _generative_
coherence of an entered place is the genuinely-open problem — B2 helps sometimes, and the next
real lever is the map→scene reprojection itself (the guard the audit named), not more prompt
nudging. Everything is additive + flag-gated + gate-green (**backend pytest / mypy / ruff +
the new `test_coherence`, 428 web tests, no circular deps, ESLint 16/20**). Not pushed; PR is
the user's call.
