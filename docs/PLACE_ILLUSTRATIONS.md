# Saved-Camera Illustrations

September 13, 2026. Implemented locally; provider generation remains opt-in.
Loopback fixtures test the workflow, not AI quality or exact structural adherence.
This advances M2/M4 and does not complete the full world-building release.

## Product Workflow

In the owner world editor, save scene changes and capture a camera view from
Plan, 3D or Walk. The saved-view panel includes an Illustrations section:

1. Describe appearance and explicitly approve the displayed reservation.
2. Generate a draft from the saved color render and depth PNG. The independent
   worker continues when the tab closes; job state remains available on return.
3. Compare the stored result with its original render using the same framing.
4. Accept a loaded draft only while its source bindings are current. Acceptance
   selects artwork for that camera view; it does not edit any geometry, material,
   map entity or source PNG.

Older drafts and accepted images remain available after structural changes,
marked historical. **Refresh saved view geometry** renders the updated world at
that historical view's exact camera and pixel size, saving a linked new capture
without moving the live camera. Its explicit generation request then refreshes
artwork from the new color/depth inputs. The old accepted image and mask remain
historical; they are not automatically transferred to the new geometry. See
[PLACE_VIEWS.md](PLACE_VIEWS.md#refresh-after-a-world-edit).
The UI supports storage-only retry and cancellation. An uncertain submission
retains its request identity instead of silently creating another generation.

## Protected Refresh After Geometry Changes

After refreshing a saved camera's geometry and generating a full draft for that
new capture, choose **Preview protected refresh**. This is a local, zero-provider
composition, separate from both paid generation and **Accept illustration**:

1. The base is the predecessor view's accepted artwork, or its saved color render
   when it has no accepted artwork. Both captures must have identical camera,
   dimensions, mode, floor and surface policy, with direct `refreshed_from` lineage.
2. Compare the two immutable color, depth, normals and object-mask passes. Object
   masks are compared by stable identity rather than palette index; linear depth
   values use each capture's own range with quantization tolerance. Empty sky is
   excluded from depth differences.
3. Changes include old and new footprints, exposed surfaces and changed rendered
   shadows. Expand the changed pixel set by two pixels. Copy only those RGBA
   pixels from the new draft; preserve every other decoded sRGB base pixel exactly
   and encode a lossless PNG. No resizing or feathering.
4. Compare **Previous artwork**, **Source render** and the new **Illustration**,
   inspect the refreshed/protected pixel counts, then explicitly accept the PNG.

`geometry_refresh` retains both camera dependencies, base/proposal IDs and byte
hashes, the previous destination acceptance pointer, pixel counts and method
`registered_render_delta_rgba_v1`. `mask_sha256` hashes the reproducible raw
one-byte-per-pixel mask (255 editable, 0 protected), not a PNG. Original model
output and old accepted artwork remain immutable. Owner forks and ZIP export
retain the composite bytes and provenance.

Publication and acceptance recheck current geometry and both artwork selections.
Missing/corrupt inputs, incompatible framing, no visible change and full-frame
replacement are rejected. Lost-response retries retain the same request; a
completed preview can be retrieved even after later edits. These local previews
share the existing 50-request/edit limit with other illustration operations.

This is a **render-difference mask**, not semantic reconstruction or proof that
the model followed the camera. Lighting/render changes can broaden the editable
area; painted details extending beyond rendered silhouettes may remain outside it.
Model geometry, color and style inside the edited region still require review.
Hard boundaries can be visible. No automatic cross-view propagation, style
matching or fresh provider-quality claim follows from pixel protection.

## Registered Object Edits

A saved illustration can now supply changes for selected visible objects, using
the immutable object-mask pass from its exact saved camera:

1. Select a generated draft and choose **Edit selected objects**. Pick objects on
   the image, or use the keyboard-accessible checkbox list. The cyan overlay is
   the exact editable silhouette, not an AI-estimated segmentation.
2. **Preview selected edit** creates an immutable local PNG. Selected pixels come
   from that draft; all other pixels come from the currently accepted artwork,
   or the original source render if no artwork is accepted. This action submits
   no model work and creates no reservation.
3. Compare the preview with **Previous artwork**, then explicitly accept it.
   Region selection hides whole-image acceptance to prevent applying the entire
   draft accidentally. Acceptance never changes scene geometry or material assets.

The compositor preserves every outside RGBA pixel in decoded sRGB, including
background, unselected objects and occluders. It performs no resizing, feathering
or lossy output encoding. Original provider JPEG bytes remain a separate asset.
The PNG records proposal/base IDs and hashes, mask hash, selected stable object
IDs, pixel counts, method version and the immutable camera dependency. Accepted
PNGs can be the base for subsequent selected edits. ZIP exports retain both the
original JPEG and the PNG with correct extensions and provenance; private owner
forks retain the same bytes and lineage.

Missing/corrupt files, mismatched dimensions/camera bindings, invisible selections,
all-image selections and obsolete source geometry fail closed. Selection is
bounded to 128 distinct captured object IDs. Generation requests and region
previews share a per-view limit of 50. Publication rechecks geometry and accepted
base transactionally after upload. Acceptance also rejects a composite whose base
has since been replaced, even if the client has observed the newer accepted ID.
Lost preview responses retry the same identity; completed previews remain
replayable after a scene edit without creating another asset or model request.

### Freehand Subregions

The registered picker now includes **Brush region**, **Erase region**, a radius
slider, **Undo region stroke** and **Clear region strokes**. **Select whole
objects** restores the existing whole-silhouette selection. A brush gesture can
select its starting object when none is selected; object checkboxes remain
available. Brush/eraser strokes are clipped to those objects' saved visible pixels,
not background or another object's silhouette. Every selected object must have
painted pixels before the region can be submitted.

Mouse and touch use saved-image pixel coordinates independent of the displayed
image size. Pointer cancellation rolls back the current stroke; captured touch
drawing does not scroll the page. The displayed cyan overlay and server use the
same binary pixel-centre coverage, not browser-antialiased canvas stroke pixels.
Paint and erase are applied in order, then intersected with the immutable object
pass. Outside pixels, including unpainted parts of the selected object, remain
protected by the local compositor.

Strokes can supply either a free **Preview selected edit** from an existing draft
or an explicitly reserved **Generate selected change**. The latter persists the
same `brush_strokes` in job/result `edit_input`; the final composite must retain
that exact brush intent rather than silently broadening it to the whole object.
An earlier whole-object masked proposal can also be narrowed locally with a
brush, provided it stays within that proposal's original selected objects.
Changing strokes clears generation consent. Lost-response retries freeze strokes
with the prompt, base, selected identities and reservation.

Brush composites record method `object_clipped_brush_rgba_v1` and ordered strokes
in `region_edit`. Old whole-object assets keep their original method and hashes.
The existing owned input checks, stale-source rejection, worker recovery,
explicit acceptance and fork/export provenance apply without new model routes
or changes to authoritative geometry.

Bounds: 32 strokes, 512 total integer pixel points, 1-64 pixel radii, registered
image dimensions up to 1024x1024, and eight million candidate pixel evaluations.
The existing 16 KiB request-body limit also applies. Invalid, erased-empty,
off-object or overly complex selections fail before a reservation or upload.
This is object-clipped appearance editing, not freehand structural additions,
pressure-sensitive painting, inferred surface UVs or cross-view texture painting.

### Generate A Selected Change

The same picker now has **Apply draft** and **Generate change** modes. Apply draft
is the free local workflow above. Generate change shows the current accepted
artwork (or the source render), takes a separate change prompt and requires
explicit approval of its own displayed reservation. Selection, prompt, base and
quote are frozen through a lost-response retry; retrying uses the same request ID.

The server resolves private input bytes itself: accepted artwork is decoded to
sRGB RGBA and encoded as PNG without resizing, selected stable object IDs become
an opaque black/white PNG from the saved object pass, and the original depth PNG
is retained. White pixels are editable. Missing/full-image/empty masks are not
submitted. Jobs and raw results record the accepted base ID/hash, object-pass hash
and selected IDs in `edit_input`, alongside the existing saved-view dependency.

The worker generates a **masked proposal**, not accepted artwork. **Review result**
opens it; **Preview protected result** runs the local compositor, then the user
reviews and explicitly accepts the PNG. Raw masked output cannot be accepted
through either the UI or API. Its composite must use the original accepted base
and only objects within the generation selection. Original model output and the
composite are both retained in exports and owner forks.

The provider pipeline is implemented and fixture-tested, not live-quality
verified or enabled by default. A model may invent geometry inside the selected
silhouette; human comparison remains required. Protected pixels are guaranteed
by the local compositor, not by the model prompt or inpainting endpoint.
Hard mask boundaries can be visible. Shadows outside the selected object remain
protected, not automatically repainted. Structural mismatch rejection,
background-region editing and cross-view propagation
remain unfinished. Mask provenance remains client-rendered saved geometry, not
server-attested reconstruction.

## Provider Contract

Pinned endpoint: `fal-ai/flux-control-lora-depth/image-to-image`. The current
[fal schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux-control-lora-depth/image-to-image)
accepts an initial color image and a separate depth-control image. We supply
`image_url`, `control_lora_image_url` and the captured dimensions. One JPEG,
safety enabled, 28 steps, guidance 3.5, depth strength 1, image strength 0.7.
These are initial experimental settings, not a calibrated quality optimum.
[Provider API](https://fal.ai/models/fal-ai/flux-control-lora-depth/image-to-image/api).

The backend accepts only bounded, decoded PNG data inputs for this route, not
arbitrary remote image URLs. The worker reads hash-verified private stored PNGs;
the browser cannot substitute conditioning bytes in a generation request.
Normals and object masks remain part of the capture provenance but are not
submitted to the whole-view model. Region generation uses a different endpoint.

### Masked Provider Contract

The opt-in masked path pins `fal-ai/flux-general/inpainting`. Its
[API schema](https://fal.ai/models/fal-ai/flux-general/inpainting/api) exposes
`image_url`, `mask_url`, `image_size` and a `controlnets` list. We send one JPEG,
safety enabled, 28 steps, guidance 3.5 and image strength 0.85. The single depth
control uses `path`, `config_url`, `control_image_url` and conditioning scale 0.7.
These inputs come only from the saved private registration, not arbitrary browser
URLs or client-selected model weights.

The control weights/config are pinned to
`Shakker-Labs/FLUX.1-dev-ControlNet-Depth` revision
`2fdfbcf28432e544b41151b1064a1666fd0d5b47`. The
[model card](https://huggingface.co/Shakker-Labs/FLUX.1-dev-ControlNet-Depth)
recommends conditioning scale 0.3-0.7 and identifies a non-commercial model
license. Operators must verify terms covering these custom weights before
commercial enablement; the fal endpoint's commercial-use label is not proof of
that coverage. No weights were downloaded or license terms accepted here.

The [endpoint page](https://fal.ai/models/fal-ai/flux-general/inpainting) listed
$0.075 per rounded-up megapixel when checked September 13, 2026. This is a public
listing, not an account-specific quote or spending authorization. The combined
inpainting/custom-depth execution, account access, latency, final billing and
visual quality remain unverified. Our captured linear scene depth has not been
calibrated against the control model's depth distribution.

Provider output decoding enforces JPEG, bounded memory/size, and exact source dimensions.
Unexpected provider resizing fails storage rather than silently changing camera
registration. Non-normal EXIF orientation also fails storage and acceptance:
square dimensions alone do not rule out browser-visible rotation or mirroring.
Existing affected files are not silently transformed into new registered assets.
Fresh output must establish whether arbitrary capture dimensions
and this depth encoding are handled faithfully. Correct dimensions alone do
not establish landmark, opening, palette or perspective accuracy.

## Durability And Dependencies

`illustration_jobs` and `illustration_assets` use the existing asset worker and
shared spend ledger. A view dependency records the capture identity, dimensions
and a hash of immutable camera/source/asset metadata and all four pass receipts.
The stored asset retains the dependency, original result bytes, provider request
ID, model, prompt and parameters. Acceptance is a separate mutable view pointer.

- Reservation, dependency checks and scene/frame write fences are transactional.
  Concurrent edits cannot pass an obsolete view through snapshot write skew.
- Input storage is read before the paid claim. Missing or corrupt inputs remain
  scheduled with backoff and can be cancelled for a full reservation release.
- Sources are checked again immediately before claiming submission. Obsolete
  work is cancelled and refunded once. No automatic replacement job is created.
- Masked work also rechecks the accepted base before reservation and after input
  reads, inside the paid-claim transaction. A changed base cancels unsubmitted
  work and releases its reservation. A completed proposal cannot be composited
  onto replacement artwork merely by passing a newer accepted ID.
- A claimed submission is never re-leased. A lost acknowledgement stays
  `submission_unknown`; known provider IDs recover through status reads only.
- Results completed after an edit can be retained as historical drafts, but
  cannot be accepted against the new world. Paid reservations are retained.
- Acceptance checks source dependencies again and uses the previous accepted
  ID to reject conflicting review choices. It never increments scene revisions.
- Download/storage/publication failures use the existing immutable download
  receipt and explicit storage retry, without another provider submission.
- Masked status and storage recovery use the job's saved allowlisted model;
  disabling new generation does not switch recovery to the whole-view endpoint.

Libraries, images and actions require ownership and use private no-store HTTP
responses. Owner forks copy immutable illustration asset references alongside
their captures, not runnable jobs. Public forks omit both. Owner ZIP exports put
drafts and accepted images under `views/N/illustrations/`, with their provenance
in `place-views.json`. Export remains bounded to 64 MiB for camera assets; it
does not claim a completed portable import/restore implementation.

## Self-Hosted Configuration

Existing backend, shared token, asset storage and `place-worker` requirements
apply. No additional provider account beyond the existing optional fal key.
No new dependencies were added for this increment.

Backend operator configuration, disabled by default:
`MOCK_PROVIDERS=1` also disables new paid illustration submissions.

```dotenv
ILLUSTRATION_GENERATION_ENABLED=0
ILLUSTRATION_RESERVATION_USD=0
ILLUSTRATION_EDIT_GENERATION_ENABLED=0
ILLUSTRATION_EDIT_RESERVATION_USD=0
```

Set a positive reservation only after checking current endpoint access/pricing
and approving paid tests. Web reservations use `ILLUSTRATION_DAILY_CAP_USD`
alongside global/session caps; caps are conservative reservations, not an exact
provider-invoice guarantee. The masked route has independent opt-in/reservation
configuration but shares illustration/global/session budget caps.

The storage-capable worker heartbeat advertises `illustration_region: true`.
Masked generation is unavailable when no compatible worker is present. Before
enabling it, stop and upgrade **all** older workers, then start the new workers;
this heartbeat check is not a mixed-version rolling-upgrade guarantee. Old
workers can otherwise claim jobs from the same illustration queue without
understanding masked input or model-specific recovery.

Brushed generation additionally requires `illustration_brush: true` on all live
illustration workers. An older live worker disables new brush reservations and
the UI's brush-generation action while whole-object selection remains compatible.
Stop and upgrade older workers before enabling this path; the heartbeat is not a
deployment lock. Local brush compositing itself needs no generation worker.

Do not change live keys or enable generation just to view saved results.
Known-job reads and immutable assets remain accessible with generation disabled.
Deploy storage with appropriate privacy controls; private app routes are not a
replacement for bucket permissions.

## Remaining Work

Saved illustrations and registered brush editing are available on the main
Illustration workspace as well as in the camera inspector. The main image keeps
its exact saved framing, shares current-place selection with Plan/3D, and retains
brush drafts across workspace mode changes. See
[CREATOR_WORKSPACE.md](CREATOR_WORKSPACE.md#registered-illustration-workspace)
for context, history and reload boundaries. This is an image-view workflow, not
automatic texture projection or cross-view repainting.

- Fresh provider quality and geometry-adherence tests; no live generation receipt
  exists for this increment.
- Live validation/calibration of masked generation from accepted artwork;
  background subregions, geometric mismatch detection and propagation to other
  affected views. Local object-mask composites preserve outside pixels, but
  do not solve those remaining steps.
- Immutable atlas-byte binding for legacy `ankh-street-v1` material packs. New
  illustration generation is explicitly unavailable for those captures today.
- Deletion/orphan cleanup, complete import/restore and broader view registration.
- Local camera-path authoring, preflight and saved-view persistence are available
  (CAMERA_PATH_CONTROLS.md). H3 conversion and generated video remain separate,
  unimplemented work; image or path persistence does not solve video geometry.
