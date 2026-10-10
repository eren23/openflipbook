# October 3 implementation, verified October 4

This records the local implementation of the approved connected-product plan.
The release objective remains [WORLD_BUILDING_GOAL.md](WORLD_BUILDING_GOAL.md).
Changes are uncommitted. Existing provider accounts, user worlds and deployments
were not replaced by this work.

## Implemented contracts

- Animation requests use last-request-wins cancellation. Stored clips replay
  without submitting again; the saved walk library survives route changes and
  generation flags. Single-clip playback restarts correctly.
- Version-2 path/walk jobs reserve an explicit maximum including one retry per
  eligible step. Every paid claim checks its lease and pinned dependencies in a
  transaction. Failed consistency, landing or timing checks pause and preserve
  evidence. Hash-bound resumes reuse completed work; assembly and derivative
  recovery can run locally for $0. Ambiguous submissions never resubmit.
- Final keyframe bytes have hash-bound verification receipts. Lossless chain
  composites retain protected pixels. Explicit owner content review is distinct
  from geometric validation. Legacy artwork stays viewable without being
  promoted into an approved new chain source.
- Image-conditioned layout explicitly pins the original image and metre-frame
  registration as an estimated proposal. Backend and worker capability checks
  reject unsupported image paths before spend. Source-free worlds derive their
  map camera from accepted geometry and use ordinary illustration review.
- Saved text edits use a durable once-only planner job. Raw output persists
  before deterministic validation; preview/apply use the saved proposal without
  another model call. Supported operations are documented in
  [SCENE_TEXT_EDITS.md](SCENE_TEXT_EDITS.md).
- Layout, material, mesh, furnishing and illustration stages pin their accepted
  dependencies. Appearance preview requires the requested stages. Existing
  compound architecture, floors, rooms, stairs and adjoining-place bindings
  remain the shared geometry foundation.
- Version-4 creator ZIPs retain finalized path/walk media, partial evidence and
  bound ordered checkpoints. Imported receipts remain inert. Private blobs and
  legacy node routes enforce world access before returning content.
- Explicit publication freezes only selected scene/media content. Public files
  remain allowlisted and hash verified; withdrawal revokes the public snapshot.
  Captured neighboring places require selection, and historical media display
  their frozen revisions. Selected placements and connections survive; private
  forks rebuild the canonical map/entity graph independently of the source.
- Full operator backup preserves BSON metadata, ownership, private notes,
  receipts, ledgers and blob bytes separately from portable content archives.
  Restore validates a backup before writing to a fresh destination and supports
  idempotent recovery. See [OPERATOR_BACKUP.md](OPERATOR_BACKUP.md).

## Free verification

Backend: 1,774 tests passed, 2 skipped; coverage 90.59% exceeds the 88% floor.
Ruff passes and the CI MyPy command passes across 70 source files. Shared configuration tests
pass (12), as do isolated-stack parameter checks (11) and receipt boundary checks (2). Focused path-video tests
pass (45) and cover concurrent
claims, changed sources, lost acknowledgments, exact final hashes, failed
candidates, fixed budget ceilings, cancellation, disabled-generation playback,
timing rejection and selective recovery.

Final web checks: 2,778 tests in 290 files pass with coverage enabled. Coverage
is 85.66% lines/statements, 88.43% branches and 85.60% functions; all existing
floors pass without being lowered. Web lint has zero errors and four existing
warnings, workspace type checks pass, and 751 files have no dependency cycles.
The real ffmpeg tests retain exact media assertions and use bounded 30-second
timeouts for the two encode/decode-heavy integration cases. Production-browser
verification passes all nine scenarios on the final production image, including
desktop/mobile authoring, textured mesh import, restart and ZIP recovery,
Sketch persistence, operator access recovery and selected public snapshots with
independent private forks. Public viewers must render spatially varying pixels
at a usable height; mobile pages must fit their viewport. The publication page
now supplies the flex layout required by its 3D viewer.

The real Mongo/S3 backup test preserves all seven fixture collections, BSON
types, indexes and exact blob bytes, rejects anonymous blob reads and proves
idempotent restore. The independent worker exits with code 0 after SIGTERM in
1,595 ms and leaves no heartbeat rows. Only this run's named fixture volumes
and containers are removed.

Recorded evidence: [selfhost-5P8va5 result](../apps/web/test-results/selfhost-5P8va5/result.json),
[worker shutdown](../apps/web/test-results/selfhost-5P8va5/worker-shutdown.json),
[browser run](../apps/web/test-results/release-selfhost-final.log),
[web coverage](../apps/web/test-results/release-web-final.log) and
[backend coverage](../apps/web/test-results/release-backend-final.log).
Screenshots, browser recordings and detailed traces remain alongside the run
receipts in the local ignored evidence directory.

The release district fixture is locally authored test data: 80 by 80 metres,
eight buildings, two interiors, an upstairs room and floor-bound furnishings,
in fantasy and contemporary styles. It exercises persistence and UI integration;
it does not establish fresh model-generated quality.

## Remaining generated-quality acceptance

The implementation and release gates above ran without paid providers. On
October 4 the user explicitly authorized paid models. A fresh isolated pilot
then ran with verified current rates and a $5 cumulative reservation ceiling.
The original $4.04 allocation plus a separately reviewed $0.40 layout extension
totals $4.44; completed requests hold $4.34 in application reservations. The saved
world has four connected places and eight buildings. Generated illustration and
motion consistency remain quality gates, with both illustration and both motion
attempts failed and unaccepted. Current furnished-world navigation and saved-media
replay pass. The actual paid-world backup restored and reopened with all 28
collections and 67 stored objects intact, providers disabled and no worker. See the [current pilot record](PAID_QUALITY_PILOT_2026-10-04.md)
for its actual results and limitations. Previous Claude/Codex experiments remain
historical evidence, separate from this fresh authorization and ledger.

The pilot must exercise image registration or source-free creation, generated
materials/props/whole mesh, structural and appearance edits, affected-view
refresh, interior/upstairs traversal, adjoining expansion and bounded AI motion
in the same persistent world. Compare generated outputs with saved geometry,
preserve failures and exact receipts, and replay the saved results without new
submissions. Authored fixtures and ordinary Three.js playback cannot certify
provider consistency or complete these quality gates.
