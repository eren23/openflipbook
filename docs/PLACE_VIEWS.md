# Saved Geometry Camera Views

Status: implemented locally; browser-verified with labelled geometry fixtures.
This document covers conditioning inputs. Opt-in durable illustration drafts
now consume them; see [PLACE_ILLUSTRATIONS.md](PLACE_ILLUSTRATIONS.md).
The full release objective remains [WORLD_BUILDING_GOAL.md](WORLD_BUILDING_GOAL.md).

## Product Workflow

In the world editor, commit scene changes, choose Plan, 3D, Plan + 3D, or Walk,
position the camera and use **Camera views / Save camera view**. Split mode
captures the 3D pane. The saved-view selector retains previous captures; Render,
Depth, Normals and Objects select their persisted PNGs. Changing modes, selecting
passes, refreshing the library, reloading and forking do not generate anything.
Only an explicit save renders and stores a new capture; it makes no model call.

The same frozen camera produces four images, with a maximum dimension of 1024
pixels. Selection outlines and sprite labels are excluded. Camera motion and the
live renderer's materials, visibility, render target and color settings are
restored after capture, including failed captures. Pending uncertain save requests
reuse their original ID, label and complete capture, not the latest camera.

### Refresh After A World Edit

Select a historical view and choose **Refresh saved view geometry**. This is a
free local render/storage action, not model generation. It reconstructs the
current saved scene at that view's exact camera matrix, projection, clip planes,
pixel dimensions, mode and floor. The current viewport may be a different size
or mode; its camera and visible scene are not moved or substituted. Plan captures
use the saved cutaway floor, orbit captures use its exterior/floor visibility,
and walk captures rebuild the currently connected chunks in the root-place frame.
Saved mesh and surface-material bytes are loaded through existing private routes.

The new immutable view records `refreshed_from`, points at current geometry and
assets, and starts without accepted artwork. **Previous view** returns to its
ancestor, whose pixels, accepted illustration and source bindings remain intact.
An old camera path is not copied: this action refreshes one still frame and does
not certify movement through changed geometry. A removed floor or unrelated
scene identity rejects refresh. Changed camera framing cannot be saved under
refresh provenance. The server validates the ancestor before storage and again
at publication, alongside the existing current-source checks and write fences.

The renderer releases the temporary scene on success, cancellation or asset/render
failure. A local edit during capture prevents a new write; a concurrent saved edit
is rejected by the server. Lost save acknowledgements and failed library reads
retain the same request and complete PNG capture for retry, including after the
live scene changes. Reloading the page does not resubmit a pending request.
If a response was lost after publication, the immutable result remains in the
saved-view library. Refresh follows the existing 50-view limit; it is not an
overwrite or deletion of history.

To update artwork, use the refreshed view's ordinary **Generate illustration**
workflow with a new appearance prompt and explicit reservation approval. The
worker consumes the new render/depth passes. No old artwork, object mask or paid
approval is silently transferred across geometry revisions. The new full draft
can supply a **Preview protected refresh**: a separate local composite retains
predecessor artwork outside changes detected in the two registered captures,
including old/new silhouettes and changed rendered shadows. Review and acceptance
remain explicit. See [PLACE_ILLUSTRATIONS.md](PLACE_ILLUSTRATIONS.md#protected-refresh-after-geometry-changes)
for pixel/provenance guarantees and limitations. Neither capture nor composition
guarantees painted style, model geometry adherence or cross-view propagation.

## Coordinate And Image Contract

- Camera matrices use Three.js column-major array order. `world_matrix` maps
  camera-local coordinates into the rendered scene frame; `projection_matrix`
  maps camera-space coordinates into WebGL clip space. Perspective and
  orthographic camera types, clip distances, image dimensions and floor selection
  are explicit. The server checks a rigid, right-handed camera transform and
  projection coefficients consistent with the reported near/far planes.
- Orbit and plan capture one saved place at offset `(0, 0)`. Walk captures every
  loaded connected chunk in the same normalized frame used by the live renderer.
  Each source records its scene/place ID, revision and translation; persisted
  bindings retain the complete definition's SHA-256 hash.
- **Render:** sRGB appearance, including transparent surfaces. This is a scene
  render, not a photograph or an AI-generated illustration.
- **Depth:** linear camera-space Z distance, encoded as 8-bit grayscale with near
  white and far black. For byte `b`, distance is
  `near + (1 - b / 255) * (far - near)`. These are the recorded depth encoding
  limits, not necessarily the camera clip limits. Quantization is explicit;
  depth is not lossless or an exact reconstruction format.
- **Normals:** geometric surface normals in view space, mapped from `[-1, 1]`
  to RGB `[0, 255]`. These are not inferred bump-map or unseen-surface normals.
- **Objects:** exact, unfiltered RGB identifiers for stable world object IDs.
  Black is reserved for background and unassigned ground/helper geometry, not an
  additional selectable object. The server validates the entire ID/color table.
- Depth, normal and object passes represent **opaque geometry**. Transparent
  glass remains in the color pass but is absent from geometry passes, exposing
  opaque surfaces behind it. Alpha-cutout, instanced, skinned and actively morphed
  meshes currently reject capture explicitly rather than producing wrong data.

Color and data passes use separate GPU targets. A browser test caught hardware
sRGB conversion surviving a target color-space change; sharing that attachment
would turn object ID `[1,153,25]` into `[13,203,88]` and distort depth as well.
Tests now verify exact mask pixels and compare depth/normal samples to geometric
ray intersections against a known oriented GLB fixture.

## Persistence And Privacy

`place_views` stores immutable camera metadata, source revision/hash bindings,
generated mesh/material IDs and hashes, and hash-checked private PNG references.
Source geometry is checked before upload and again inside the publication
transaction. Shared scene/world-map write fences serialize capture publication
with geometry/frame edits without changing structural revisions. Capturing a
draft cannot silently associate it with a saved scene.

The library compares current source bindings with saved bindings. Changed or
missing sources/assets make a view historical; they never replace its pixels.
Owner forks retain immutable references and bindings. Public-viewer forks omit
private captures. Owner world ZIPs include `place-views.json` and
`views/<index>/<pass>.png`, with camera/source/asset provenance and per-file hashes;
public exports omit private captures. Neither path rerenders or calls a model.

Creator authorization protects list, save, PNG read and private export. Responses,
including private-image failures, are non-cacheable and vary by owner cookie.
The save route validates origin/content type, streams at most 20 MiB of request
bytes, and fully decodes all four bounded PNGs before upload. There is a 50-view
limit per place; camera-view export is bounded at 500 views and 64 MiB.
Walk-video checkpoint views (`walk_checkpoint`, walk mode only) have a separate
limit of 240 per place. A current checkpoint at the same camera and size is
reused. The library list, the export and forks do not include them.
See [walk videos](CAMERA_MOTION.md#walk-videos).

`client_rendered_saved_geometry` is deliberate provenance. The server validates
owned geometry bindings and files; it does not independently attest that an
owner-supplied PNG was produced by that renderer. Do not treat it as an adversarial
image/geometry proof.

## Verification And Remaining Work

- Unit tests cover camera validation, exact palette assignment, malformed PNGs,
  source/asset races, ownership, storage failures, duplicate publication, lost
  responses, historical detection, private fork/export and renderer cleanup.
- Real browser/API/Mongo/storage tests cover orbit/plan/walk saves, actual decoded
  pixels, camera restoration, lost-response replay, immutable export and forks.
  The refresh regression moves an existing mesh, recaptures all three saved view
  modes from the Plan workspace, checks changed pixels with exact saved framing,
  generates from fresh color/depth, previews a protected refresh over old artwork,
  retries its lost acknowledgement without duplication, explicitly accepts it,
  and preserves both view histories and composite bytes through reload, another
  owner fork and ZIP export. Pixel comparisons check unchanged artwork and exact
  draft pixels at changes; local providers remain fixtures.
  Desktop/mobile evidence uses macOS, Node v26.0.0 and bundled Playwright Chromium
  at 1280/390 px widths. This is viewport emulation, not physical-device testing.
- Native PNG decoding uses `sharp` 0.34.5 as a direct dependency, the same version
  already installed transitively through Next. No new model provider is enabled.

Still required: fresh AI illustration quality/geometry-adherence validation,
background-region editing, style/geometry adherence within refreshed regions,
full portable import/restore,
fresh generated-world visual acceptance, and clean self-hosted release testing.
Built-in legacy material packs are identified by their versioned pack ID in the
scene definition, not yet by captured atlas-byte hashes. Missing/replaced static
pack files therefore need stronger provenance before using that path as exact
appearance conditioning. Historical detection is intentionally conservative at
whole-source revision granularity, not per-visible-surface invalidation.

Failed or competing storage operations can leave unreferenced content-addressed
PNGs; publication remains atomic, but orphan cleanup and a view-deletion workflow
are unfinished. The 8-bit opaque-surface format and supported mesh subset must be
considered when choosing future conditioning models. No universal consistency or
image-to-geometry reconstruction claim follows from this capture implementation.
