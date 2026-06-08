# Place description → logical object world (design doc)

_Grounded in the code, not memory. This is a **design document** — nothing here is
implemented yet. It is written to the same discipline as `GEOMETRIC_WORLD_AUDIT.md`:
honest about what is a real primitive vs. a guess, every claim pinned to a file:line, and
no marketing. Where the audit's failures (ROOT-1/ROOT-2 — the model free-styling
placement, the world never seeding) bite this feature, I call them out and route around
them._

## What I'm building (and the three hard parts)

Take a **detailed natural-language description of a place** ("a corner coffee shop: a long
zinc counter on the back wall, four stools at the counter, a shelf of mugs behind it, the
door on the left wall, and the front-right corner left open for a queue") and turn it into
**all the relevant objects, arranged relative to each other on the shared 2D plane**, such
that:

1. **Objects sit in logically coherent relations** — stools _at_ the counter, the mug
   shelf _behind_ it, the door _on a wall_. Not a random scatter.
2. **Declared-empty space stays empty** — the front-right corner the user reserved for a
   queue is **not** back-filled with hallucinated tables. Enforced **mechanically, at
   solve AND at render**.
3. **When the description is logically incomplete or contradictory, the system ASKS** a
   small number of targeted clarifying questions instead of guessing — and for *hard*
   contradictions it **refuses to emit a layout** until answered.

The whole thing is built on primitives that already exist and are tested: the
`WorldEntityGeo` map, the `upsertEntityGeos` write path, the `layout_constraints` render
steer, the grounding loop, and the shipped `clarifiers → promptForHint` question UX. **No
parallel geometry, no parallel placement store, no parallel question modal.** The only new
moving parts are (a) one structured LLM parse, (b) one **pure, golden-testable** solver,
and (c) a thin gated UI affordance.

### Pipeline at a glance

```
description ──▶ PARSE (LLM)            ──▶ SceneGraph {entities, relations,
  (+answers)      plan_world_from_…         empty_regions, clarifiers, contradictions}
                                              │
                            ┌─────────────────┴─── hard contradiction / blocking gap?
                            │                              │ yes → solved:null, ASK (promptForHint)
                            ▼ no                           │ answers re-POST /plan-world ↺
                  SOLVE (deterministic)
                  layout_solver.py        ──▶ WorldEntityGeo[]  (source:"derived", in MAP_IMAGE_FRAME)
                            │
                            ▼
                  SEED  POST /api/world/[id]/map {geos} ──▶ upsertEntityGeos  (no new persistence)
                            │
                            ▼
                  RENDER  generate({scene_view, expected_layout, render_mode})
                          _layout_clause_for → layout_constraints  + "keep {region} empty"
                          + grounding loop verifies/repairs
```

---

## Phase 0 — Flag + wire types (additive only)

### Flag

`WORLD_FROM_DESCRIPTION`, read with the existing `env_flag` (`apps/modal-backend/_env.py:17`),
mirroring how `WORLD_MODE` / `WORLD_GEOMETRY_GEN` / `GEOMETRIC_WORLD` are gated in
`generate.py` (`_world_mode_on` :181, `_geometric_world_on` :185, `_world_geometry_gen_on`
:191). Default **off** → the new endpoint 403s and the new button never mounts, so prod is
byte-identical to today. (Confirmed: no `WORLD_FROM_DESCRIPTION` exists anywhere in the
tree today.)

### New wire types — `packages/config/src/index.ts`, placed next to `EntityGeoEdit` (:601)

These are **all new interfaces / unions**. No existing type changes shape — in particular
`GenerateBody` (config `:~70`, pydantic `GenerateBody` `generate.py:125`) and `Entity`
(`:364`) are untouched. `EntityKind` is the existing `"person" | "place" | "item" |
"creature"` union (`:344`); `WorldVec2` (`:407`), `WorldEntityGeo` (`:420-451`), and
`EntityState` (`:349`) are reused verbatim.

```ts
// Relations the LLM is allowed to express between two refs. NEVER coordinates —
// the planner emits structure, the solver turns structure into geometry.
export type SpatialRelation =
  | "near"        // small gap, no strong axis (stool near counter)
  | "on_wall"     // mounted on / against the named wall-region ref
  | "behind"      // -y of object (shelf behind counter, viewer at +y)
  | "in_front_of" // +y of object
  | "left_of"     // -x of object
  | "right_of"    // +x of object
  | "inside"      // nested in object's frame (parent_id + learned scale)
  | "on_top_of"   // stacked: object's elevation = object top
  | "facing";     // sets subject.heading toward object (no translation)

// One object the description named or functionally implies. `ref` is a stable
// slug the relations point at. `visual` is ONE render-ready sentence, copied
// verbatim into future prompts (mirrors the extractor's appearance contract,
// llm.py:1744-1747). `count` fans out into N instances at solve time.
export interface PlannedEntity {
  ref: string;
  kind: EntityKind;
  label: string;
  visual: string;
  footprint?: { w: number; d: number }; // world units; solver fills kind-default when absent
  height?: number;                       // world units; solver fills kind-default when absent
  count?: number;                        // default 1
}

// A placement constraint between two refs. `subject` is positioned relative to
// `object`. `gap` (world units) tunes "near"/"on_wall"/axis offsets.
export interface PlannedRelation {
  subject: string;
  relation: SpatialRelation;
  object: string;
  gap?: number;
}

// A region the description explicitly says is EMPTY/clear/open. The solver keeps
// every entity's footprint out of its AABB; the renderer gets a negative clause.
// `approx` is an optional hint box (0..1 of the place) the LLM may supply; absent
// → the solver derives the region from the wall anchors it borders.
export interface EmptyRegion {
  ref: string;
  note: string; // "front-right corner reserved for a queue"
  approx?: { x: number; y: number; w: number; h: number };
}

// The structured read of the description. Tolerant-parsed; malformed members are
// dropped, never raises (see parse_scene_graph). `contradictions` records hard
// logical conflicts the LLM refused to resolve; `clarifiers` (≤2) are the
// questions to ask. Both empty ⇒ the graph is solvable as-is.
export interface SceneGraph {
  place_label: string;
  place_kind: EntityKind; // virtually always "place"
  bounds_hint?: { w: number; h: number }; // world units; default = MAP_IMAGE_FRAME 100×60
  entities: PlannedEntity[];
  relations: PlannedRelation[];
  empty_regions: EmptyRegion[];
  clarifiers: string[];     // ≤2 short questions, mirrors ResolveClickResponse.clarifiers
  contradictions: string[]; // human-readable hard conflicts; non-empty ⇒ blocking
}

export interface PlanWorldRequestBody {
  session_id: string;
  description: string;
  answers?: string[];   // user replies to a prior round's clarifiers (re-run)
  trace_id?: string;
}

export interface PlanWorldResponse {
  graph: SceneGraph;
  // The solved layout, ready for upsertEntityGeos — or null when the graph is
  // blocked (hard contradiction / unresolved blocking clarifier). null ⇒ ask.
  solved: WorldEntityGeo[] | null;
  trace_id?: string;
}
```

**Why no `x`/`y` anywhere in `PlannedEntity`/`PlannedRelation`:** that is the load-bearing
design choice. The audit's ROOT-2 failure is "the model free-styles placement"; letting an
LLM emit coordinates reproduces it. The LLM emits **only relations**; coordinates are the
solver's job. (See Phase 1 rule 2 and the EVALUATOR CHECKLIST item 7.)

---

## Phase 1 — PARSE: description → `SceneGraph` (one LLM call, tolerant parse)

New `plan_world_from_description` in `apps/modal-backend/providers/llm.py`, modeled
**directly** on `edit_entities_nl` (`:2149`): one `_complete_json` call (`:626`) at
`temperature=0.0` against `_text_model(online=False)` (`:407`), with a tolerant
`parse_scene_graph` coercer modeled on `parse_entity_edits` (`:2064`) — it drops malformed
members and **never raises** (the same discipline as `detector.parse_detections`). A weak
model degrades to a thinner graph, never a crash.

```python
PLAN_WORLD_SCHEMA = {  # mirror the loose ENTITY_EDIT_SCHEMA (llm.py:2027): shape, not types
    "type": "object",
    "properties": {
        "place_label": {"type": "string"},
        "place_kind": {"type": "string", "enum": list(ENTITY_KINDS)},  # llm.py:132
        "bounds_hint": {"type": "object"},
        "entities": {"type": "array", "items": {"type": "object"}},
        "relations": {"type": "array", "items": {"type": "object"}},
        "empty_regions": {"type": "array", "items": {"type": "object"}},
        "clarifiers": {"type": "array", "items": {"type": "string"}},
        "contradictions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["place_label", "entities"],
}
```

`parse_scene_graph(payload)` validates each member the way `parse_entity_edits` validates
edits: an entity needs a non-empty `ref` + `label` + `visual` and a `kind ∈ ENTITY_KINDS`
(else dropped); a relation needs `subject`/`object` that **both resolve to known refs** and
a `relation ∈ SpatialRelation` (else dropped — exactly the "`target` must be a known id"
rule at `llm.py:2097`); an `empty_region` needs a `ref` + `note`; `clarifiers` is truncated
to ≤2; unknown keys are ignored. Output is a frozen `SceneGraph` dataclass.

### The system prompt carries four load-bearing rules

1. **Relevance — emit only named / functionally-implied objects; record empty space.**
   Mirror the **STRICT RELEVANCE FILTER** the extractor already uses (`llm.py:1733-1738`,
   "Generic scenery … must NOT be emitted. When in doubt, leave it out"). Functionally
   implied is allowed (a "counter" implies it stands on the floor; a "shop" implies a
   door/entrance even if unnamed) — but anything the user calls **empty / clear / open /
   reserved** becomes an `EmptyRegion`, and **nothing is placed there**. This is layer one
   of "empty stays empty" (the solver is layer two, the renderer is layer three).

2. **Placement is relations only — NEVER x/y.** "Express where each object is **only** as
   `relations` between refs (`near`, `on_wall`, `behind`, …). Do **not** output
   coordinates, grid cells, or pixel positions — you do not know the metric scale; the
   layout engine computes positions from your relations." This is the direct mitigation for
   the audit's ROOT-2 (model-invented placement) and is checked by EVALUATOR item 7.

3. **Check impossibilities before finalizing → ask, don't guess past a hard conflict.**
   "Before returning, re-read your graph for: (a) **physical impossibilities** (a window in
   an underground vault with no exterior wall; a door on a wall the description calls solid
   rock; an object `on_top_of` something that can't bear it); (b) **missing anchors** (an
   object whose only sensible placement needs a wall/region the description never gave); (c)
   **count/space conflicts** (more objects than the stated bounds can hold). For each, add a
   short question to `clarifiers` (**AT MOST 2**, ≤8 words each — same budget as the World
   Mode clarifiers, `llm.py:772`) and a one-line description of the conflict to
   `contradictions`. **Do NOT invent a resolution to a hard contradiction** — leave it in
   `contradictions` so the system can ask." (Soft gaps the solver can default — e.g. a stool
   with no explicit gap — do **not** need a clarifier; only logic-breaking gaps do.)

4. **`visual` = one render-ready sentence.** "For each entity, `visual` is ONE concrete
   visual sentence (≤25 words: materials, colour, form) that will be injected **verbatim**
   into the image prompt." This is the extractor's `appearance` contract word-for-word
   (`llm.py:1744-1747`), so a planned entity and a later *detected* one speak the same
   visual language (which matters for SOURCE_RANK refinement in Phase 4).

### New endpoint `POST /plan-world` (copy of `/edit-entities`)

Copy `edit_entities_endpoint` (`generate.py:1498`) verbatim in structure: a
`PlanWorldBody(BaseModel)` (modeled on `EditEntitiesBody` `:1321`), the same
`bind_trace`/`log`/`record_error` scaffold, the same `if not env_flag("WORLD_FROM_DESCRIPTION"): return 403`
gate. It (a) calls `plan_world_from_description(description, answers)`, (b) **runs the
solver server-side** (Phase 2), (c) returns `PlanWorldResponse {graph, solved, trace_id}`.
Solving server-side keeps the deterministic core in one tested place and means the client
just seeds + renders. One text-LLM call + pure CPU; no Mongo/R2 in the handler (same as
`/edit-entities`).

---

## Phase 2 — SOLVE: `SceneGraph` → `WorldEntityGeo[]` (deterministic, pure, golden-tested)

New module `apps/modal-backend/providers/layout_solver.py`. **It is not a constraint solver
and it does not call an LLM.** It is a pure function — same input → same output — held to
the determinism discipline of `geometry_prompt.py` ("the same layout always yields the same
clause … so it's unit-testable"). It is the unit that golden tests pin (EVALUATOR item 8).

```python
def solve_layout(graph: SceneGraph) -> SolveResult:
    """Pure. Turn a SceneGraph into WorldEntityGeo[] in the shared MAP_IMAGE_FRAME,
    or a blocked result carrying the mechanical clarifiers (Phase 3 layer B).
    No I/O, no randomness, deterministic iteration order."""
```

### Algorithm (each step deterministic; iteration order is sorted, never set-order)

1. **Frame.** Take `bounds_hint`, else default `100 × 60` — **the same `MAP_IMAGE_FRAME`**
   the tap router and the extract seed share (`geo-tap.ts:24`, kept in lockstep with
   `extract/route.ts`). Seeding into this exact frame is what makes a later tap on the
   rendered place route back to the right coords (this is the "felt-dead" bug the audit
   fixed at `94a33b1` — frame disagreement made the world inert). Origin top-left, **+x
   EAST, +y SOUTH**, matching the world-coord convention the edit prompt states
   (`llm.py:2035`).

2. **Kind-default footprints/heights.** For any `PlannedEntity` missing `footprint`/`height`,
   fill from the **shared** defaults `DEFAULT_GEO_FOOTPRINT = 6`, `DEFAULT_GEO_HEIGHT = 4`
   (`world-map.ts:125-126`; the TS geometry lib carries the identical `DEFAULT_FOOTPRINT = 6`
   / `DEFAULT_HEIGHT = 4`, `world-geometry.ts:162-163`). A small per-kind table may bias
   these (a `place` wall longer/thinner, an `item` smaller) but the floor is the shared
   constant so units agree with the rest of the system.

3. **Anchors first.** Resolve wall-regions and `EmptyRegion`s to rectangles in the frame
   before placing free objects: a wall named on a side maps to a thin rectangle along that
   edge; an `EmptyRegion.approx` (0..1) maps into the frame, and an `EmptyRegion` *without*
   `approx` is derived from the wall/edge its `note` references (default: a corner/edge
   quadrant). These rectangles are **reserved** — see step 6.

4. **Attach relational entities as offset vectors.** Walk `relations` in sorted order; place
   each `subject` relative to its already-placed `object` using a fixed per-relation offset
   (gap defaults small, ~`gap ?? 2` world units):
   - `near` → small gap, nearest free side.
   - `behind` → `object.pos − (0, depth)`; `in_front_of` → `+ (0, depth)` (viewer at +y).
   - `left_of` → `− (width, 0)`; `right_of` → `+ (width, 0)`.
   - `on_wall` → snap onto the named wall rectangle (centered, then de-overlapped along it).
   - `on_top_of` → same `pos`, `elevation = object.elevation + object.height` (a stack, not
     a translation — uses the existing `elevation` field, `WorldEntityGeo.elevation`
     `:435`).
   - `facing` → set `subject.heading` toward `object` (no translation), via the existing
     `heading` field (`:443`).
   - `inside` → do **not** translate in the parent frame; mark the subject for nesting
     (step 7).
   An object with no relation and no anchor is **unanchored** → recorded as a mechanical
   clarifier (Phase 3 B), not silently dropped or randomly dropped in.

5. **Fan out `count`.** A `PlannedEntity` with `count = n > 1` becomes `n` instances
   (`{ref}#1..#n`), distributed along the relevant axis (stools fanned along the counter's
   front edge) at one-footprint spacing. The `count`-vs-space check feeds the over-pack
   trigger (Phase 3 B).

6. **Iterative de-overlap (≤ 20 iterations).** Resolve footprint collisions by AABB
   separation: nudge the lower-authority / later object along the minimum-translation axis
   until footprints no longer intersect. **Two hard invariants, every iteration:**
   - **NEVER push a footprint into a reserved `EmptyRegion` AABB.** If a separation would
     land an object inside a reserved rectangle, push it the other way; if it cannot escape
     without entering the region, that is an **empty-region collision** → blocking clarifier
     (Phase 3 B), and the object is held out, not forced in. This is "empty stays empty,
     mechanically, at solve."
   - **Never cross a wall anchor.** Objects stay on their side of a wall rectangle.
   - **Note on reuse:** the existing TS `localBounds` (`world-geometry.ts:324`) computes an
     AABB over `pos+footprint` and is the model for the math, but there is **no AABB
     *separation* / de-overlap helper in the repo today** — the solver adds a small pure
     `separate(a, b)` (min-translation-vector) and its own `intersects(aabb, aabb)`. (This
     corrects the plan-section phrasing "reusing world-geometry.ts ~324": `:324` is
     `localBounds`, an AABB *constructor*, not a separator. The TS dirty-rect helper at
     `world-map.ts:118-120` is the same idea on the JS side.) Both are trivially
     golden-testable.

7. **Emit `WorldEntityGeo[]`.** Each placed instance →
   ```
   { id: f"geo_plan_{ref}", entity_id: None, parent_id: <null or nesting parent>,
     kind, label, pos, height, footprint, elevation?, heading?,
     visual: <PlannedEntity.visual verbatim>, state: {},
     confidence: <base × 0.6>, source: "derived", updated_at }
   ```
   `source:"derived"` + the **×0.6 confidence discount** exactly match
   `deriveGeoFromExtraction` (`world-map.ts:358`) so a later `user`/`extracted` write wins
   (SOURCE_RANK `user:2 > extracted:1 > derived:0`, `world-map.ts:36-40`). **`inside`
   objects** are nested: `parent_id = geo_plan_<container>` and the container learns a
   `scale` = its footprint extent ÷ the interior's local extent — the exact
   parent-scale-learning `deriveGeoFromExtraction` does at `world-map.ts:369-378` (clamped
   `[1e-3, 10]` via `localExtent`, `world-geometry.ts:344`), so a nested object resolves to a
   true absolute position inside its container.

The output is **exactly the shape `upsertEntityGeos` consumes** (`world-map.ts:259`) — so
seeding is the existing write path with **zero new persistence** (EVALUATOR item 3).

---

## Phase 3 — LOGIC CHECK + QUESTIONS (two layers, with a blocking tier)

The system asks in two layers, and the *kind* of problem decides whether it **blocks**
(refuse to emit a layout) or **solves-with-default + offers a refine**.

### Layer A — LLM-semantic (Phase 1, rule 3)

The planner's own `contradictions` (hard logic — a window underground, a door on solid
rock) and `clarifiers` (the ≤2 questions). Non-empty `contradictions` ⇒ **blocking**.

### Layer B — solver-mechanical (deterministic triggers)

The solver emits its own clarifiers from what it mechanically discovers. These are
deterministic (golden-testable) and concrete:

| Trigger | Question template | Tier |
|---|---|---|
| Unanchored object (no relation, no anchor) | `"Where is the {label}?"` | soft (default to frame center) or blocking if it's the only place anchor — config'd per-kind |
| Over-pack (Σ footprint area > region area, after fan-out) | `"You listed {n} {label} but {place} fits ~{k} — fewer, or a bigger room?"` | **blocking** |
| Dangling relation (survived parse but object never placed) | `"Where should the {label} go relative to?"` | soft |
| Empty-region collision (an object can't avoid a reserved region) | `"The {label} would sit in the {region} you described as clear — keep it empty or move it?"` | **blocking** |

### Blocking vs. soft

- **Blocking** (hard impossibility from Layer A, over-pack, empty-region collision) ⇒
  `solved: null` in `PlanWorldResponse`. The client **must** ask before anything renders.
  This is what makes "it actually asks when illogical" real rather than cosmetic (EVALUATOR
  item 2): a blocked graph cannot silently produce a wrong picture.
- **Soft** (a missing gap, an unanchored decorative item) ⇒ the solver places with a sane
  default (center / nearest free spot) **and** still surfaces the clarifier as an optional
  refine. The user can ignore it and keep the rendered layout.

`PlanWorldResponse.graph.clarifiers` is the **union** of Layer A + Layer B questions, capped
at the ≤2 budget (blocking ones first). The ≤2 cap is the direct guard against
**over-asking** (the prompt's risk #2).

### Answer feedback loop (re-run, not patch)

When the user answers, the client **re-POSTs `/plan-world`** with the same `description` +
the `answers[]`. `plan_world_from_description` re-runs with the answers appended to the user
turn ("The user clarified: …"), which **clears the resolved clarifiers/contradictions** and
re-solves. This is the same "re-run the call with more context" shape the rest of the system
uses; there is no separate patch path to keep consistent.

### Reuse the shipped question UX — do NOT invent a modal

The questions surface through the **already-shipped** `clarifiers → promptForHint` path. The
World Mode semi-autonomy flow already takes `ResolveClickResponse.clarifiers`, joins them,
and pops the hint bubble at the click point (`page.tsx:1384-1398`, calling `promptForHint`
defined at `:323`). The Describe-a-place flow does the **same thing**: join
`graph.clarifiers`, call `promptForHint(x, y, questions)`, feed the typed answer back as
`answers`. **No new question component** (EVALUATOR item 4). The `promptForHint` promise
already resolves to `string | null` (null = cancel), so the planWorld callback stays one
async function, exactly like the click handler.

---

## Phase 4 — SEED + RENDER (existing write + steer + ground; one new negative clause)

### Seed

On a non-null `solved`, the client POSTs it to the **existing** route:
`POST /api/world/[sessionId]/map` with `{ geos: solved }` → `upsertEntityGeos`
(`map/route.ts:78`, gated by `GEOMETRIC_WORLD`). No new endpoint, no new collection. The
optimistic-concurrency + source-authority merge is the one that already runs
(`applyGeoUpsert`, `world-map.ts:78`).

### Render

Render through the **existing** geometry-aware generate path. The client builds a
`SceneView` (a top-down `map` view for the whole place, or an observer pose to stand inside
it) + an `expected_layout` (`ProjectedEntity[]`) by projecting `solved` through the same
`projectScene` the geo-tap already uses, and sends them on `generate(...)`. Server-side:

- `_layout_clause_for` (`generate.py:196-207`) → `geometry_prompt.layout_constraints` (the
  deterministic "place these exactly where stated" rail, `geometry_prompt.py:14`) — **inert
  unless `WORLD_GEOMETRY_GEN` is on**, exactly as today.
- The grounding loop (`generate.py:1022`, hard-gated on `body.expected_layout`) verifies the
  render against `expected_layout` and runs one bounded `repair_instruction`
  (`geometry_prompt.py:35`) when it's off-target. This is "empty stays empty **at render**"'s
  enforcement teeth: the layout it checks against contains no objects in the empty region,
  so an object hallucinated there shows up as an `extra` and drags the grounding score
  (extras already penalize, audit 4b #6).

### The one new generate-side addition — an empty-region negative clause

Add to `apps/modal-backend/providers/geometry_prompt.py` a small pure function that turns
the place's `empty_regions` into a negative clause, e.g.:

```python
def empty_region_clause(regions: list[dict]) -> str:
    # "Leave the {note} clear and empty — no objects, furniture, people, or
    #  clutter there." Deterministic, testable, "" when no regions.
```

This rides alongside `layout_constraints` in the prompt compose. To carry the regions to the
backend without changing `GenerateBody`'s shape, the empty-region notes travel **inside the
existing `scene_view`** payload (a `SceneView` extension is additive) **or** the client
simply bakes the negative clause into the query text it already sends — either way **no new
required field on `GenerateBody`** (EVALUATOR item 6). This clause is render-layer
enforcement of "empty stays empty," complementing the solver's solve-layer reservation and
the grounding loop's extras penalty — **three independent layers** (EVALUATOR item 1).

### Tie-ins to the parallel fixes (B1 context)

- **Style consistency** is **not** this doc's job — it comes from the parallel style fix
  (the `style` `ConditionRole` + `session_style_anchor` forwarding from Workstream A2). The
  Describe-a-place render simply forwards `session_style_anchor` the way `submitQuery` does
  (`page.tsx:916`). B1 just rides that.
- **Frame/scale agreement:** the solver's footprints live in `MAP_IMAGE_FRAME` (100×60),
  the **same** frame the entity-size fix (A3) brings oblique footprints into — so units
  agree across description-seeded and detection-seeded entities.
- **Authority order:** because seeded objects are `source:"derived"`, a later **confirmed
  `extracted`** detection of the same object (once the place is rendered + extracted) can
  **refine** the solver's guess — correct authority direction via `SOURCE_RANK`
  (`world-map.ts:36-40`). Optionally expose a **"lock layout"** action that rewrites the
  solved geos to `source:"user"` so re-renders can't move them (the `user:2` top rank).

---

## Phase 5 — UX in `apps/web/app/play/page.tsx` (one gated affordance)

**Exactly one** new affordance: a gated **"Describe a place"** entry (a textarea + submit,
behind a `WORLD_FROM_DESCRIPTION`-derived client flag, mounted near the existing query bar).
Everything else — tap = enter, ⌘/Ctrl-tap = observer popover, NL-edit, the atlas — stays
**byte-identical**.

A `planWorld` callback modeled on `submitQuery` (`page.tsx:902`):

1. POST `/plan-world` with `{ session_id, description }`.
2. If `solved === null` (blocked / clarifiers): join `graph.clarifiers`, call
   `promptForHint(...)` (the shipped bubble, `:323`/`:1384`), collect the answer, re-POST
   `/plan-world` with `answers`. Loop until `solved` is non-null or the user cancels (null).
3. On non-null `solved`: POST it to `/api/world/[sessionId]/map` `{geos}`, then call
   ```ts
   generate({ ...baseQueryFields,           // same shape submitQuery sends
              scene_view, expected_layout,
              render_mode: "place_submap" | "place_scene",
              ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}) });
   ```
   `render_mode` is the **existing** `RenderMode` union (`"place_scene" | "place_submap" |
   "explainer"`, config `:23`) — `place_submap` for a top-down plan of the place,
   `place_scene` to stand inside it.

**Backwards-compatible:** every new field is optional, the endpoint + button are flag-gated,
and no existing call site changes. With the flag off the file behaves exactly as it does
today.

---

## The three biggest risks + de-risking

### 1. Semantically-wrong-but-mechanically-valid layout

The solver can produce a layout that satisfies every relation yet looks wrong (stools on the
far side of the counter; "behind" interpreted from the wrong viewer side). **De-risk:**
(a) **golden tests** on `solve_layout` pin canonical scenes ("coffee shop", "throne room")
to expected geo arrangements, so a regression is caught deterministically; (b) the
**grounding loop** re-checks the *rendered* frame against `expected_layout` and repairs
gross misplacement (`generate.py:1022`); (c) the solver works in **coarse bins** at the
prompt boundary — `ProjectedEntity` already exposes `h_pos/v_pos/size` *bins*, not pixels
(`config:499-503`), so "approximately right" is the target, not pixel-perfection the
monocular pipeline can't honor anyway (audit §4b: geometry is **relative, not metric**).

### 2. Over-asking or under-asking

Too many questions is annoying; too few lets nonsense through. **De-risk:** the **two-layer**
split (LLM-semantic + solver-mechanical) catches both *kinds* of problem; the **blocking
tier** ensures the questions that matter (impossibility, over-pack, empty-region collision)
actually gate the render while soft ones don't nag; the **≤2 cap** (the World Mode budget,
`llm.py:772`) bounds the ask; and a **broken-description eval fixture** (a deliberately
contradictory description: "a windowless basement with a sunny bay window", "10 grand pianos
in a phone booth", "a table in the corner I want kept empty") asserts the system asks /
blocks rather than guessing.

### 3. Frame / scale mismatch

If the solver seeds into a different frame than the tap router / extractor read, the place
renders but **taps don't land** — the exact "felt-dead" bug (`94a33b1`). **De-risk:** the
solver seeds into **`MAP_IMAGE_FRAME` (100×60)** — the single shared frame
(`geo-tap.ts:24`, lockstepped with `extract/route.ts`); **inside**-objects nest with the
**learned parent `scale`** (`world-map.ts:369-378`) so a nested object's local pos resolves
absolutely; and a **tap-routing regression test** asserts that after seeding from a
description, a synthetic tap on a placed object's screen position routes back to that
object's geo (the same regression `geo-tap.ts` already guards).

---

## Open questions

- **Wall representation.** Are walls first-class `PlannedEntity`s (kind `place`, thin
  footprint) the relations point at, or implicit edges of the bounds rectangle? Leaning
  first-class so `on_wall` has a concrete ref and the door/window logic checks have
  something to test against — but that inflates the entity count. Decide before golden
  tests freeze the shape.
- **Viewer convention for `behind`/`in_front_of`.** The solver assumes the viewer at +y
  (looking −y / north). Is that always right for a `place_scene` observer the user might
  re-pose? For the initial top-down plan it's unambiguous; for a stood-inside scene the
  observer pose may need to re-derive front/back. Probably: solve in the canonical top-down
  frame, let the observer pose handle the rest at render.
- **How big is a default place?** `bounds_hint` defaults to 100×60, but a "vast cathedral"
  and a "phone booth" shouldn't share it. Should the LLM *estimate* bounds (a scalar
  "roughly N meters across") while still never emitting per-object coords? That keeps rule 2
  intact (bounds ≠ placement) and feeds the over-pack check real numbers.
- **Multiple empty regions + dense objects.** With several reserved regions the ≤20-iter
  de-overlap might fail to place everything without collision. Fallback: surface an
  over-pack-style blocking clarifier rather than overflow into a region.
- **Does a described place become a tree node like a tapped one?** It should slot into the
  same node/atlas model (so you can tap *into* it afterward), but the node-creation path is
  the tap flow's; wiring the description flow into it cleanly is unspecified here.

---

## Critical files

- `packages/config/src/index.ts` — new types next to `EntityGeoEdit` (`:601`); reuses
  `EntityKind` (`:344`), `WorldVec2` (`:407`), `WorldEntityGeo` (`:420-451`), `SceneView`
  (`:478`), `ProjectedEntity` (`:491-504`), `RenderMode` (`:23`), `EntityState` (`:349`).
  Untouched: `GenerateBody` (`:~70`), `Entity` (`:364`).
- `apps/modal-backend/providers/llm.py` — new `plan_world_from_description` +
  `parse_scene_graph` + `PLAN_WORLD_SCHEMA`, modeled on `edit_entities_nl` (`:2149`) /
  `parse_entity_edits` (`:2064`) / `ENTITY_EDIT_SCHEMA` (`:2027`); reuses `_complete_json`
  (`:626`), `_text_model` (`:407`), `_system_message` (`:282`), `ENTITY_KINDS` (`:132`); the
  STRICT RELEVANCE FILTER (`:1733`) + visual-sentence (`:1744-1747`) + clarifier-budget
  (`:772`) language is the template.
- `apps/modal-backend/providers/layout_solver.py` — **new**, pure: `solve_layout` +
  `separate`/`intersects` AABB helpers + per-relation offset table. Golden-tested.
- `apps/modal-backend/providers/geometry_prompt.py` — reuses `layout_constraints` (`:14`) +
  `repair_instruction` (`:35`); **adds** `empty_region_clause`.
- `apps/modal-backend/generate.py` — new `/plan-world` endpoint copied from `/edit-entities`
  (`:1498`) + `PlanWorldBody` (modeled on `EditEntitiesBody` `:1321`); reuses
  `_layout_clause_for` (`:196-207`), the grounding loop (`:980`), the flag pattern
  (`:181-193`).
- `apps/web/lib/world-map.ts` — reuses `upsertEntityGeos` (`:259`), the `×0.6` /
  `source:"derived"` discount + parent-scale learning of `deriveGeoFromExtraction`
  (`:358`, `:369-378`), `SOURCE_RANK` (`:36-40`), `DEFAULT_GEO_FOOTPRINT/HEIGHT` (`:125-126`).
- `apps/web/lib/world-geometry.ts` — reuses `localBounds`/`localExtent` (`:324`/`:344`),
  `projectScene` (`:117`), the `DEFAULT_FOOTPRINT/HEIGHT` parity constants (`:162-163`); the
  solver's de-overlap is the **new** piece (no separator exists here today).
- `apps/web/lib/geo-tap.ts` — reuses `MAP_IMAGE_FRAME` (`:24`); the tap-routing regression
  test extends what's already guarded here.
- `apps/web/app/api/world/[sessionId]/map/route.ts` — reuses the `{geos}` → `upsertEntityGeos`
  POST (`:78`); **no change**.
- `apps/web/app/play/page.tsx` — new gated `planWorld` callback modeled on `submitQuery`
  (`:902`); reuses `promptForHint` (`:323`, wired at `:1384-1398`); reuses
  `session_style_anchor` forwarding (`:916`).

---

## EVALUATOR CHECKLIST

A critic must confirm **all** of the following before this design is accepted. Each maps to
a mechanism above, not an aspiration.

1. **Empty stays empty — mechanically, at solve AND render.**
   - Solve: every entity footprint is kept out of every reserved `EmptyRegion` AABB; a
     forced collision becomes a **blocking** clarifier, not a forced placement (Phase 2 step
     6).
   - Render: the new `empty_region_clause` adds a negative ("leave {region} clear") to the
     prompt, AND the grounding loop scores any object that lands in the region as an `extra`
     (penalized, audit 4b #6). Three independent layers (relevance filter → solver
     reservation → render clause + grounding). _Not_ a single prompt nudge.

2. **It actually asks when illogical.**
   - Concrete **deterministic** triggers exist (Phase 3 Layer B table: unanchored,
     over-pack, dangling relation, empty-region collision) — not "the LLM might mention it."
   - A **broken-description eval fixture** (contradictory + over-packed + reserve-then-place
     descriptions) asserts the system asks/blocks.
   - A **blocking path** exists: hard contradiction / over-pack / empty-region collision ⇒
     `solved:null` ⇒ no render until answered.

3. **Reuses the real primitives — no parallel systems.** Geometry is `WorldEntityGeo`;
   persistence is `upsertEntityGeos` via the existing `/map` POST; render steer is
   `layout_constraints`; verification is the grounding loop. **No** new geometry type, **no**
   new placement store, **no** new persistence collection, **no** second render path.

4. **Reuses the clarifier / `promptForHint` UX.** Questions surface through the shipped
   `clarifiers → promptForHint` bubble (`page.tsx:323`/`:1384-1398`). **No** new question
   modal/component.

5. **Frame coherence.** Solved coords are in **`MAP_IMAGE_FRAME` (100×60)**; `inside`-objects
   are nested with `parent_id` + the **learned parent `scale`** (`world-map.ts:369-378`); a
   **tap-routing regression test** proves a tap on a seeded object routes back to that
   object.

6. **Additive + flag-gated + backwards-compatible.** All new fields optional; new endpoint
   (`/plan-world`) and button gated by `WORLD_FROM_DESCRIPTION` (default off). **No shape
   change** to `GenerateBody` or `Entity`. Flag off ⇒ prod byte-identical.

7. **The LLM emits relations, never x/y.** `PlannedEntity`/`PlannedRelation` carry no
   coordinate fields; Phase-1 rule 2 forbids coordinates in the prompt; the parser would
   drop a stray coordinate anyway. Coordinates are produced **only** by the deterministic
   solver. (Directly closes the audit's ROOT-2 "model-invented placement" failure.)

8. **Solver pure + golden-tested; parser tolerant.** `solve_layout` is a pure function
   (no I/O, deterministic order) with golden fixtures; `parse_scene_graph` drops malformed
   members and **never raises** (mirrors `parse_entity_edits`). A weak model degrades to a
   thinner graph, never a crash or a wrong mutation.
