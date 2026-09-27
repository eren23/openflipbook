# World-Connected Sketch Scenes

Implemented locally, September 10, 2026. Not merged or deployed. No new model
generation is involved. This is an authored local-place editor, not automatic
reconstruction of a drawing or a complete city.

## Open

- Free, non-persistent example: `/sketch/world?demo=1`.
- Mended Drum street and illustrated map: `/sketch/world?demo=ankh`.
- An owned saved image: Sketch > World editor (cube icon).
- An owned mapped place: Places > Build 3D place / Open 3D place.
- **My Worlds > New 3D World**, or `/sketch/world`: start an empty persistent
  place without an image. Name it, author dimensions/objects, then Preview/Apply.
- Start with Garden, Mended Drum street, or Empty place. Existing image-linked
  places retain their saved reference; source-free places have no Reference tab.

The garden template contains a left pond, right bench, rear-right pergola,
connected L-shaped path, walls, and trees. It is a reusable component definition,
not geometry recovered from the source illustration. Confirm authored dimensions
before the first preview. Selected drawing elements can provide a component's
footprint, position, rotation, and traceable element ID; the user selects its type.

## Data And Consistency

Source-free worlds use the existing scene/entity/map registries with explicit
null source-node and source-image references. They do not insert placeholder
image nodes. Their root frame is in authored metres; changing its dimensions
does not rescale existing objects. They appear in My Worlds with a place count,
resume directly in the World editor, and support metadata edits, notes, editor
Fork, and ZIP Export without generating an image.

Creation first establishes the browser credential through
`POST /api/creator/identity`, then commits via `POST /api/creator/worlds` with
`{request_id, definition}`. The request ID is a UUID v4. Ownership, library
metadata, scene, map, entities, history and receipt commit in one transaction.
Replaying that ID with the same definition returns the saved world without
overwriting later edits; conflicting reuse is rejected. New source-free worlds
and their forks are private; legacy image-world unlisted reads remain unchanged.
There is no publication UI for source-free worlds yet.

Saved places can reopen through `/sketch/world?world=SESSION&place=PLACE` or
`GET /api/world/scene-context?world=SESSION&place=PLACE`. Source-free ZIPs have an
empty image graph and retain scene revisions and canonical entities/map data.
This implements export, not a complete world-import/restore workflow.

Real-Mongo acceptance (local web server, database from `apps/web/.env.local`):

```sh
E2E_SOURCE_FREE_WORLD=1 E2E_BASE_URL=http://127.0.0.1:3003 \
  pnpm exec playwright test e2e/source-free-world.spec.ts
```

The test creates worlds through ordinary UI, edits/reloads them, resumes from
the library, exports, forks, checks a foreign browser, and removes only its own
records. A separate case races duplicate creation requests against real Mongo.
Desktop and mobile emulation pass; these authored shells do not establish fresh
model quality. Draft recovery across browser restarts remains incomplete.

`place_scenes` stores the current local scene. `place_scene_versions` stores
immutable revisions; `world_edit_proposals` stores exact reviewed proposals and
their idempotent application receipts. Shapes and material colors are frozen in
each revision. Source image keys are immutable references to existing R2 assets.
Generated GLBs now have a separate world-owned asset path; see
[Generative 3D](GENERATIVE_3D.md). Fresh provider output is not yet verified.
Splat import and general generated material packs remain unfinished.

Preview validates dimensions, rotated bounds, identities, and entrance clearance.
Apply rechecks ownership and the base scene revision and world snapshot hash,
then updates entities, world-map bindings, scene, history, and receipt in one
MongoDB transaction. Conflicts require another preview; retries of an applied
receipt return the original revision. Undo restores a prior definition as a new
revision. Removed entities use the existing soft-delete convention.

The live plan and 3D view render the same saved definition. World-map positions
are transactionally updated mirrors, not a second editable copy. Child positions
use an explicit metres-to-parent-frame scale and preserve the parent's placement.
Existing mapped children must be reconciled separately; the first version refuses
to silently replace them with template geometry.

Saved illustrations stay historical and receive an outdated marker when affected.
The source image does not become a 3D reconstruction or a current plan. Ordinary
Sketch Keep still saves only an image; it does not promote identity or geometry.
Forks retain all scene revisions, remap source node IDs, and reuse immutable
assets. World ZIPs include `place-scenes.json` and source reference bytes.

Legacy NL move, height, and removal operations for one scene use the same commit
service. Ambiguous appearance prose, cross-scene batches, and generic additions
require the explicit component editor. Extraction cannot overwrite scene-backed
geos, and Codex mutations cannot silently rename/delete/unpin their bound objects.

## Rendering

Three.js renders fixed parametric components and geometry-bound materials.
Rapier 0.17.3 provides collision-aware movement. Eye height is 1.6 authored metres;
camera yaw and lateral movement are real 3D transforms. Water uses a conservative
non-traversable footprint. Pergola posts and horizontal roof beams have separate
colliders, leaving the space beneath open. There is no inferred interior or
continuous route between independent local scenes. Version-2 structured buildings
add authored interiors within one scene, described below. They are not automatic
map reconstruction.

Plan, orbit, walk, reference, object selection, numeric transforms, material
swatches, draft undo, preview/apply, revision restore, and touch movement controls
are available. Free walk position is not saved; return/reload starts at the saved
entrance. Unsaved component edits remain local and warn before leaving.

### Linked Plan And 3D Editing

`Plan + 3D` shows both views of the same draft, side by side on desktop and stacked
on mobile. Selection outlines identify the same object in each view. The
`Frame selected in 3D` control fits the selected component from its front quarter;
it is an inspection camera, not collision-aware travel.

Choose a component type and use the rectangle tool to draw its footprint on the
plan. The pointer ray intersects the authored ground plane, so a roof's visible
height does not displace its drawn footprint. Reversed drags work, endpoints are
clamped to place bounds, and clicks/slivers below 0.25 m do not create objects.
Escape cancels drawing. Numeric fields refine the dimensions; Undo removes or
reverts the draft operation. This is rectangular plan sketching, not arbitrary
freehand-image reconstruction or an AI interpretation of a perspective image.

Only Preview/Apply persists the change. Existing scene-to-map transactions mirror
the object's position, footprint, height, rotation, and identity into the world
map. They do not repaint the illustrated city map or street image. Image references
remain historical; a geometry-aware raster regeneration workflow is still separate.

The September 11 recording resized the Drum from 10 to 9.4 m wide, raised its
ridge to 9.6 m, and drew a 3 x 3 m, 4 m-high Filigree workshop. Real save/reload
checks verified scene/map agreement, no draft-map mutation, unchanged parent
placement and unrelated objects, and byte-identical reference artwork. No paid
model calls were made. This isolated recording owns its own demonstration world.

From `apps/web`:

```sh
E2E_WORLD_SCENES=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/world-sketch-sync.spec.ts
node scripts/record-world-sketch-demo.mjs ../../docs/research/assets/world-sketch-sync-take4-2026-09-11
node scripts/compose-world-sketch-film.mjs ../../docs/research/assets/world-sketch-sync-take4-2026-09-11 ~/Desktop/openflipbook-sketch-to-world-2026-09-11.mp4
```

The film omits import and save/reload waits. The source recording, checks, saved
scene/map snapshots, screenshots and film receipt are retained in that asset
directory. Desktop/mobile browser tests cover drawing, resizing, linked selection,
camera framing, cancellation, removal, undo and panel non-overlap. Existing garden
plan/walk checks and focused scene/persistence unit tests also pass.
The viewport retains its last rendered canvas during asynchronous texture
replacement, then swaps only after the new frame renders. A delayed-texture
browser regression test checks pixel retention and old-canvas cleanup.

## Rollout And Verification

Development enables the feature unless `NEXT_PUBLIC_WORLD_SCENES=0`.
Production requires `NEXT_PUBLIC_WORLD_SCENES=1` at build and runtime. Existing
worlds are not migrated and no paid generation/default changes are introduced.

```sh
# apps/web, using the running local web server
E2E_WORLD_SCENES=1 E2E_BASE_URL=http://127.0.0.1:3003 \
  pnpm exec playwright test e2e/world-scene.spec.ts
```

The separately opted-in `E2E_WORLD_SCENES_LIVE_DB=1` case reads a specific
`WORLD_SCENE_SOURCE_SESSION`, creates an isolated fixture in the configured
database, verifies real Apply/reload/restore, and removes only its own records.
It records an uncut browser video and blocks generation requests. Never point
this at a source session without authorization to read it.

Desktop/mobile canvas and movement checks pass. The real database trial passed
creation, revision 2 bench movement, reload, walking, and revision 3 restoration,
with zero generation requests. Human visual-fidelity acceptance remains pending.
This is a functional proof, not a claim of finished art direction.

## Structured Buildings (Version 2)

Local, unmerged implementation, September 11. Choose **Building** in the ordinary
component selector or draw its footprint on the plan. Its dimensions, heading,
wall thickness, roof height, doorway, windows and floor names are editable.
Two floors default to a west-side stair flight and an upper-floor aperture/landing.
September 13: the Architecture inspector now edits the flight's building-local
centre x/z and its north/east/south/west climbing direction. An authored flight
has a persistent ID. Its width, run and rise remain derived from storey height;
there is no separate stored collision ramp or slab-hole authority.
The layout is authored architecture, not generated or reconstructed geometry.

New source-free places start at version 2. Existing scenes upgrade when a
structured building is added; version-1 scenes otherwise retain their
representation and rendering. Openings and floors have
stable IDs, and preview/apply/history preserve the architecture together with its
building entity and map footprint. Invalid openings, duplicate architectural IDs,
blocked spawn points and insufficient staircase space reject the proposal.

Rendering and collision use the same wall/floor/opening dimensions. The stairs
render individual treads and use a smooth convex ramp for capsule collision;
this approximation is intentional. Version-2 movement uses time-based gravity
instead of the legacy flat-scene downward displacement. The plan removes the roof
and upper slab visually; walk mode retains them. Interior floors are slightly
raised to avoid coincident ground surfaces.

Missing `structure.stair` retains the previous west-side flight without migrating
saved scenes. Editing it adds `{id,x,z,direction}`; removing the upper floor also
removes its authored flight. A changed storey height recomputes steps/run around
the saved centre rather than moving the centre to make it fit. Validation rejects
insufficient side/landing clearance, collisions with room partitions, blocked
furnishings or disconnected circulation. The new controls reject invalid local
placement before replacing the draft. Preview/apply remains the persistence gate.

Treads, upper-floor aperture, convex collision ramp, room access and furnishing
reservations consume one flight transform, including the parent building's
rotation. Stair-only changes leave exterior map repaint unchanged; saved camera
captures still become historical when their source scene changes. Planner
additions can supply the same stair structure and receive deterministic remapped
IDs. Fresh planner output using this option remains unverified.

Limits: one orthogonal shell with one or two named floors, one exterior doorway,
up to sixteen windows, and one straight, fixed-width stair flight with cardinal
climbing directions. Multiple flights, spiral/switchback
stairs, editable stair widths and cross-place room portals remain unfinished.
Opt-in material jobs and durable layout proposals are described separately in
GENERATED_MATERIALS.md and PLACE_BUILDS.md; their presence does not establish
fresh generative quality or full build orchestration. This is not M1/M3/M4
completion or the accepted fresh-district demo.

Checks:
- `pnpm exec vitest run lib/building-structure.test.ts lib/place-scene.test.ts lib/place-scene-server.test.ts`
- `E2E_BASE_URL=http://127.0.0.1:3003 E2E_MOCK=1 pnpm exec playwright test e2e/structured-building.spec.ts`

The browser case creates the building using real editor controls in the
non-persistent free workspace, then enters, climbs, descends and exits. It blocks
image-generation calls. Persistence is covered separately by transaction tests;
fresh model quality and real-database architecture acceptance are not established.

The September 13 authored-stair browser case in `e2e/place-build.spec.ts` adds
real local database evidence: create through the UI, capture a view, move/rotate
the flight, reject an invalid edit, apply, climb, reload upstairs, descend and
exit, export and fork. It runs at 1280x900 and 390x844 using an isolated database,
worker and fake backend with no model submissions. Unit tests traverse all four
flight directions in a rotated building through real Rapier collision. These
authored cases establish structural behavior, not AI architecture/texture quality.

## Connected Ground Places

Saved places offer **Add adjoining area** with a name, dimensions, cardinal
direction and boundary-opening width. Preview records a proposal; Apply commits
the new scene, canonical world-map placement and connection together. The source
scene is unchanged. Stale revisions, overlapping expansion, misaligned endpoints
and objects blocking the opening reject the operation without partial writes.
Later scene edits revalidate existing connections inside the scene transaction.

Connections live in `place_connections`, with stable endpoint place IDs, opposing
boundary sides, offsets in metres and opening width. `world_map` remains the
placement authority; viewport offsets are derived, not another persisted layout.
The owner-scoped `/api/world/[sessionId]/places/[geoId]/connections` route returns
a consistent network snapshot. Export includes `place-connections.json`; forks
copy connection identities and endpoints into the fork's owner scope.

Walk preloads the connected component's geometry and assets before enabling
movement. The same camera and physics world cross the opening and return. Thin
boundary markers and collision prevent walking into unloaded space or crossing
unregistered edges. These are loading limits, not invented architectural walls.
The current-place badge and selector follow the player. **Edit this place** and
leaving Walk open the reached place's editor, rather than the original place.
Failed place loads retain the previous URL and walk context for retry. Adjoining
preview/apply locks the parent editor to avoid losing concurrent draft changes.

Current limits: axis-aligned, ground-level, root places in authored metres only;
up to 16 connected places and 1,000 objects per preloaded component; 256 stored
connections per world. Openings are centered for new expansions. There is no
streaming, elevated connection, interior portal, existing-place connection editor,
disconnection editor. New areas are blank authored
ground, not AI-generated environments. Full world import is still unfinished.

Checks:
- `pnpm exec vitest run lib/place-connections.test.ts lib/place-scene-server.test.ts`
- `E2E_CONNECTED_PLACES=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/connected-places.spec.ts`

The opt-in browser cases create and clean their own worlds in the configured
MongoDB replica set. They check both desktop and mobile-width layouts, real
Rapier crossing/return, unchanged source snapshots, preload state, same-canvas
continuity, target-object pixels, export/fork, owner isolation and no generation
submissions. Injected place-load and adjoining-mesh failures check retry context
and that Walk cannot become ready with missing assets. Authored fixtures do not
establish fresh model quality.

## Saved Walking Positions

Committed places now autosave owner-scoped walking positions in `creator_worlds`
through `/api/creator/worlds/[sessionId]/walk`. Positions use place-local metres,
capsule-centre height, yaw/pitch and the source scene revision. Interior positions
also bind to existing building, floor and optional room IDs from the scene layout.
Room membership is derived from building-local position, not separately authored.
Connected-world runtime offsets are never persisted as the position authority.

Movement is sampled every quarter second and changed positions are coalesced into
serialized saves after 750 ms. Page hiding and normal unmount request a keepalive
flush. This is not a guarantee of the last frame surviving a hard process kill:
the last acknowledged server position is the durable recovery point. Save failures
are visible and require explicit retry. A lost response reuses its request ID;
stale-tab writes stop with a reload action instead of replacing a newer position.
Only committed geometry records positions; draft and demo walks do not.

Reloading a Walk URL or continuing its library entry restores after geometry,
assets and physics are ready. Real Rapier queries require capsule clearance and
nearby support. The current place and building/floor/room identity must still match.
Renaming a room preserves its identity and a safe pose. Merging away the saved
room, floor removal, missing places, blocked positions or absent support recover
to a checked entrance with a notice.
Legacy positions without floor bindings require the original scene revision.
An obstructed entrance fails closed rather than spawning inside an object.
The explicit Return to entrance control bypasses the saved position.

Positions are private navigation preferences, not public world content. Forks and
world ZIPs do not copy them. They do not change scene revisions or cause any model
submission. Cross-device recovery still requires the same owner credential; an
ownership-recovery UI and arbitrary room/portal/elevation contracts remain unfinished.

Checks:
- `pnpm exec vitest run lib/walk-position.test.ts lib/walk-position-sync.test.ts lib/walk-position-server.test.ts`
- `E2E_WALK_POSITION=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/walk-position.spec.ts`

The opt-in browser trial creates its own world through the UI, walks upstairs,
saves/reloads, changes appearance, removes the upper floor, and checks safe
recovery, concurrent writers and foreign access against the configured database.
Connected-place and source-free library tests also exercise persisted resume.
Consult the progress log for the latest verification results and failed trials.

## Floor-Aware Furnishing

Version-2 benches, barrels and generated meshes may bind to a structured building
and floor through `placement: { building_id, floor_id }`. Bound `x`/`z` coordinates
are building-centred metres and heading is relative to that building. Elevation
is derived from the identified floor, including the ground slab's 0.015 m top.
No independent absolute furnishing transform is persisted.

`floor-placement.ts` resolves the same coordinates for rendering, collision,
selection and derived map geometry. Moving or rotating the building carries its
contents; changing storey height updates elevation. Connected runtime placement
translates the parent building exactly once. Map geometry retains the building
parent and floor identity, with a rotated displacement because existing map
frames compose translation and scale rather than heading.

The editor's Level selector exposes a floor in Plan or 3D. Add and footprint
drawing target that floor. The furnishing inspector can reassign the object to a
clear floor slot or clear outdoor ground. Invalid placement never silently falls
back to an unrelated floor. Removing a furnished floor/building requires moving
or removing its contents first. Undo and existing preview/apply revisions retain
the binding; export and fork copy it with the scene.

Validation rejects missing bindings, unsupported component kinds, out-of-envelope
footprints, ceiling intersections, overlapping furnishings on one floor, blocked
doorway clearance and stair/landing intrusions. Room layouts also constrain props
to one room and require a reachable approach, with the conservative circulation
planner described below. This is not proof of arbitrary 3D navigation.
Only existing rectangular one/two-floor structured buildings are supported.

Interior furnishings do not become symbols on exterior map artwork. Moving an
object indoors removes its old exterior symbol; moving outdoors adds its new
symbol. Interior-only changes do not request an exterior repaint. Legacy map-frame
move instructions are converted into the building-local frame before applying.

Checks:
- `pnpm exec vitest run lib/floor-placement.test.ts lib/place-scene-server.test.ts`
- `E2E_FLOOR_FURNISHING=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/floor-furnishing.spec.ts`

The browser workflow authors a building and bench through the ordinary UI; it is
persistence and interaction evidence, not fresh generated-asset quality evidence.
See the progress log for results, failures and remaining acceptance work.

## Room Layouts and Circulation

Each version-2 structured floor can carry an optional `layout`. Its recursive
tree contains identified/named `room` leaves and identified `split` partitions.
A partition stores its `x` or `z` axis, position, doorway ID/offset/width/height,
and two children. Positions and offsets are absolute building-local metres;
room envelopes derive from the outer shell and partition thickness. There is
no competing room geometry store or implicit image reconstruction.

The inspector can initialize a layout, split a selected room, rename rooms,
adjust partitions and doors, and merge sibling rooms. Edits validate against
the complete draft before replacing its layout. The floor selector is shared
with furnishing and cutaway views. Split preserves the original room ID in one
child; merge preserves that child's ID rather than substituting a new identity.

Validation limits the tree to 63 nodes and depth six, with 1.4 m minimum clear
room dimensions and doorways at least 1 m wide and 2.1 m high. IDs share the
architectural identity namespace. Partitions cannot intersect stairs, landings,
exterior openings or existing interior doorways. Each doorway connects two
identified rooms. A doorway gap itself has no leaf-room membership.

`buildingParts` supplies the same partition sides and lintels to rendering and
Rapier collision. Plan cutaways omit lintels and partitions from other floors
without removing their physical solids. Plan room labels and the walking room
status use the same saved names. Furnishing map records derive `room_id` while
retaining their building parent and floor binding; rooms are not independent map
entity records yet. Layout/name-only edits do not request exterior map repaint.

`room-circulation.ts` inflates plan obstacles by 0.34 m and flood-fills a
coordinate-compressed clearance grid from the entrance or upper stair landing.
Every room, doorway approach and required stair approach must be reachable;
each furnishing needs at least one reachable approach. Automatic floor placement
checks this as well as overlap, so the first collision-free but isolated slot
is not accepted. A semantic doorway graph is checked alongside physical reach.
Rotated props use conservative bounding rectangles. This may reject feasible
layouts; it is not a general mesh navmesh, all-space coverage or 3D physics proof.
Rapier remains the runtime movement authority.

Current limits: orthogonal splits in one/two-floor buildings, cardinal straight
stair placement, no arbitrary-angle partition, enclosed courtyard or
cross-place room portal. Derived-view invalidation is still coarser than the
full release contract. This is authored functionality, not fresh AI interiors.

## Compound Building Outlines (September 13)

The Architecture inspector's **Footprint / Edit outline** edits a local draft.
Choose a wall and add a recess, trim its ending corner, or edit corner coordinates
in metres. The preview preserves width/depth aspect ratio. Apply outline validates
the architecture, furniture and circulation before replacing the scene draft;
the existing Preview / Apply to world transaction remains the persistence gate.
Cancel leaves the saved outline untouched. Changing the source architecture while
the outline editor is open discards that older local outline draft.

`structure.footprint` is optional: 4..24 clockwise, alternating-axis corners
`{id,x,z}` in normalized building-local coordinates (-0.5..0.5). Its bounds must
retain the building's full width and depth. Each corner identifies its outgoing
wall, and compound openings persist `wall_id` plus the outward cardinal `side`.
An opening's offset is still the local metre x or z, not a fraction or distance
from the shorter wall centre. Removing or shortening its wall cannot silently
move the opening to a different segment. Corner trimming preserves the original
wall ID on the surviving part of that wall.

Absent outlines retain the existing rectangular representation and rendering.
There is no automatic saved-scene migration. The planner may propose the same
outline and wall references; all symbolic architectural IDs are remapped along
with buildings/floors/rooms and validated before publication. Fresh model output
using this contract has not been generated in this increment.

The shared envelope uses the MIT-licensed
[polygon-clipping](https://github.com/mfogel/polygon-clipping) 0.15.7 library for
intersection/difference. Input validation rejects diagonal edges, zero/short
walls, reversed winding, crossings, self-touching, duplicate IDs, out-of-bounds
corners and disconnected usable floors. Floors are the outline minus inward
wall strips. Orthogonal regions are decomposed into exact rectangles consumed by
the existing Three.js meshes and Rapier solids. Upper slabs also subtract the
same stair opening. Doors on recessed walls are actual openings, not openings in
the former outer bounding box. Glass remains collision-blocking.

Partitions and named rooms clip to the floor envelope; empty or disconnected
rooms and doors into a recess are invalid. Stairs, landings and furnishings must
fit the actual floor. Circulation excludes the missing footprint area. The room
split search considers real floor cells, and labels/lights occupy those cells
rather than the old rectangular centre. Walking in an open recess has no indoor
room/floor identity. Saved pose restoration still checks actual current collision.

Map records retain a rotated polygon in the parent's local frame, while width
and depth remain bounding extents. Parent rescaling, OUTWARD reparenting and
container rollback transform the border with its position. The minimap draws
the polygon; registered artwork guides trace the concave outline. Artwork masks
remain conservative bounding regions, not a claim that untouched courtyard
pixels inside such a mask are protected. Geometry changes invalidate existing
camera captures through their saved scene dependencies.

Limits: orthogonal simple outlines only, no enclosed courtyard holes, diagonal
walls, multiple exterior doors or disconnected floors. Roofs currently use
gable sections over a deterministic rectangle decomposition; they respect the
footprint but are not a general roof-intersection or drainage solver. Plain
untextured shells remain structural previews, not finished generative quality.
Floor placement and outdoor planning still use conservative clearance bounds.
No paid generation, video adapter or whole-mesh conversion was added here.

Checks:
- `pnpm exec vitest run lib/room-layout.test.ts lib/floor-placement.test.ts`
- `E2E_ROOM_LAYOUT=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/room-layout.spec.ts`

The browser trial creates and cleans its own worlds in the configured MongoDB
replica set. It checks real partition collision/door crossing, stairs, upstairs
furnishing, saved room identity, rename, merge recovery, export/fork, rendered
pixels, control layout and zero model submissions at desktop and mobile widths.
Mobile-width browser checks are not physical-device performance evidence.

## Generative Layout Stage

Saved places expose a description-to-layout job panel. It proposes new objects
without replacing existing scene geometry, validates architecture/circulation,
and uses the same preview/apply transaction. Accepted snapshots retain generation
receipts through later revisions, export and fork. This is structural planning,
not fresh material/mesh generation or complete generative district acceptance.
See [PLACE_BUILDS.md](PLACE_BUILDS.md) for configuration, durability limits and tests.

## Mended Drum Street (Legacy Template)

The street template adds reusable tavern, house, well, and barrel components to
the same scene validation, revision, world-map, and export contracts. Facades
face local -Z; the tavern has a closed north-facing door, an east frontage sign,
and a southwest chimney. There is no generated or traversable interior.

The local example opens with a generated reference chart, offers a source-pixel
zoom toward the visually located Drum, then cuts explicitly to authored geometry.
The guided approach follows Short Street south, turns west along Filigree, turns
south toward the door, and looks back north/east. It sends movement requests to
Rapier rather than writing camera positions directly. Manual movement cancels the
guide. Editing the template disables that fixed route until the original layout
is restored; it does not pretend to navigate to a moved destination.

The example is non-persistent, with Apply disabled. To save a street in a world,
open an owned saved source image and select the Mended Drum street template,
review the authored dimensions, then Preview and Apply. No user worlds are
modified by opening the example. See `research/25-mended-drum-demo.md` for the
image provenance, limitations, and reproduction commands.
