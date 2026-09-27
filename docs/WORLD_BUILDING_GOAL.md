Implement OpenFlipbook’s full world-building roadmap through a complete, genuinely generative, self-hostable release.

  PRODUCT VISION

  OpenFlipbook is a world you create by exploring and editing it. Start with a prompt, sketch or image; enter a place; draw or describe changes; move through its spaces; expand its surroundings; and
  return to the same persistent world.

  Maps, illustrations, editable 3D, interiors and saved camera views must represent the same underlying world, not disconnected generations.

  Preserve the original image-first exploration experience. Add connected 3D as a first-class experience without turning the product into a generic modeling application.

  Keep OpenFlipbook open-source, self-hostable and BYO-key. Anyone should be able to pull the repository and run it. A hosted service, subscription, mandatory cloud account or proprietary demo
  platform must not be required.

  FIRST COMPLETE RELEASE

  Deliver a richly detailed, Ankh-Morpork-like city district generated and edited through ordinary product workflows.

  The acceptance district should contain:
  - Approximately 80 x 80 authored metres of connected outdoor space.
  - At least eight distinct buildings.
  - Connected streets and recognizable landmarks.
  - At least two enterable buildings with usable interiors.
  - At least one accessible upper-floor room.
  - AI-generated materials and props.
  - At least one whole-mesh architectural object.
  - An adjoining area created through exploration.

  This is an acceptance scenario, not a hardcoded template or the limit of the product. The same systems must work for other fantasy districts and non-fantasy environments.

  Creation and exploration come first. Autonomous characters, quests, simulation, multiplayer and cinematic production remain part of the longer roadmap but are not prerequisites for this release.

  NON-NEGOTIABLE WORLD CONTRACT

  1. One authoritative world structure:
     Stable identities, parent-child relationships, dimensions, transforms, architectural openings and connections must persist independently of generated images.

  2. Structure controls derived representations:
     AI may propose structural changes, but image generation, extraction and viewpoint changes must never silently overwrite committed geometry or identity.

  3. Separate geometry and appearance:
     Geometry, materials, meshes and derived views must have traceable revisions. Appearance changes must not accidentally move buildings or change their dimensions.

  4. Honest provenance:
     Distinguish imported references, estimated geometry, generated additions and user-authored changes. Do not claim that a single image reconstructs unseen surfaces or interiors.

  5. Persistent assets:
     Revisits load saved content. Forks retain immutable asset references and provenance. Save, reload, replay and export must not regenerate content.

  6. Explicit derived-view dependencies:
     Images and clips must record the scene, relevant revisions, camera or registration, and asset identities used to produce them. Outdated views remain historical, not current.

  7. Atomic changes:
     Extend the existing preview/apply transaction system. Reject stale or conflicting proposals without partially mutating the world.

  8. No hidden spending:
     Paid work requires explicit generation intent within approved limits. Hovering, navigation to saved places, reloads and replay must never trigger paid generation.

  CORE PRODUCT WORKFLOWS

  A. Explore to generate
  - Start from text, drawing, uploaded artwork or supported map imports.
  - Generate detailed places when the user chooses to enter or expand them.
  - Resolve the intended place, establish its layout and connections, create geometry, generate appearance, validate the result and persist it.
  - Keep unknown neighboring areas unbuilt until requested.
  - Preserve existing world structure when expanding sideways or outward.
  - Do not regenerate the center of a world to create its surroundings.
  - Make generation resumable and show meaningful progress and failures.

  B. Editable architecture and interiors
  - Generate structured footprints, walls, floors, roofs, doors, windows and stairs.
  - Support compound footprints rather than only rectangular buildings.
  - Derive interior constraints from the building’s envelope and openings.
  - Preserve the same building identity across exterior, interior, map and illustrated views.
  - Keep circulation and entrances clear.
  - Use real openings and collision geometry for traversal.

  C. Generated meshes
  - Keep whole-mesh AI generation as a first-class capability, not an abandoned experiment.
  - Support generation, import, inspection, orientation, placement, duplication and replacement.
  - Use generated meshes for props, architectural details and distinctive exterior objects.
  - Preserve aspect ratio by default; make stretching explicit.
  - Do not label a solid exterior mesh as enterable.
  - Whole-mesh building conversion requires a compatible structural shell, doorway and collision representation, with visible validation.

  D. Draw and describe changes
  - Connect text instructions, freehand annotations, selected image regions, plan footprints and direct 3D transforms to stable world entities.
  - Support adding/removing objects, moving buildings, changing height, editing roofs, placing doors, changing materials and furnishing rooms.
  - Registered image edits must use saved camera/geometry correspondence.
  - Unregistered concept drawings remain proposals until explicitly aligned and promoted.
  - Preserve unrestricted concept creation without letting it silently alter the committed world.

  E. Connected movement
  - Support plan, orbit, walk and illustrated exploration.
  - Move through actual saved geometry, including sideways movement, turns, doorways and stairs.
  - Connect scene chunks using explicit transforms and compatible openings.
  - Load both sides before crossing a connection.
  - Persist a valid camera/player pose and recover safely when structural edits invalidate it.
  - Use explicit loading boundaries when continuity is unavailable.
  - Never hide incorrect geometry behind a generated dive, dissolve or flattering cut.

  F. Consistent artwork
  - Generate view-conditioning assets from the actual scene: camera renders, depth, normals and object masks.
  - Bind illustrated views to the exact geometry/material revisions used.
  - After edits, identify affected map, street and interior views.
  - Refresh selected artwork without changing unrelated geometry.
  - Preserve protected pixels outside selected edit regions.
  - Reject results based on obsolete revisions.
  - Keep historical views accessible and clearly distinguish them from current ones.

  G. A coherent creator workspace
  - Connect Map, Illustration, Plan, 3D and Walk around shared selection and world context.
  - Provide an inspector, asset library, generation queue, history and recovery states.
  - Preserve selected objects and relevant context when changing views.
  - Make ordinary workflows usable without scripts, manual database changes or developer intervention.
  - Maintain desktop and mobile usability.

  IMPLEMENTATION MILESTONES

  M0. Repair the roadmap and baseline
  - Persist the agreed product roadmap as the authoritative implementation plan.
  - Reconcile stale documentation.
  - Classify features as implemented, live-verified, experimental or planned.
  - Inventory and preserve the existing dirty worktree.
  - Separate coherent changes for review rather than merging unrelated work.
  - Complete the fresh generated-mesh acceptance test when spending is approved; continue unpaid work meanwhile.

  M1. Persistent connected-world foundation
  - Extend scene versioning for elevation, structured buildings, floors/rooms, materials and explicit connections.
  - Add derived-view provenance and immutable world-asset metadata.
  - Preserve existing IDs, saved worlds and version-1 scene compatibility.
  - Migrate existing scenes only through explicit edits.
  - Remove the requirement that every new structured place must already have a saved source image.
  - Reuse existing world, entity and transaction systems rather than creating competing authorities.

  M2. Reliable generative creation
  - Extend durable jobs to cover place builds, assets and derived views.
  - Persist dependencies, input revisions, reservations and provider request IDs.
  - Support submission, status, cancellation and recovery.
  - Recover known provider jobs after restart.
  - Never automatically resubmit ambiguous work.
  - Allow replacement of a failed asset without rebuilding the entire place.
  - Retain compatibility with existing generation routes.

  M3. Architecture and visual quality
  - Extend the existing planner/layout solver for building, street and circulation constraints.
  - Keep Three.js and Rapier as the rendering and movement foundation.
  - Finish the current Hunyuan text-to-mesh integration and add an image-to-mesh route for accepted concepts.
  - Verify provider schemas, availability and pricing before enabling paid paths.
  - Generate world-specific material assets and bind them to architectural surfaces.
  - Validate and optimize assets while retaining original bytes and provenance.
  - Judge visual quality from real camera movement, not a single favorable screenshot.
  - Do not call flat placeholders or generic blockouts a finished generative environment.

  M4. Connected traversal and derived views
  - Load connected chunks into consistent coordinate frames.
  - Implement doorway alignment, collision, stairs and pose restoration.
  - Connect geometry-driven camera views and image-generation conditioning.
  - Preserve correct targets and landmarks across entry, movement and return.
  - Keep optional video as a derived artifact of accepted scenes, never the world’s source of truth.

  M5. Self-hosted release and complete demonstration
  - Extend the existing Docker setup with capability checks, durable processing and clear configuration states.
  - Provide backup/restore and operator-mediated ownership recovery.
  - Round-trip architecture, connections, materials, meshes and view bindings through world export/import.
  - Publish only explicitly selected read-only content.
  - Prevent viewers from generating content or accessing private notes.
  - Record the complete real workflow, preserving generation receipts and elapsed times.
  - Deliver a continuous exploration recording alongside any edited presentation.
  - Video output is silent by default.

  VERIFICATION AND COMPLETION CRITERIA

  The goal is complete only when all of the following are demonstrated:

  1. Fresh creation:
     The acceptance district is created through the real UI without prepared scene assets, hidden injection or route-specific scripts.

  2. Editing:
     Draw an addition, move it, change building height and roof appearance, furnish an interior, refresh affected artwork, undo and reload.

  3. Traversal:
     Walk streets, approach the selected building, cross its doorway, explore inside, climb to an upper floor, exit and return without wall crossings or substituted destinations.

  4. Consistency:
     Verify coordinate transforms, exterior/interior compatibility, stable identities, unchanged unrelated entities, protected pixels, stale-view detection and rejection of obsolete results.

  5. Generality:
     Repeat the same workflows on another fresh fantasy district and one non-fantasy environment.

  6. Reliability:
     Test duplicate submissions, restarts, lost responses, cancellation, failed downloads, budget races, concurrent edits, missing assets and cross-owner access.

  7. Persistence:
     Save, reload, fork, export/import and replay retain the correct content and cause zero new model submissions.

  8. Browser quality:
     Inspect desktop/mobile screenshots and actual rendered pixels. Test keyboard/touch controls, movement, loading/errors, text fit, non-overlap and resource cleanup. Record performance on named
     environments and distinguish emulation from real-device testing.

  9. Fresh setup:
     A clean checkout can follow documented setup, generate a world, edit it, explore it, restart and restore it without developer intervention.

  10. Evidence:
      Relevant unit/integration/browser tests pass. Fresh model output receives visual inspection. Report failures and limitations honestly. Mocked fixtures do not establish generation quality, and
      judge scores do not override visible failures.

  WORKING RULES

  - Implement and verify complete, reusable capabilities in milestone order.
  - Maintain an accurate progress record and remaining-work list.
  - Do not stop at documentation, schemas, scripts or a polished video.
  - Do not mark a milestone complete while required product behavior is still unimplemented or unverified.
  - Preserve unrelated user changes and existing assets.
  - Do not incur unapproved model charges, subscriptions or top-ups.
  - Do not deploy, publish publicly, perform destructive changes or merge unrelated work without appropriate authorization.
  - Do not promise perfect automatic reconstruction or universal model consistency.
  - When a model path fails, diagnose it and improve the product contract rather than concealing it with prepared assets.
  - Keep the larger roadmap visible: richer terrain, larger streamed worlds, advanced mesh editing, reusable style packs, characters, stories, simulation, collaboration and filmmaking. These must
  build on the same persistent world foundation.

  The finish line is a working generative world-building product that someone else can run and use, not another collection of disconnected demonstrations.

## September 14 Priority Amendment: One Connected Product

This amendment supersedes conflicting sequencing above, including strict
milestone-order execution and treating all AI camera motion as optional.
The full release scope and world contract remain in force. Do not replace them
with a video-only project, a mesh viewer, or another isolated feature showcase.

### Immediate Integration Gate

Before expanding the feature inventory, prove one reusable end-to-end workflow
through the ordinary OpenFlipbook UI, in one persistent world:

1. Create a visually rich place from a prompt, sketch or image. For image-led
   creation, establish and inspect the map-to-scene registration and landmark
   identities; a text-only layout loosely resembling the image does not qualify.
   Keep uncertain or unregistered artwork explicitly a reference.
2. Select the same named building across map, illustration, plan and 3D. Generate
   a closer illustrated view conditioned on its accepted geometry and camera.
   Preserve its footprint, entrance, neighboring landmarks and world identity.
3. Draw or describe a change, inspect the structural or appearance proposal, and
   apply it atomically. Demonstrate both an appearance-only edit and a structural
   edit. Refresh affected map and street artwork from the accepted revision;
   preserve unrelated entities and protected pixels. Independent image edits
   that never connect back to the world do not satisfy this step.
4. Approach that building through saved geometry, enter its compatible interior,
   reach an upper floor, exit and return. Preserve identity, openings and pose.
   Do not substitute an unrelated interior or imply reconstructed unseen space.
5. Author a useful camera shot against that same world: select a landmark,
   preview its path, check clearance and framing, and explicitly request a
   priced AI clip. Compare the generated motion with the geometry reference.
   Local Three.js playback is reference evidence, not an AI-generated result.
6. Expand an adjoining area without replacing the existing place, then revisit
   the original building. Existing transforms, identities and accepted edits
   must remain intact.
7. Save, reload and replay the world, edited views and accepted video without
   new provider submissions. Expose failed jobs, historical outputs and stale
   dependencies instead of silently substituting content.

Implement in bounded vertical slices that strengthen this shared workflow.
Fix reliability prerequisites when they block the slice, but do not let
unrelated infrastructure or additional demo assets displace the integration work.

### Geometry-Driven AI Motion: Next Technical Slice

Audit and reuse the existing saved camera paths, scene captures and durable jobs.
The current H3 image-to-video integration is not the H3 camera-controls adapter.
Implement a versioned, testable mapping from supported fixed-target world paths
to the selected provider's controls, with explicit coordinate conventions,
supported limits and calibration assumptions. Never imply that a provider
consumes geometry, depth or end frames unless its verified API actually does.

Verify current schemas, availability and pricing before paid work. Begin with
small directional arc, rise and approach tests on one asymmetric, source-bound
scene, within separately explicit spending approval. Establish numeric reference
measurements and pass/fail tolerances before submission. Inspect direction,
landmark tracks, occlusion order, architecture preservation and endpoint framing.
Save failures as well as successes, exact parameters, source bytes, scene and
asset revisions, target identity, camera path, adapter version and request IDs.

Connect successful supported shots to preview, priced generate, progress,
review, accept and stored replay in the product. Keep unsupported travel,
doorway transitions and disoccluded spaces explicit. A failed calibration is
not completion: preserve the evidence and evaluate a better-suited conditioning
route within approved spending. Do not conceal mismatches with cuts or dissolves.
An explicit cut remains an honest presentation fallback, not proof of continuity.
Video stays a derived artifact and must never overwrite authoritative geometry.

### Quality And Delivery

Visual quality, controllability, responsiveness and identity consistency are
acceptance requirements, not deferred decoration. Sparse rectangular blockouts,
repetitive textures, empty interiors, laggy orbit loops and unrelated generated
shots are diagnostic outputs, not the finished experience. Record frame-time
measurements on named hardware and inspect actual motion at desktop and mobile
sizes; a still screenshot cannot establish usability or performance.

Deliver a silent, understandable full-workflow recording and the actual
geometry-driven AI clips, with a short linked evidence index. Preserve an uncut
interaction record; mark generation waits and any presentation edits honestly.
Show before/after changes and return visits. Clearly distinguish geometry
references, AI output, imported assets and unresolved approximations.

Keep generality, self-hosting, BYO keys, privacy, recovery, export/import and all
original release checks. The first connected demonstration is an integration
gate, not completion of the full goal. No new model spending, subscription,
deployment, public publication or merge is authorized by this amendment.
