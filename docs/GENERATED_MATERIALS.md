# Generated Surface Materials

Local implementation, updated September 13, 2026. This adds generated base-color assets
to structured buildings, paths and outdoor ground. It is not a complete PBR pipeline, reconstructed
appearance, or proof of fresh model quality.

## Creator Workflow

Save a world, select a structured building, and open its material controls.
Choose wall, floor, roof, ceiling or stair. Describe a material, approve the
displayed reservation and generate. Generation does not automatically assign it.
Choose a saved thumbnail, adjust tile size in metres, rotation and roughness,
then preview/apply the normal scene edit. Removing a binding restores the default.

Select **Ground** in the object list to generate or reuse an outdoor ground
texture. Select a path to texture its slab. Both use the same saved material
library, explicit reservation and preview/apply workflow; selecting a surface
never starts generation. Ground is a place-level appearance binding, not a
synthetic building or additional geometry. Paths accept the `floor` surface only.

Bindings are per building and surface type, not individual wall faces. Assignment
changes appearance only; footprints, openings, collision and dimensions remain
unchanged. The same saved asset can be reused without a model call. UV coordinates
use object-local metres, so moving a building or path does not slide its texture.
Ground uses place-local metres, including when a connected chunk is translated
or rotated. This remains a flat authored ground surface, not generated terrain.
Roughness is an authored scalar, not an AI-generated roughness map.

## Provider and Configuration

The adapter uses `bytedance/seedream/v5/pro/text-to-image`, requesting one
1024 x 1024 JPEG with safety checks and a versioned base-color tile prompt.
The official [API schema](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image/api)
was checked September 12, 2026. The [model page](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image)
listed tentative pricing of $0.0675 per image up to 1536 x 1536 at that check.
Recheck before enabling; a reservation is not a guaranteed invoice limit.

- Backend: `MATERIAL_GENERATION_ENABLED=1`, `FAL_KEY`, `SHARED_TOKEN` and an
  operator-verified `MATERIAL_RESERVATION_USD` greater than zero and at most $10.
- Default backend reservation is zero and generation is disabled.
- Web: `MATERIAL_DAILY_CAP_USD` plus existing global/session budget limits.
- Web and independent place worker must share the database, backend token and
  configured R2/Minio storage. See [worker setup](PLACE_BUILDS.md).

No real environment values were enabled by this implementation. There is no new
dependency. A heartbeat advertises storage-capable mesh/material processing;
provider capability checks independently determine whether generation is enabled.

## Persistence and Recovery

Materials can also be requested as dependencies of an accepted place layout.
See [Dependent Material Stage](PLACE_BUILDS.md#dependent-material-stage) for
batch consent, shared surface targets, revision checks and individual replacement.
Independent material generation remains available for existing buildings,
paths and ground. A layout can propose ground appearance only for a place with
no existing objects or ground binding. Later additions cannot repaint existing
ground implicitly. The creator can still explicitly change it through its inspector.

The existing asset execution engine handles separate `material_jobs` and
`material_assets` collections alongside mesh jobs. Reservations and insertion
are atomic. Requests pin model, parameters, prompt version and reservation.
The worker submits once, stores the provider request ID, polls known work after
restart and downloads the result into owned immutable storage.

Ambiguous submissions are quarantined rather than automatically repeated.
Cancellation before claim refunds once; after claim, provider billing may still
occur. Storage-only retry retains the same paid request. Shared budget ledgers
prevent concurrent mesh/material reservations from bypassing session limits.

Downloads accept only the existing permitted fal media origins. JPEGs are decoded
strictly within byte, resolution and memory limits: at most 12 MiB, square,
256-2048 pixels. Storage and publication pin SHA-256. Decoding establishes a valid
image, not visual quality or seamless tiling; metadata explicitly says
`base_color`, `srgb`, `tiling: unverified`.

Library and byte routes are owner-only. Scene preview rejects foreign or missing
asset references, including assets used only by ground. Bindings participate in ordinary revision history and stale
proposal checks. Export contains `surface-materials.json`, original JPEG bytes
and provider provenance. Forks retain immutable assets but copy neither executable
jobs nor spend reservations. Saved camera views include these material identities
and source definitions in their immutable dependencies. Full world import/restore remains unfinished.

## Verification and Limits

Unit tests cover schema validation, unchanged vertices/collision, local UVs,
texture cleanup, private persistence, shared budget races, submission ambiguity
and storage recovery. Backend tests intercept HTTP and check pinned arguments,
single submission and saved-job reads with generation disabled.

The opt-in `e2e/place-build.spec.ts` suite runs real UI/API/database/worker paths
against a loopback provider fixture. Material cases cover desktop/mobile, killed
workers, storage failure/retry, wall/roof/path/ground assignment, camera movement, reload,
export and fork with one fixture submission. Checker-texture pixel checks prove
rendering and workflow, not AI quality. See the [progress log](WORLD_BUILDING_PROGRESS.md).

Still needed: fresh model inspection, tiling-quality validation, normal/roughness
maps, automatic cross-view artwork refresh and the complete
generated district. No perfect material consistency or reconstruction is claimed.
