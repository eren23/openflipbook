# Connected Drum World and Constrained Shape Fit

Date: 2026-09-10

This extends the local study in `27-drum-alignment-materials.md`. It does not
claim automatic reconstruction or automatic synchronization of image pixels and
meshes.

## Connected Workflow

- `/sketch/world/ankh` and its geometry study now offer **Save to world**.
- Saving imports the existing city map, street image and historical teal edit
  through the normal owner-gated node API. It makes no generation calls.
- The street is a child of the map at the observed 43.4%, 61.4% map location;
  the teal image is an edit child of the street. This is navigation provenance,
  not a claim of surveyed map-to-street coordinates.
- Import retries reuse the same session and per-asset idempotency keys. Imported
  assets are labeled as imports, not newly generated provider output.
- World editor opens the fitted scene as a draft. Authored dimensions must be
  confirmed, then Preview and Apply explicitly commit the first revision.
- Roof shape, eave height, ridge offset, roof material and texture-pack ID are
  now canonical optional scene fields. Existing scenes remain compatible.
- Saved scenes render the bitmap materials in the normal plan/3D/walk editor.
  The Drum's 3D view starts at the street reference camera, rather than a distant
  overview. Plan and walking remain separate inspection modes.
  Material edits use the existing proposal, optimistic revision and history
  machinery. Roof changes do not move any object or replace its identity.
- The street-image link retains its place and requested image. Its version
  selector opens the chosen saved node in native Sketch, in the same world.
- Scene lookup follows same-session `edit` ancestors, with a visited set and
  64-hop bound. It does not follow descents or cross-world parents. Explicit
  place links reject images outside that place's edit lineage.
- The original geometry reference remains immutable. The requested edited image
  is separate; an image edit is never silently declared geometry-verified.
- Geometry proposals mark existing edit descendants as historical/outdated too,
  not just the first source image. Traversal is bounded at 2,000 images.
- Forks retain the optional geometry/material fields. World ZIP exports include
  material-pack metadata and atlas bytes, with the asset explicitly traced into
  standalone builds.

The image view deliberately does not reuse the demo's hand-placed hotspot
coordinates on arbitrary saved image edits. Those edits can move landmarks.

## Alignment

The receipt is `apps/web/public/demos/ankh-morpork/alignment-fit.json`, generated
by `scripts/record-demo/fit_drum_camera.py`. Eight manually annotated image
features are used: six fit features and two check features. Checks participated
in candidate selection; they are not an unseen evaluation set.

| Candidate | Fit RMS | Check RMS |
| --- | ---: | ---: |
| Original | 86.79 px | 28.18 px |
| Free camera, rejected | 11.25 px | 51.40 px |
| Fixed camera, heights only | 44.81 px | 28.18 px |
| Fixed camera, roof and rear depth | 23.13 px | 28.18 px |

The new provisional default keeps the camera, its field of view, front wall at
Z=13, door threshold, street entrance, well, barrels and all object/entity IDs.
It fits the following authored dimensions:

- Tavern depth: 5.4 -> 7.163506 m, extending backward only.
- Eave height: 6.215067 m; ridge height: 8.998207 m.
- Ridge offset: +2 m. This hits the chosen bound, so it is not an unconstrained
  optimum or proof that this ridge position is physically correct.
- Rear yard and west yard wall shorten to stay behind the expanded building.

The preview shows those footprint changes explicitly. Unit tests compare the
Three.js projections with the Python receipt, validate scene bounds/entrance,
and preserve the original fixture without mutation. The free-camera fit remains
visible for comparison but cannot be imported as an accepted fitted profile.

## Rendering and Correctness

Roof tint is a per-material uniform, not a shader recompile for each swatch.
Static views render when changed; walk mode continues rendering during movement.
Static shadow maps are reused between camera moves. Materials use mesh-space
UVs, never screen-space or camera-dependent lookup.

A canceled texture decode no longer overwrites the replacement viewport's
readiness metadata. Semantic roof tags are independent of the chosen paint
color. Scene comparisons ignore property insertion order, preventing false
"changed object" receipts after schema parsing.

Visual inspection also caught a camera-target reset inside the OrbitControls
constructor: position was correct, orientation was not. The saved viewport now
restores the explicit authored target; browser tests assert the viewing direction
as well as position.

## Verification

- Focused geometry, schema, material, import, persistence, fork and export tests.
- Full web coverage passed: 78.49% lines/statements, 82.73% functions, 88.32%
  branches. Floors unchanged. One overloaded run timed out in the existing large
  ZIP test; rerunning with two workers passed, without changing its timeout.
- Production build passed, with existing dependency/lint warnings. The output
  trace includes the material atlas for the world-export route.
- Desktop/mobile canvas tests cover nonblank pixels, exact reference camera,
  camera travel, texture loading, roof changes, overlays and fallback materials.
- Existing garden plan/orbit/walk and collision tests still pass.
- Brave live check: import, preview/apply revision 1, roof-only revision 2,
  historical image selection, native Sketch, and return to the same revision 2.
- `e2e/drum-world.spec.ts` tests the real Mongo/R2 workflow with isolated imports,
  read-only-before-Apply assertions, reload, revision restore, owner rejection,
  desktop/mobile screenshots and generation calls blocked. It removes its own
  test records and image objects afterwards.
- The complete live persistence test passed after fixing the canceled-decode
  race. An earlier dev-server run also hit a client-bundle syntax error during
  active rebuilds; the stable rerun passed the image-version navigation step.
- The seven enabled browser tests passed; the saved-world test then passed again
  with the viewing-direction assertion. Final screenshots are retained under
  `docs/research/assets/drum-world/`. No new film was rendered in this pass.

Reproduce from `apps/web` with the configured local server:

```sh
E2E_DRUM_WORLD=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/drum-world.spec.ts
E2E_DRUM_GEOMETRY=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/drum-geometry.spec.ts
pnpm test:coverage --maxWorkers=2 --minWorkers=1
```

## Still Unfinished

The fit remains specific to the annotated reference image, not a solver for
arbitrary edited views. Saving a world does not establish exact image/mesh
registration; the saved image view labels alignment unverified. New generated
edits remain historical image versions until separately reviewed as geometry
or material changes. The alignment study's comparison profiles remain local;
the persisted scene is edited in World editor, not overwritten by choosing a
study profile.

Unseen surfaces, detailed architecture, windows/interiors, and distant streets
are still authored or synthesized approximations. Reusable bitmap textures are
not a recovered photogrammetric atlas. No new paid generation or video model
calls were made in this pass.

## Combined Film, September 11

The complete 33.1-second, 1920x1080, 30 fps cut is on the Desktop as
`openflipbook-mended-drum-full-2026-09-11.mp4`. It is silent. Its sequence is
map focus, street illustration, native drawn image edit, real model result,
current textured 3D movement, explicit roof-material change, return movement,
alignment overlay, Preview/Apply, and the saved revision after a full reload.

This is an edited demonstration from two recorded sessions, not one uninterrupted
interaction. The image edit comes from `ankh-image-first-take3`; the new recording
imports those existing assets and persists the fitted scene through the real
world API. Generation and import/reload waits are omitted. The image-to-3D cut
is explicit, and captions distinguish authored geometry from reconstruction and
manual material changes from automatic transfer. No new model calls were made.

The new recording completed without browser errors and checked revision 1 and
the teal roof after reload. Its isolated browser owns the saved demonstration
world; that recording's world ID is not a link into another browser's session.
Receipts, source video, and per-shot composition metadata are under
`docs/research/assets/drum-connected-film-2026-09-11/`.

Reproduce from `apps/web` with the configured server on port 3003:

```sh
node scripts/record-drum-geometry-demo.mjs ../../docs/research/assets/drum-connected-film-2026-09-11 --connected
node scripts/compose-drum-connected-film.mjs ~/Desktop/openflipbook-mended-drum-full-2026-09-11.mp4
```

The composer validates both source receipts before rendering, preserves actual
UI footage for edit/save actions, and records exact frame-counted cut boundaries.
Final checks covered metadata, decoded frames, caption placement, and camera
movement. This film documents the current improvement; it does not resolve the
remaining image/mesh fidelity gap.
