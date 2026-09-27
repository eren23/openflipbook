# OpenFlipbook World-Building Roadmap

Updated September 14, 2026. This replaces the experiment-led execution queue.
The full accepted objective is [WORLD_BUILDING_GOAL.md](WORLD_BUILDING_GOAL.md).
Historical experiments remain evidence, not competing priorities.

## Direction

Create a world through exploration, drawing and editing. Maps, illustrations,
editable 3D, interiors and saved camera views share authoritative structure.
Open source, self-hosted, BYO keys. Creation and exploration precede simulation.
First release: a richly detailed approximately 80 x 80 metre district, eight
buildings, two enterable interiors, an upper-floor room, generated materials
and props, a whole-mesh architectural object, and an adjoining generated area.
These are release gates, not a hardcoded scene or a reduced project scope.

## Milestones

Execution priority: the September 14 amendment in
[the goal](WORLD_BUILDING_GOAL.md#september-14-priority-amendment-one-connected-product)
requires one connected creation/edit/traversal/illustration/AI-motion/replay
workflow before further feature expansion. The next technical slice is the
geometry-to-video adapter and controlled calibration, not another isolated mesh
orbit. This integration gate does not replace the complete release gates below.

| Milestone | State | Remaining release work |
| --- | --- | --- |
| M0: roadmap and baseline | In progress | Reconcile stale docs, inventory reviewable changes, verify fresh mesh output when authorized |
| M1: connected-world foundation | In progress | Elevated connections, derived-view/asset contracts; bounded compound shells, floor rooms, source-free creation and ground connections now verified locally |
| M2: durable creation | Layout/material/mesh and camera-illustration jobs | Ambiguity reconciliation, resumable full builds and fresh provider verification |
| M3: architecture and appearance | In progress; compound outlines, movable stairs, durable single-image mesh input and compatible authored mesh shells implemented locally | Roof-junction quality, richer stairs, fresh material/image-to-mesh quality, automatic shell fitting/repair, general layout/circulation |
| M4: traversal and views | Connected ground places, saved poses/paths, captures, illustration drafts, protected object composites and opt-in masked jobs | Richer doorway/elevation connections, structural image validation and fresh whole-view/masked illustration quality |
| M5: self-hosted release | Not verified | Clean setup, recovery, complete world import/export, published assets, fresh full demo |

## Evidence Baseline

- Library, private notes, Sketch and local scene editing exist in the working
  tree; many changes are unmerged. Their feature docs describe bounded checks.
- Scene changes use preview/apply transactions, immutable revisions and mapped
  object identities. Legacy scenes render parametric objects, not inferred space.
- Structured version-2 buildings now have editable openings, identified floors,
  a local interior and stair traversal. This is an authored structural subset;
  the full district and connected generative architecture remain unfinished.
  See [the progress record](WORLD_BUILDING_PROGRESS.md) for evidence and gaps.
- Source-free worlds now create through the normal editor, persist without image
  nodes, resume from the library, export and fork. Real database/browser checks
  cover desktop/mobile and concurrent creation. This is not generative place
  creation.
- Adjoining areas now preview/apply with persisted boundary connections. Walk
  preloads both places and traverses shared collision without a scene swap.
  Browser/DB checks cover entry, return, current-place editing, export and fork.
  Areas are authored ground, not generated districts; room portals and elevation
  connections are still absent.
- Walking positions now save in owner metadata, with local coordinates and
  building/floor/room identity where available. Reload revalidates against current
  collision geometry; unsafe or substituted-room positions recover to a checked
  entrance. This is not a general portal or elevated connection system.
- Furnishings now bind to a building/floor with local transforms and derived
  elevation. The editor supports floor cutaways, placement, reassignment and
  footprint drawing; shared geometry keeps rendering, collision and map records
  aligned through building edits. Orthogonal room partitions now have real doors,
  stable identities, editable names and conservative floor-plan circulation
  checks. Browser checks cover crossing doors, climbing stairs, room-aware resume,
  rename, merge recovery, export and fork. Arbitrary architecture and exact
  general navigation solving remain unfinished; this is not generated quality.
- Straight stair flights now have optional saved local position and cardinal
  climbing direction. Treads, slab openings, collision and circulation use one
  transform; legacy buildings retain their default flight. Invalid placements
  fail before save, interior-only moves do not trigger exterior repaint, and
  source-bound captures become historical. Desktop/mobile saved-world workflows
  and all four real-physics climbing directions pass. Non-straight/multiple
  flights remain required follow-up, not completed work.
- Compound outlines now retain stable wall IDs and drive exterior openings,
  clipped floors/partitions, roofs, collision, room membership and map borders.
  The UI supports corner trimming, wall recesses and numeric corner editing.
  Desktop/mobile browser checks cover a recessed entrance, upper rooms and
  furnishing, stairs, reload, historical captures, export and owner fork.
  This is bounded orthogonal architecture, not fresh AI quality: diagonal walls,
  enclosed courtyards, advanced roof intersections and arbitrary stairs remain.
- Text-to-mesh jobs, private persisted GLBs, placement, forks and export are
  implemented locally. The independent worker now submits once, recovers known
  provider IDs, stores assets without the browser, and retries failed storage
  without generating again. Atomic publication, cancellation and exported provider
  provenance are covered by isolated fixture tests. New placements measure saved
  vertices and preserve proportions, with explicit stretching and server-side
  proportion validation. Manual source-axis quarter-turn correction now preserves
  physical scale, placement and map/collision bounds. Saved legacy shapes are not
  migrated. Unconverted meshes retain conservative box collision; automatic up/front inference and
  arbitrary pitch/roll remain limits. See [GENERATIVE_3D.md](GENERATIVE_3D.md).
- September 14: one fresh Hunyuan shrine and four generated materials were
  applied through the isolated live product within the approved $4 run. This
  establishes a bounded asset workflow, not district quality or map alignment.
  The user rejected its mesh-orbit presentation as the wrong demo direction.
- Local GLB import, replacement and duplication now share the existing scene
  contract and immutable asset library. Import validates embedded geometry and
  textures locally, retains original bytes/provenance and needs no model worker.
  Replacement keeps world identity/placement and fits new proportions; duplication
  creates a new entity at a clear footprint. Desktop/mobile fixtures cover
  lost-response retry, texture pixels, movement, undo, history, export/fork and
  no generation. More formats and automatic optimization remain unfinished.
- Compatible outdoor meshes now support explicit authored shell conversion in
  the ordinary inspector. The source asset, identity and envelope remain intact;
  identified floors, doors and stairs supply structural collision. Preview checks
  owned, hash-pinned source triangles against shell free space using the exact
  rendering transform. Closed facades and blocked stair apertures reject, rather
  than being hidden. Desktop/mobile fixture workflows cover validation failure,
  replacement, entry, stairs, wall blocking, pose reload, exit, capture asset
  bindings, changed-door rejection, export/fork and zero provider submissions.
  This is authored compatibility, not automatic reconstruction or demonstrated
  generated-building quality. Shell fitting/repair, richer source geometry and
  a fresh model acceptance trial remain unfinished. See
  [the conversion contract](GENERATIVE_3D.md#authored-shell-conversion).
- Image-to-mesh now accepts a saved world image/accepted Sketch result or uploaded
  concept through the ordinary mesh panel. Original and normalized input bytes
  are immutable, private and hash-pinned before paid submission; image mode has
  separate opt-in configuration and a compatible-worker gate. Known-ID recovery,
  proportional placement, saved-asset reuse, owner fork and input export use the
  same asset/scene pipeline. Desktop/mobile fixture workflows pass; fresh model
  output, multi-view input and geometry reconstruction are not verified.
- Base-color material jobs now share the durable asset worker. Saved textures
  bind to selected architectural surface types, path slabs and place ground with metre-based UVs, without
  changing geometry. Desktop/mobile fixture tests cover recovery, assignment,
  reload, export and fork. Fresh AI quality, seamless tiling and full PBR maps
  remain unverified or unimplemented. See [GENERATED_MATERIALS.md](GENERATED_MATERIALS.md).
- Furnishing generation can target a saved floor selected in the shared editor.
  Consent, durable jobs, provider input and receipts retain its exact IDs; results
  outside that floor are rejected. Ordinary preview/apply and optional generated
  prop meshes preserve the existing shell. Backend/worker capability checks gate
  scoped requests. Desktop/mobile fixture workflows pass; explicit room-ID scope
  and fresh furnishing quality remain unfinished. See [floor generation](PLACE_BUILDS.md#generate-furnishings-for-a-saved-floor).
- Accepted layouts can now propose shared material requests for their new
  buildings and paths, plus ground for initially empty, untextured places only.
  Existing ground requires an explicit creator edit. An explicitly approved appearance batch creates revision-bound child jobs in
  one budget transaction. Ready assets assemble into one textured preview/apply;
  failed items can be replaced independently. Fixture browser tests cover the
  linked workflow. Mesh proposals reserve new physical volumes and retain their
  own quotes, child jobs and failure recovery within the combined approval. Proportional owned GLBs and
  materials assemble into one scene transaction. Generated exterior meshes remain
  solid until explicitly converted and validated against an authored shell;
  interiors are not inferred. Full build-to-illustration orchestration remains unfinished.
- A first description-to-layout job path proposes additions to saved places,
  with durable inputs/results, explicit reservations, geometry validation and
  preview/apply provenance. Browser tests use a fake planner, not fresh AI output.
  An independent layout worker now survives web restarts and recovers saved
  responses without model retries. Derived-view jobs now use explicit saved-camera
  requests; automatic full-build orchestration remains unfinished. See
  [PLACE_BUILDS.md](PLACE_BUILDS.md).
- Layout jobs now freeze saved incident boundary links alongside the scene input.
  Planning and deterministic clearance/routing preserve each opening; changed
  links invalidate starts, previews and new asset spending even if the local
  scene revision is unchanged. Receipts retain the original connection snapshot
  and hash. Scheduled layout/material/mesh work rechecks these dependencies before
  paid claims. This is connection-aware local creation, not a general elevated
  portal system; fresh model quality remains open.
- Explicit adjoining-area creation now commits its base geometry, canonical link,
  budget reservation and scheduled layout job in one transaction. The editor opens
  the new area's durable queue; lost acknowledgements retry the same proposal-bound
  request, and failed reservations leave the original world unchanged. Manual blank
  creation remains free. Layout review and explicitly approved material/mesh stages
  reuse the existing workflow. Automatic illustrated-view orchestration and fresh
  visual-quality acceptance remain unfinished.
- One appearance approval now reserves all remaining planned materials and meshes
  atomically, including a durable receipt on the layout job. The UI presents one
  total, combined readiness and completed-preview action while retaining individual
  failed-asset replacement and recovery. Missing approved stage records cannot
  authorize regeneration or silently produce an untextured completed preview.
  Earlier independent batch routes remain compatible. Fresh visual quality and
  automatic illustration/view orchestration are not established by this wiring.
- Existing map/street/interior images and demo films do not prove automatic
  geometry reconstruction or connected exterior/interior traversal.
- Saved camera views now capture render/depth/normals/object masks from actual
  plan/orbit/walk geometry. Private persistence, history, owner fork/export and
  exact camera/source bindings are implemented and fixture-browser verified.
  GPU mask bytes and sampled depth/normals are checked against known geometry.
  Opt-in illustration drafts now consume saved color/depth through durable jobs,
  with explicit review, stale-source rejection and immutable output persistence.
  Historical views now have an explicit same-camera geometry refresh: rebuild
  current plan/orbit/walk sources offscreen, retain exact framing and dimensions,
  save a linked immutable capture, then use its ordinary opt-in illustration flow.
  Old accepted artwork stays historical and untouched. Capture refresh does not
  copy an obsolete camera path or pay for generation. A full current-camera draft
  can now be previewed as a protected local refresh over predecessor artwork:
  changed render/depth/normals/semantic-mask pixels plus two-pixel padding are
  replaced, including old/new footprints and rendered shadow changes; all other
  decoded RGBA pixels remain exact. Both dependencies and accepted pointers are
  checked before publication/acceptance. This does not establish style continuity
  or model geometry adherence. Per-visible-surface invalidation and cross-view
  refresh orchestration remain unfinished.
  Selected-object previews now composite a proposal over accepted artwork using
  exact saved object-mask pixels, with lossless outside-pixel protection and
  stale-base rejection. A separate opt-in masked job now takes accepted artwork,
  selected object pixels and saved depth; raw results require a protected local
  composite before acceptance. Provider schema verification and fake-provider
  workflows do not prove live execution or structural adherence. Registered
  freehand subregions now support brush/eraser, undo/clear and mouse/touch drawing,
  clipped to saved object identities. The same bounded strokes generate the UI
  overlay and server mask, persist through masked jobs and protected composites,
  and clear consent on change. Brushed reservations require compatible workers;
  whole-object editing stays compatible. Fresh provider quality, background-region
  editing and cross-view appearance propagation remain unfinished.
  Saved illustrations now have a main workspace surface with registered selection,
  brush editing and comparison, alongside Plan/3D/Walk. Mode changes retain drafts;
  historical same-camera refresh works without a mounted scene viewport. This
  connects existing appearance tools, not automatic texture/geometry propagation.
  See [PLACE_ILLUSTRATIONS.md](PLACE_ILLUSTRATIONS.md) and
  [PLACE_VIEWS.md](PLACE_VIEWS.md) for format limits and remaining provenance work.
- Full completion requires every gate in the objective, including fresh
  generation, second fantasy and non-fantasy worlds, and clean self-hosted setup.
- Fork publication now uses a single snapshot transaction including ownership
  and a durable browser-scoped request receipt. Retried requests return the same
  copy; failures cannot expose partially copied geometry/assets/views. Private
  inputs stay owner-only and billable jobs remain excluded. Full portable backup
  remains unfinished. Operator-mediated single-world ownership recovery now has
  expiring, single-use grants and production-stack desktop/mobile browser tests;
  see [OWNER_RECOVERY.md](OWNER_RECOVERY.md). It is not database/blob restoration.
- Content exports now use one metadata/permission snapshot, fail on missing
  page/reference bytes or truncation limits, and include a versioned checksum
  inventory. Owner bundles retain node provenance, registry tombstones, scene
  heads, resume state and unused saved mesh/material assets.
- My Worlds now imports complete owner content archives with dependency/byte
  validation, private preview, remapped node/storage identities, verified asset
  staging and atomic content/ownership/retry publication. Desktop/mobile tests
  cover a mesh-and-artwork round trip, transaction rollback, lost acknowledgement,
  restart and exact saved camera fingerprints without extra model submissions.
  Additional desktop/mobile round trips retain two-storey stair traversal,
  saved upstairs pose, connected boundary movement and mesh/material bytes after
  restart. Map repaint imports now validate source lineage, geometry baselines
  and accepted registration history; pure round trips preserve map projections
  and floor furnishing transforms. This is not complete backup/restore: external
  clip/reference bytes, unbound drafts, legacy atlases, staging cleanup, operator
  recovery, fresh map-backed UI acceptance and clean-host verification remain open.
- Isolated production Docker verification now builds web/backend/worker against
  fresh local Mongo/Minio volumes, with no provider credentials. Desktop/mobile
  browser checks exercise manual architecture, textured mesh import, camera save,
  ZIP restore, process restart and movement; Sketch also draws, saves, generates
  a mock candidate and reopens it. Docker now forwards the opt-in Sketch build
  flag. Local setup documentation includes both frontend/backend Sketch flags,
  worker configuration and local-stack security limits. This is clean-storage
  fixture evidence, not fresh AI generation, full backup or release acceptance.

## Immediate Work

1. Preserve the accepted objective and reconcile conflicting documentation.
2. Extend the verified structured-building and source-free creation foundation
   toward compound architecture and connected places, preserving existing worlds.
3. Extend bounded room circulation and ground-boundary traversal toward elevated
   and portal connections, retaining shared structural/render/collision coordinates.
4. Build resumable explore-to-generate on this shared structure; test fresh AI
   output only within separately approved spending limits. Complete fresh appearance
   acceptance and integrated derived-view refresh, not just successful fixture jobs.
5. Continue through all M0-M5 gates. An authored shell is foundational progress,
   not completion of generative architecture, visual quality or the full release.

## Geometry-Guided Camera Video Experiment

Added September 12, 2026. Provider integration remains planned and untested.
September 13: local scene-camera controls now implement numeric orbit controls,
keyframe insertion/removal, scrubbing and playback, with desktop/mobile browser
checks. Local preflight now sweeps Rapier camera clearance against solids and
rendered mesh surfaces, and samples selected-target visibility. Paths remain
editable as drafts, with explicit saved-view capture/load, scene/asset/target
bindings and projection-preserving replay now implemented locally. September 14
adds [source-bound H3 preparation](CAMERA_MOTION.md), including accepted artwork
and reference matrices. It is uncalibrated and makes no paid submissions. A
draggable rig gizmo and calibrated provider adapter remain missing. See
[camera control status](CAMERA_PATH_CONTROLS.md). The September 14 goal amendment
promotes geometry-driven AI motion into the connected-product integration gate.
H3 itself remains a candidate, not a mandatory vendor or a proven geometry
solver. Durable illustration and world-building work must connect to the same
workflow rather than become competing standalone demos.

Candidate: `minimax/h3-max/camera-controls`, a separate endpoint from our existing
H3 first/last-image route. It accepts one starting image and 2-12 subject-relative
keyframes with normalized time, azimuth, elevation and distance. It does not
accept an ending image, mesh, depth, normals, camera matrices or an explicit
world-space target. This is not arbitrary six-degree-of-freedom navigation or
guaranteed arrival-image matching.
[Fal input schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/camera-controls),
[API documentation](https://fal.ai/models/minimax/h3-max/camera-controls/api).

Execution sequence:

Product control surface: an unframed Three.js scene with a draggable camera rig,
a selected object/landmark pivot, an orbit dial, elevation/distance sliders plus
numeric inputs, and a keyframe timeline with add/remove, scrub, play/pause and
duration controls. Offer bounded arc/rise/approach presets and a start-camera
reset. Preview is local and free; generation remains a separate priced command.
Persist world-space poses and target identity independently of provider settings.
Show collision/visibility failures at the affected keyframes and path segments.
Provide keyboard/touch equivalents; mobile uses the same scene and compact
timeline, not a separate feature-limited editor.

Reuse reference inspected September 12: Spiderchat's
`frontend/src/components/controls/PresetStudio/VisualPickers/CameraAnglePicker.tsx`
and `CameraDistancePicker.tsx` in the sibling `non_linear_ai_chat` checkout.
These select descriptive prompt strings, not numeric camera trajectories.
Adapt their visual interaction patterns, not their string-valued state or
illustrative geometry. Keep OpenFlipbook standalone with no runtime dependency
on a sibling checkout, and no changes to Spiderchat required.

1. Build a free local preview from a saved perspective camera and a selected
   building/landmark pivot. Derive a bounded, fixed-target camera path in shared
   world coordinates. Check the interpolated path for collisions and target
   visibility, not just its endpoints. Reject unsupported moving-target, roll,
   projection or lens changes instead of silently approximating them.
2. Translate that path into provider keyframes through a versioned adapter.
   Treat axis signs, reference angles and distance normalization as calibration
   hypotheses, not a metres-to-provider contract. Unit-test finite values,
   ordering, angular wraparound, limits and degenerate camera/pivot positions.
3. With separate spending approval, calibrate small left/right arcs, a rise and
   a dolly on one asymmetric scene. Save the source image, world revision,
   target identity, camera path, adapter version and exact provider parameters.
   Render intermediate geometry reference frames for evaluation; do not claim
   that H3 receives those frames or our depth/normal/mask passes.
4. Trial a short building arc with its doorway visible, then a rise and doorway
   approach only if calibration passes. Compare against the same local path:
   correct direction, landmark tracks, occlusion order, unchanged architecture
   and arrival framing. Set numeric tolerances before the paid batch and record
   every result, including failures. No cherry-picked film substitutes for this.
5. Promote only demonstrated shot types into an explicit preview/generate/review
   workflow. Reuse durable job, budget and private-asset patterns: one submission,
   saved request ID, storage-only retries and free saved replay. Bind clips to
   source revisions; stale outputs stay historical, never update world geometry.
   Publish silent derivatives with audio tracks removed and verified absent.

Fallback: use the real geometry render or an explicit cut when continuity cannot
be established. Do not conceal wrong arrivals with a dissolve. Unseen interiors
and travel between unrelated frames remain separate unsolved cases. If H3 fails
the geometry checks, retain the failure evidence and compare a reference-video
provider from the [model landscape](research/15-controllable-model-landscape.md)
on the same task, subject to a new budget approval.

Budget planning only: fal lists a six-second 768P clip at $0.12 during its launch
promotion and $0.48 after the stated September 14 expiry. Recheck price and
account access before requesting a capped batch; this plan authorizes no spend.
[Fal pricing](https://fal.ai/models/minimax/h3-max/camera-controls).

## Working Rules

No hidden generation, provider retry, spending, deployment or public publication.
Do not discard dirty work or batch-merge unrelated changes. Structure controls
derived images; uncertainty remains explicit. Record failed experiments and
acceptance evidence. Revisit, reload and replay reuse stored assets without billing.
Relevant regression suites and browser checks run before milestone completion.

Longer horizon: larger streamed worlds and terrain, advanced mesh editing,
world/style packs, character identity and animation, lore/stories/quests,
optional simulation/multiplayer, camera timelines and derived films, splats and
portable editor integrations. These build on the same world revision contract.

The previous roadmap is retained in
[the historical archive](archive/ROADMAP_2026-09-10.md).
