# Generative 3D Objects

Experimental product integration, not a prerecorded demo. The World editor can
submit a description to `fal-ai/hunyuan3d-v3/text-to-3d` or an accepted concept
image to `fal-ai/hunyuan3d-v3/image-to-3d`, save its textured GLB, and place that
asset in an existing editable place scene. Fresh provider output
has not yet been verified end to end. Automated browser checks use labelled
geometry fixtures and must not be presented as evidence of AI output quality.

## Workflow

1. Open an owned world's place in the World editor. Standalone demo scenes do
   not offer paid generation.
2. Describe one object, review the reservation, and select Generate mesh.
3. An independent worker submits the saved job, polls its provider ID and stores
   the completed file even with the browser and web server stopped.
4. Once ready, select Place in scene. The editor finds an unoccupied footprint;
   if none fits, change the scene before trying placement again.
5. Select the object to change its name, position, heading, width, depth or height.
6. Preview and apply the existing scene proposal to save it and its map footprint.
   Generated geometry renders in plan, orbit and walk views.
7. Forking retains immutable asset bindings. Whole-world ZIP export includes
   referenced GLBs and `mesh-assets.json` with prompt, model, provider request ID,
   generation parameters, creation time and SHA-256 provenance.

### Image And Sketch Inputs

In Generate 3D object, select **Image**. Choose an existing world image (accepted
Sketch results are saved world nodes), a previously saved concept, or **Upload
concept**. PNG, JPEG and single-frame WebP inputs are supported up to 12 MiB and
16 megapixels, with a minimum 32-pixel output dimension. Upload works in an owned
source-free world too. Saving or selecting a concept does not call a model.

The original file is retained unchanged. A separate PNG input corrects EXIF
orientation, removes metadata and fits within 2048 x 2048 without enlargement or
aspect-ratio distortion. Both files have independent SHA-256 hashes. The preview
shows the actual provider input through a creator-only image route, not a public
storage URL. Storage itself must remain private under the operator's bucket
policy; the API cannot override public bucket access.

Set an **Asset name**, review this mode's separate reservation and select
**Generate mesh**. The name labels the saved asset; it is not a generation prompt
for this endpoint. The provider receives the frozen PNG as a data URI and the
pinned mesh parameters, not a source URL or a browser-supplied storage key.
This is single-image generation. Optional back/left/right reference inputs in
fal's schema are not exposed yet and require their own multi-view quote.

Input provenance records imported-reference versus saved-world-image origin,
the original node/model when applicable, dimensions and immutable file hashes.
It does not establish world registration, reconstruct hidden surfaces or promote
an image to committed geometry. Generated assets still need proportional
placement and the normal preview/apply transaction; solid exteriors do not gain
enterable interiors.

The worker validates the frozen input before its paid claim. Unavailable storage
leaves the job scheduled, reserved and cancellable with a retry backoff. Corrupt
input cancels before submission and releases the reservation once. Re-importing
identical original bytes can repair a missing input without changing its identity
or calling a model. Later edits/deletion of the original world image do not alter
an already frozen concept.

Owner forks retain both input files and original provenance, without copying
billable jobs. Saved assets have a placement entry even when their original job
is absent or outside the recent-job list. Owner ZIP exports of referenced meshes
include the GLB, normalized input, original file and portable provenance. Private
concepts are excluded from viewer forks and public exports. Origin node IDs refer
to the original reference, not the fork's structural identities.

## Import, Replace And Duplicate

Select **Import**, choose a self-contained `.glb`, then **Import GLB**. Choosing
a file alone does not upload it. This path needs owned-world database/storage
access, not a provider key, paid reservation or running generation worker.
The imported asset appears in Saved meshes and uses the same placement,
source-orientation, inspection and preview/apply controls as generated assets.

Imports retain the original bytes, including embedded UVs and textures. A
content hash defines their world-scoped identity. Retrying after a lost response
or reimporting a renamed identical file returns the original metadata; it does
not duplicate assets. Retrying the same bytes can also repair missing/corrupt
storage. Database publication follows blob storage; a failed publication can
leave an unreferenced blob, but cannot publish an asset before upload succeeds.
No model job, provider request ID or spend receipt is fabricated for an import.
Private owner exports/forks retain import provenance and exact GLB bytes.

The import path adds the pinned, local Apache-2.0
[Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator)
package (`gltf-validator@2.0.0-dev.3.10`, no transitive dependencies). It checks
references, binary accessors and conformance before Three.js measures actual
vertices. Sharp fully decodes embedded texture data before publication. Warnings
are retained and visible; validator errors or a truncated report reject import.
This additional validation currently applies to imported files; the existing
provider download checks described below are not a full conformance validator.

The supported import subset is bounded: GLB 2.0, 80 MiB maximum, one embedded
binary chunk, triangle meshes, up to 512 nodes, 16 scenes, 2,048 instantiated
draw primitives, 1.5 million vertex/index entries across instances and 128 MiB
declared decoded accessor data. Up to 32 embedded single-frame PNG/JPEG/WebP
images are allowed, each at most 4096 x 4096, with 64 megapixels combined
(up to four full 4K PBR maps). Original texture bytes are retained on restore;
this ceiling is an import allocation bound, not a mobile performance guarantee.
External resources, required extensions, GPU-instancing extensions, skins and
animation are rejected. Ordinary repeated mesh nodes work within the instance
budget. Other formats, compression decoding, automatic optimization and a
process-isolated hostile-content sandbox remain unfinished.

Select an existing mesh, then **Replace selected mesh** on another saved asset.
Replacement keeps the object/entity IDs, label, position, heading, role and
floor binding. It resets source-axis correction for the new file and fits its
original proportions inside the old object's dimensional envelope. It does not
stretch the new file, move the object to make room, overwrite the old asset or
infer openings. Invalid floor/circulation fits reject before changing the draft.
Undo restores the previous draft; preview/apply commits one revision and marks
dependent camera views historical. Historical revisions retain the old asset.

The mesh inspector's **Duplicate mesh** icon creates a new object/entity identity
using the same immutable asset, sizing and source orientation. It finds a clear
footprint on the same floor or outdoors; no room means no draft mutation. A
duplicate does not share the source object's drawing-element identity. Neither
replacement nor duplication submits generation or makes a solid mesh enterable.

## Authored Shell Conversion

An outdoor mesh can now use **Add structural shell**. This keeps the original
asset, world/entity identity, position, heading and dimensional envelope, and
creates explicit building architecture in the same draft. Shell floor count and
roof allowance start from the authored height; the existing architecture inspector
controls identified walls, openings, rooms and stairs. Floor-count changes on a
mesh-backed building change its shell, not the source mesh envelope. This is an
authored proposal, not inferred interior geometry or automatic reconstruction.

**Preview** checks the actual saved GLB before offering Apply. The server verifies
ownership, immutable byte hash and import-level conformance, then uses the same
source-axis correction and proportional/stretched fit as visible rendering.
It subtracts the shell's actual walls, glass, floors, partitions, ceiling and
stair treads from horizontal bands, producing connected free-space boxes. Three's
triangle/box intersection test rejects mesh surfaces crossing this free space,
including the exterior door, compound recesses and upper stair aperture. It is
not a camera-ray sample or a judge score. The preview shows a validation result
with triangle and volume counts; client-supplied success claims are not trusted.

The bounded checker allows 3 mm around structural solids and exempts the bottom
2 cm and the roof volume above the eaves. It supports static geometry, up to
500,000 triangles, 2,048 free volumes and 10 million triangle/volume comparisons
per object. Unsupported or over-budget cases fail explicitly. This is not exact
triangle collision, a topological solid-volume proof, automatic doorway finding,
geometry optimization or a proof of visual quality. Richly detailed incompatible
meshes may need source editing or a different generation before conversion.

A closed-box building is rejected: neither the facade nor a blocked stair slab
is hidden to make walking work. Original GLB triangles/UVs/textures remain intact.
The authored shell adds interior surfaces and supplies the existing structural
Rapier colliders and continuous stair ramp instead of the mesh's solid box.
Shell faces use a depth offset against coincident source surfaces; the original
mesh supplies its roof appearance. Explicit plan/floor cutaway hides the source
mesh for architecture editing, but ordinary 3D and Walk retain it. Added shell
surfaces can change visible appearance and require review; validation does not
prove that unseen rooms or every source opening have been reconstructed.

Walk is unavailable while mesh-shell edits are uncommitted. Every preview,
including a later door move or replacement asset, rechecks compatibility before
the existing atomic Apply transaction. Obsolete proposals retain the existing
conflict guard. Dimensions, openings, rooms and material revisions drive map,
walking, camera captures and historical-view invalidation just like other
structured buildings. Asset hashes remain explicit capture dependencies.

**Remove structural shell** returns to a solid mesh draft. It refuses to discard
bound floor contents; move/remove those first. Undo, history, owner fork and
export retain the source mesh and authored architecture. No conversion, check,
walk, reload or replay invokes a generation provider. More general automatic
mesh repair/shell fitting and fresh provider acceptance remain unfinished.

## Layout Integration

Meshes can also be proposed by the layout planner as a separately approved
[dependent mesh stage](PLACE_BUILDS.md#dependent-mesh-stage). It reserves explicit
physical volumes, shares generated assets only across identical instances, and
fits actual GLB bounds proportionally into those envelopes. Ready materials and
meshes apply together with the layout. The inspector distinguishes solid
exteriors from props; neither creates an inferred structural interior.

## Configuration

Backend: existing `FAL_KEY`, `SHARED_TOKEN`, `MESH_GENERATION_ENABLED=1`, and a
positive `MESH_RESERVATION_USD` no greater than 10. Web: matching shared token,
`MODAL_API_URL`, existing Mongo/R2 configuration, and `MESH_DAILY_CAP_USD` (default
4, must be finite and positive). Mongo transactions are required, as with scene
application. Deploy/restart the backend to register `/mesh` routes.

Image mode is separately opt-in: `MESH_IMAGE_GENERATION_ENABLED=1` and a finite
positive `MESH_IMAGE_RESERVATION_USD` no greater than 10 on the backend. Defaults
remain disabled/zero. Both modes share the existing mesh daily ledger. Restart
**all** asset workers before enabling image generation: capability checks reject
a mixed rollout containing a live old worker without image-input support. Known
image jobs retain their exact model in status/result reads even after new image
generation is disabled. Do not roll workers back while new-format jobs remain.

On September 13, 2026, the official [image schema](https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d/api)
confirmed `input_image_url`, GLB output, data URI input and the existing parameter
set. The [model page](https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d) listed
LowPoly at $0.45 plus $0.15 each for PBR and custom face count: approximately
$0.75 for this single-image configuration if those listed charges apply
additively. This is not a live invoice or verified availability/quality receipt;
the operator must recheck rates and choose a conservative reservation before
enabling paid generation. No paid call was made for this integration.

Run the [world-build worker](PLACE_BUILDS.md#configuration) against the same
database/backend/storage as the web server. The `world-build` Docker profile
supplies the existing Minio/R2 configuration to that worker. Locally it uses the
same environment variables via the documented command. A recent storage-capable
worker heartbeat is required before new mesh reservations are accepted. Missing
storage configuration disables mesh processing without disabling layout work.

The provider is configured for PBR, LowPoly, triangle topology and 40,000 faces.
Check [the model schema](https://fal.ai/models/fal-ai/hunyuan3d-v3/text-to-3d/api)
and provider billing units before enabling. The reservation is an operator-set
conservative estimate, NOT a verified quote or a hard cap on the provider bill.
The mesh-specific cap also reserves against the existing daily/session ledgers.
Other generation paths retain their existing estimate-based accounting.

The schema was checked against the official model API on September 12, 2026;
fresh model quality and billed amounts are still unverified. The backend checks
the worker's pinned model, parameters and reservation before submitting. Optional
fields preserve compatibility with older prompt-only backend callers.

The installed fal Python SDK's `submit_async` retries some POST failures
internally. This adapter now uses one HTTPX request with transport retries and
redirect following disabled. It also supplies the documented `X-Fal-No-Retry`
header to opt out of platform queue retries. Status/result reads can be repeated
using the same saved request ID. See [fal's queue API](https://fal.ai/docs/documentation/model-apis/inference/queue).
This is not a claim of exactly-once remote execution or a guaranteed invoice cap.

## Failure And Asset Safety

- Generate atomically reserves spend and inserts a `scheduled` job. Matching
  concurrent submissions deduplicate; different prompts/configuration under the
  same ID reject. No provider submission runs in the initiating web request.
- A worker atomically claims the scheduled job as `submitting`, then establishes
  a second fenced submission marker before the sole POST. Cancellation or an
  expired claim cannot start that request. GET polling never starts generation.
- An ambiguous submission remains reserved and is marked `submission_unknown`.
  An expired two-minute submission deadline exposes that state; legacy jobs
  without deadlines use creation time. A saved provider ID remains recoverable
  even if the subsequent state write failed. Missing IDs are never resubmitted.
- `queued`/`running` jobs are polled with persisted next-check times and reclaimable
  read leases. Failed reads retain the request and back off. Provider terminal
  rejection becomes `failed`, not another generation attempt.
- Ready provider metadata is saved as `storing` before download/upload. Read and
  storage leases last six minutes and fence old workers after expiry. Unlike paid
  submission claims, these non-generative operations can resume after a crash.
- Storage errors become `storage_failed` and expose **Retry mesh storage**.
  Normal reload/status polling does not retry failed storage. Explicit retry
  first reuses checksum-verified uploaded bytes, or retrieves fresh download
  metadata for the same provider request. It never calls model submission.
- Downloaded bytes are hash-pinned before upload. Changed provider bytes cannot
  replace that identity during recovery. Asset registration and job completion
  share a transaction; a database failure cannot expose a half-published asset.
- Cancelling `scheduled` work refunds the original ledgers exactly once. After
  claim, cancellation discards the result but retains reserved spend; it does not
  promise to cancel provider billing. Late IDs are retained for audit and late
  uploads cannot resurrect cancellation. An interrupted upload may leave an
  unreferenced blob; automatic orphan cleanup remains unfinished.
- Only HTTPS fal.media assets are downloaded, without redirects, up to 80 MiB.
  GLB checks reject external resources, required extensions, animation, skins,
  excessive declared primitive counts and invalid headers. This is a constrained
  loader, not a complete glTF conformance or hostile-content validator.
- Saved bytes are SHA-256 checked. Assets are world-scoped and creator-gated.
  Forks bind to the same immutable bytes without copying generation jobs.
- Missing/corrupted assets fail visibly. There is no procedural-object fallback.

The worker runs one layout operation and one mesh operation concurrently so long
layout calls do not block paid mesh retrieval. SIGTERM drains both lanes; Docker
allows six minutes before force termination. Only known-ID reads/downloads may
resume automatically after force termination, never uncertain submissions.

## Geometry Contract And Remaining Work

New placements first measure the saved GLB's actual vertices and node transforms
using Three.js, without texture decoding or a provider request. The private
geometry endpoint caches those dimensions against the immutable asset hash.
Accessor min/max declarations do not determine the measurement. New objects fit
within a 3 m envelope with their original proportions, rather than being
stretched to a cube. The resulting width, height and depth are the authored scene
dimensions used for rendering, map projection and conservative box collision.

`mesh_scale: "uniform"` locks resizing across all three dimensions. Preview also
checks the proportions against the owned asset, and the renderer rejects a
mismatching lock. **Stretch mesh** explicitly enables independent-axis sizing.
Turning it off restores original proportions inside the current envelope; the
change is a draft edit with undo/preview/apply, not a silent migration. Legacy
objects with no scaling field keep their previous independent-axis shape.
Meshes thinner than the scene's minimum dimensions at the initial 3 m scale
are rejected visibly rather than distorted. Initial scale selection for these
extreme aspect ratios remains unfinished.

Position, heading, footprint and identity remain in the existing scene contract.
Unconverted mesh collision is still a conservative box, not the generated
triangles. A generated building starts as a solid exterior; only an explicitly
authored, validated shell enables interiors and structural collision as described
above. Measuring GLB dimensions does not establish real-world units or infer
the generator's intended up/front axes.

### Source Orientation

The mesh inspector exposes source pitch, yaw and roll in 90-degree steps, plus a
reset control. These correct an asset authored with different up/front axes;
ordinary placement heading remains separate. `mesh_orientation` stores integer
quarter-turns `x/y/z` (0..3) in XYZ Euler order, applied before authored sizing and
placement. Missing values preserve existing scenes without migration.

Changing orientation permutes authored dimensions at the same physical scale,
including explicitly stretched objects. It does not regenerate, rewrite source
GLB bytes, change asset identity, or silently move the object to find room. Floor
and scene validation reject a correction that no longer fits. Undo, preview,
apply, reload, history, fork and scene export retain the correction. Corrected
dimensions also drive map footprints and box collision. Restoring proportions
uses the corrected source dimensions, not the original unrotated bounds.

This is manual orthogonal axis correction, not automatic orientation inference
or arbitrary-angle pitch/roll. Model textures remain attached to their original
vertices; the asset's UVs and materials are not regenerated.

This does not reconstruct a map or photograph, guarantee the prompt's dimensions,
solve image/mesh alignment, or automatically repaint map artwork. Fresh image-
and sketch-conditioned quality, multiple image inputs, quality judging,
arbitrary-angle orientation and automatic whole-mesh interior conversion remain follow-ups.
First acceptance gate: generate a
fresh textured object through the real UI and verify placement, edits, save,
reload, fork and export without another model submission.

## Verification

- `pnpm --dir apps/web exec vitest run lib/mesh-asset.test.ts lib/mesh-server.test.ts lib/mesh-dimensions.test.ts lib/mesh-geometry.test.ts lib/mesh-geometry-server.test.ts lib/place-scene.test.ts lib/place-scene-server.test.ts components/sketch/generated-mesh.test.ts lib/fork.test.ts lib/export-build.test.ts`
- From `apps/modal-backend`: `.venv/bin/pytest tests/test_mesh_generation.py -q`
- With the web server running, from `apps/web`:
  `E2E_BASE_URL=http://127.0.0.1:3003 E2E_MOCK=1 pnpm exec playwright test e2e/generated-mesh.spec.ts`
- Independent worker integration, from `apps/web`:
  `E2E_PLACE_BUILD=1 pnpm exec playwright test e2e/place-build.spec.ts`
- Imported-asset validation, replacement and duplication:
  `pnpm --dir apps/web exec vitest run lib/mesh-import.test.ts lib/mesh-placement.test.ts components/sketch/mesh-importer.test.tsx tests/api/mesh-import-route.test.ts`

Browser checks cover actual GLB loading, proportional placement/resizing,
explicit stretch, restoration and undo, visible geometry pixels, camera
movement, errors and horizontal overflow at desktop/mobile sizes.
Orientation checks cover all 64 supported Euler settings (including equivalent
rotations), actual vertex positions and render bounds, ground alignment and
Rapier ray contacts. This does not establish triangle-accurate collision.
The worker suite uses a fresh isolated database, loopback fake provider/storage,
and an explicit subprocess-only fixture for the HTTPS asset download. It tests
real UI creation, worker kills, known-ID recovery with Next stopped, competing
workers, storage failure/retry, preview/apply, reload, export/fork and ownership.
It also checks persisted mesh dimensions, rejects a distorted locked proposal,
and verifies geometry metadata remains private.
Read-lease/heartbeat expiry is accelerated only in the test-owned database. These
are reliability fixtures, not fresh Hunyuan generations or real-device tests.
The imported-mesh browser cases additionally stop the worker, import an embedded
checkerboard texture, lose/retry an upload response, replace while retaining
identity, undo, duplicate, save, reload, export and owner-fork. They verify both
texture colors and actual camera motion at desktop/mobile viewport sizes, and
that these operations create neither model submissions nor spend-ledger entries.
