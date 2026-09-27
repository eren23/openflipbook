# Structured Place Builds

Local implementation, updated September 13, 2026. This is the architecture stage
of generative creation, not a finished district generator. Explicit adjoining
creation schedules its layout atomically; one later appearance approval can reserve
all remaining materials and meshes. Fresh model quality and automatic derived-view
orchestration remain open.

## Workflow

Save a place in World editor, then use **Generate place layout**. A description
and explicit cost reservation create a durable job. The editor starts it after
queue acknowledgement. The model proposes additions; existing objects, dimensions
and entrance are not replaced. Validated output opens in Plan + 3D for review and
uses the existing preview/apply transaction, never a second geometry writer.
Manual draft edits retain the origin of surviving generated objects. Obsolete
results cannot apply or silently rebase. New attempts require explicit consent.

An invalid job with a complete stored provider response can use **Revalidate
saved response** after a validator update. This reruns local validation against
the unchanged input revision and connections, without reserving money, calling
the provider or applying geometry. Missing responses and stale inputs are rejected.
Symbolic object IDs and entity IDs have separate namespaces; using the same name
for an object and its corresponding entity is valid. Duplicates within either
namespace remain invalid.

The planner supports structured buildings, optional rooms/stairs, base colors,
paths and existing parametric prop types. It can propose material requests for
its new buildings and mesh requests for reserved volumes; these run only after
explicit appearance approval as described below. It supports bounded orthogonal compound
footprints, stable wall references and positioned cardinal stair flights through
the same scene validators as manual editing. It does not reconstruct source artwork.
Independent mesh and
[material generators](GENERATED_MATERIALS.md) remain available too.

## Adjoining-Area Generation

In **Add adjoining area**, set its name, dimensions, opening and direction and
preview the boundary proposal. Manual **Apply adjoining area** remains free.
Alternatively, enable **Generate layout in new area**, provide the description
and confirm the displayed layout-only reservation, then **Create and generate**.
The editor opens the new saved place and its existing generation queue. Layout
review, optional approved materials/meshes and Apply follow the same
workflow as an ordinary place build. The unbuilt base is not finished AI output.

The new source-free scene, map/world identities, canonical boundary link, three
shared spend ledgers and scheduled layout job commit in one database transaction.
It reuses the normal geometry writer and layout reservation implementation.
Stale proposals, incompatible connections, missing worker capabilities, budget
rejection or failed writes leave no partial area/link/reservation. The original
place definition and revision stay unchanged. The newly committed connection is
included in the planner's immutable input snapshot before any worker claim.

The job ID derives from the reviewed proposal ID. Its expansion provenance binds
that proposal and source place. Concurrent confirmation and lost acknowledgement
retries return the same saved job, including when the backend is offline or the
area was subsequently edited. Changed prompt/quote/source inputs conflict; replay
never restarts a cancelled, failed or ambiguous job. The worker only sees committed
scheduled work and retains the existing claim/recovery/cancellation rules.

During an uncertain response the UI locks the original request for explicit
**Retry saved expansion**. Reload does not submit anything: a successfully saved
area and job remain accessible through the connected-place selector and queue.
Unsaved form/preview state is not restored across a full page reload. Closing an
unsubmitted preview does not create an area. Paid layout failure leaves the saved
base/link and visible failed job, allowing ordinary manual edits or a separately
approved new layout attempt; it does not silently regenerate or delete the area.

This is explicit ground-boundary explore-to-layout, not automatic generation of
unknown neighbors, elevated portals, or a finished richly textured district.

## Generate Furnishings For A Saved Floor

Choose a floor under **Generation scope** in the place-layout panel, or select
that floor in the shared level control. Describe the furnishings, approve the
layout reservation, inspect the result and separately approve any proposed mesh
assets. Preview/apply stays on that saved floor, even if the editor selection
changed while generation was running. **Entire place** retains the existing
additions workflow.

The optional `target_floor: {building_id, floor_id}` is a constraint, not a prompt
hint. It is checked against the owned saved scene before reservation and is
retained in the idempotent request, durable job, provider input and generation
receipt. Every proposed object must be an allowed furnishing with that exact
placement. Additions to other floors, outdoor objects and new architecture are
rejected rather than relocated. All existing dimensions, openings, floor IDs and
objects remain unchanged. Floor-local bounds, ceiling, partition, doorway, stair
and circulation validation still apply. Mesh requests must target new reserved
volumes and use the existing explicit appearance approval.

Changing scope requires new consent. A lost-response retry retains its original
scope and request ID even if editor selection changes. Saved scene changes cancel
unsubmitted work with the usual one-time refund; submitted obsolete results
cannot be applied. Fork/export retain floor placement and receipt provenance,
not executable jobs. Reading a job or selecting a floor never submits generation.

The backend advertises `floor_target_version: 1`; all live layout workers must
advertise `layout_floor_targets: true`. Older backend/worker combinations retain
whole-place generation but cannot reserve scoped requests. Update both before
enabling this workflow. No new provider route, price or extra planner call.

This targets a whole saved floor, not a particular room within it. Room-specific
intent can be described, but is not yet an explicit room-ID constraint. The
workflow has desktop/mobile fixture verification, not fresh model-quality proof.

## Dependent Material Stage

An accepted layout may include up to 12 reusable material descriptions, with at
most 100 surface bindings. Object targets reference only new structured
buildings or paths (paths accept `floor` only). A ground target uses
`object_id: null, surface: "floor"` and is accepted only when the input place
has no objects and no saved ground material. The null target is not an object
ID and never creates geometry. Expanding an existing place cannot replace its
ground implicitly. Ground counts toward the same target and reservation limits.
Validation remaps symbolic object IDs after geometry acceptance, rejects
duplicate targets and validates tile size, rotation and roughness. Old
objects-only planner responses remain compatible.

The creator can inspect the proposed layout before spending on textures, without
committing it. While that exact proposal remains under review, material controls
remain available; unrelated draft edits disable new build work. The creator
reviews the descriptions and total reservation, then explicitly approves remaining
appearance through the combined workflow below. Existing independent material
batch routes remain compatible. A changed quote clears consent. A lost
acknowledgement retries the same frozen request, never a new batch.

`place_build_assets` stores the accepted layout/plan hashes, initial request and
quote, child job identities, replacement operations and reserved amounts. Its
creation, all child jobs and all spend reservations share one transaction.
A budget rejection rolls everything back, not only the last item. Children use
the existing independent material worker and retain the source place/revision,
source hash, parent build identity and accepted layout/plan hashes. Before a
paid claim, changed or missing dependencies cancel unsubmitted children and
release their reservations exactly once. Already submitted work may remain
billable; obsolete results still cannot apply.

Status reads assemble stage progress from durable child jobs. They never submit.
When all children are ready, a textured preview binds their owned immutable assets
to the saved accepted layout. The original layout result remains immutable, and
the normal scene preview/apply transaction commits the geometry and appearance
together. A missing material blocks this preview. **Preview layout only** is an
explicit alternative, never a silent downgrade when assets fail.

Each failed or explicitly discarded material can be replaced with a newly
approved reservation without rerunning the planner or successful siblings.
Unknown submissions must be explicitly discarded first; a status timeout does
not authorize replacement. Storage retry only re-fetches/re-stores the known
paid result. Whole-stage cancellation retains completed assets, cancels pending
items and refunds only children that have not been claimed. Saved assets and
their dependency provenance survive export/fork; executable stages and jobs are
not copied into forks. Complete world import/restore remains unfinished.

## Dependent Mesh Stage

The same planner response may propose up to six reusable mesh descriptions and
30 placements. Each target must be a new `volume` object: an explicitly authored
coarse solid box with dimensions, position, identity and optional floor binding.
It is not labelled a completed AI asset. Existing objects and structured buildings
cannot be mesh targets. `prop` requests may furnish a valid room; `exterior`
requests are outdoor-only solid objects, never inferred enterable architecture.

The creator reviews the mesh quote as part of the full appearance reservation. Its jobs
use the existing mesh worker and independent mesh cap while competing for the
same global/session budget as materials. The material stage retains its legacy
parent-build key; the mesh stage uses a `:mesh` suffix. Child dependencies always
reference the parent build, with an explicit asset kind. Older material records
without that kind remain compatible. Cancellation and individual replacement
operate within the chosen stage and do not affect siblings of the other kind.

Preview measures the owned GLB's actual bounds, fits it proportionally inside
each reserved envelope and substitutes only those volumes. IDs, placement,
heading and floor bindings survive; unrelated buildings and openings do not
change. Canonical geometry validation rejects incompatible dimensions or room
placement instead of stretching the asset. Both ready stages assemble into one
preview/apply transaction, with no generation call during assembly. Original
layout results remain immutable. Mesh manifests retain dependency provenance.

If either existing stage is blocked, combined preview is blocked; **Preview
layout only** explicitly excludes both stages. Selectively applying just one
stage while another is blocked is not yet supported. Saved meshes can receive
manual source-axis correction in the inspector. Automatic orientation inference,
multi-view input and automatic shell fitting/repair remain open. Single-image
mesh input and explicit compatible authored shell conversion are available
separately in the [mesh workflow](GENERATIVE_3D.md), not automatic layout stages.

## Combined Appearance Approval

After the layout is accepted by validation, the UI lists all proposed materials
and meshes and shows one exact total for unstarted stages. **Generate appearance**
requires explicit consent; **Generate remaining appearance** excludes an already
saved independent stage. Neither layout generation nor navigation approves asset
spending. Unavailable configuration disables the complete approval rather than
quietly submitting just the cheaper or available kind.

The approval freezes each required kind's model, parameters and per-asset
reservation, plus the quoted total. The server verifies that this is exactly the
remaining accepted plan, rechecks scene and connection dependencies, and validates
current provider/worker configuration. Every material and mesh child, both stage
records, the shared and kind-specific ledgers, and an approval receipt on the
parent layout job commit in one transaction. Over-budget or failed writes cannot
leave a funded material batch with an unfunded mesh batch. Existing independent
batch endpoints use the same stage-reservation helper and remain compatible.

The parent approval is durable evidence that these stages were already requested.
Retries match the original ID, kind set, quotes and total before checking live
provider availability. Missing stage records are conflicts, not a reason to
create new children. A changed request ID cannot bypass the saved approval.
Replacements retain the original approval and use the existing separately priced
single-item operations. No provider submission occurs in this transaction; the
independent worker claims committed children through the existing durable paths.

The appearance panel keeps per-item progress, storage refresh, discard,
replacement and per-stage cancellation. **Preview complete appearance** remains
disabled until every planned stage is ready; it combines both kinds through the
existing immutable assembly and geometry preview/apply. Missing stages after a
combined approval block assembly, including an earlier independent stage. An
explicit **Preview layout only** remains available; it is not the completed
appearance result. Cancelling a stage does not erase paid assets or authorize a
fresh batch automatically. Failed or unknown work is never silently resubmitted.

This joins the layout-to-materials/meshes workflow. It does not generate final
illustrations automatically, establish model quality or guarantee structural
adherence of unseen generated surfaces. The acceptance district and generality
tests still require fresh, separately authorized output and visual inspection.

## Saved Connection Constraints

New layout jobs freeze the canonical boundary links incident to their place.
`connection_input` contains a version, the local place ID, and sorted original
connection records with both endpoints, widths and identities. It is an immutable
planning input, not another writable connection authority. Other worlds and
unconnected areas are excluded. `connections_sha256` pins this input separately
from the existing scene-definition hash. Scene generation receipts retain both
the full frozen input and its hash through save, export and owner fork.

The model receives local boundary side/offset/width constraints and must connect
each opening to the saved entrance and proposed streets. Offsets are metres from
the place's west or north edge, not building-centred offsets. It may only propose
local object additions, not new links, changed endpoints or neighboring geometry.
The deterministic validator uses the same full-metre approach check as committed
connections, then verifies that every approach is reachable from the saved
entrance. An empty but isolated pocket behind a wall is not sufficient. This is
conservative outdoor routing, not a general navmesh or an elevated portal model.

Queueing connected work requires backend `connection_context_version: 1` and
`layout_connections: true` on every recent layout-worker heartbeat. Mixed old/new
workers or an old backend disable this paid path without creating a reservation.
Unconnected legacy jobs remain compatible; connected legacy jobs cannot acquire
an invented snapshot after consent. Roll out web, worker and backend together;
do not downgrade or replace workers while jobs are in flight.

Start, worker claim, result preview and dependent material/mesh reservation all
check that the source links still match. Scheduled jobs whose dependencies changed
are cancelled/refunded once before the paid claim. Child jobs pin the parent's
connection hash and recheck current links before submission too. Changed or missing
links cannot be silently rebased, even when the local scene revision stayed the
same. Known results remain available as historical job records, but the UI marks
connection-stale jobs and disables stale start/preview/asset generation. Already
claimed/submitted work can remain billable; no remote exactly-once guarantee is
implied. Recovery of known IDs and storage retry still never submits another job.

Preview/apply retains the existing full network alignment checks and world-change
conflict guards. Apply rechecks the frozen connection snapshot inside its database
transaction too, closing the race between a preview precheck and later world reads.
Replaying an already applied proposal still returns its saved revision without
revalidating it against new historical context or generating anything.
Local planning does not capture every neighboring scene revision
or map transform as a model input. Adjoining creation is explicitly requested
through the workflow above; other unknown neighbors remain unbuilt.
Illustrated-view orchestration and elevated/doorway links remain open.

## Configuration

The backend reuses the existing text-LLM provider/key/base-URL/model settings,
including configured compatible local providers. No new SDK is required. Verify
the selected model's availability, quality and pricing before enabling it.

- Backend: `PLACE_BUILD_ENABLED=1`, a configured text LLM and `SHARED_TOKEN`.
- Backend: `PLACE_BUILD_RESERVATION_USD` must be a verified positive amount, at
  most $10. Default zero disables generation.
- Web: `PLACE_BUILD_DAILY_CAP_USD`, default $1, plus existing optional daily global
  and per-session limits. Invalid caps reject new jobs.
- Web, worker and backend must agree on their shared-token configuration.
- An independent layout worker must have a recent database heartbeat before new
  reservations are accepted. An offline worker does not delete existing jobs.

For local development, from `apps/web`, after configuring the existing web
environment file:

```sh
node --env-file=.env.local --import tsx scripts/place-build-worker.ts
```

Alternatively export the environment explicitly and run `pnpm worker:places`.
The worker needs `MONGODB_URI`, `MONGODB_DB`, `MODAL_API_URL` and `SHARED_TOKEN`.
With the existing R2/Minio storage settings it also processes generated meshes
and materials in independent lanes; see [GENERATIVE_3D.md](GENERATIVE_3D.md)
and [GENERATED_MATERIALS.md](GENERATED_MATERIALS.md).
It must use the same database and backend as the web process. It does not load
environment files implicitly and does not need a running Next server.

For Docker, configure the root `.env`, including `NEXT_PUBLIC_WORLD_SCENES=1`,
the shared token and verified backend planner settings, then:

```sh
docker compose --profile world-build up --build
```

The optional `world-build` profile adds the independent `place-worker` service;
the default image-only stack does not start an unconfigured worker. The worker
image uses the workspace's existing `tsx` runtime, with no new dependencies.
The web's world-scene flag is passed at build time as well as runtime. Do not
change database/provider configuration while requests are in flight.

Reservations are allocations, not guaranteed provider invoice limits or quoted
current pricing. This implementation did not enable paid calls or change secrets.
The adapter makes one completion with 16,384 maximum output tokens. The shared
client disables SDK retries. No format-fallback or JSON-repair ladder runs here.

## Durable State

`place_build_jobs` retains the scoped request ID, prompt/model, reservation and
original ledger IDs, exact input definition/hash/revision, execution deadline,
execution token, submission marker, raw provider response, accepted output and
receipt. Queue insertion and spend reservation share one
transaction. Concurrent matching requests deduplicate; mismatched reuse rejects.

States: queued, scheduled, planning, validating, ready, invalid,
submission_unknown, cancelled. The owner-only Start request durably changes
queued to scheduled and returns without calling the planner. Workers claim
scheduled jobs transactionally, recheck source revision/hash and establish a
fenced execution token. A second atomic submission marker prevents even duplicate
holders of a claim from submitting twice. Expired or cancelled claims cannot start.
Reloads/status reads never submit. Reserved-but-unscheduled jobs require explicit
Start. Scheduled work resumes when a worker becomes available, without browser or
web-server involvement. Completed results load without models.

The worker saves the raw response before geometry validation. If that deterministic
step fails because storage is unavailable, another worker can finalize the saved
response after restart without calling the provider. Validation does not commit
the scene: the user still reviews and applies the result. Multiple workers may
finalize the same immutable response, but status/token checks fence final writes.

Cancellation while queued/scheduled refunds exactly once, as does detection of a
stale source before worker claim. Cancellation after claim or during validation
discards the result but may not stop provider billing, so spend stays reserved.
Late responses cannot overwrite cancellation. Transport ambiguity never retries.
Only an expired execution deadline exposes an interrupted state; a polling
timeout is not terminal evidence. A known late result may resolve ambiguity.

The worker handles SIGTERM by draining its in-flight layout, mesh and material operations;
Docker allows 360 seconds before force termination. SIGKILL or process death before storing a
response can still leave an ambiguous completion without a recoverable provider
handle. An expired planning deadline marks submission_unknown; no worker reclaims
it. Discarding an ambiguous result retains the reservation. Operator billing
reconciliation, provider-side LLM cancellation and derived-view dependencies remain
unfinished. This is not an exactly-once remote API guarantee.

## Geometry and Provenance

Server validation accepts additions only, applies the existing scene/architecture/
furnishing contracts, remints deterministic job-specific identities and preserves
floor/room bindings. It rejects new overlaps and unreachable external doorway
approaches, supplementing indoor circulation checks. Invalid output is rejected,
not repositioned into a canned layout. Conservative outdoor rectangles may reject
valid diagonal passages; they are not an exact arbitrary-mesh navmesh.
Saved local boundary links are now a frozen planning dependency, as described
above. Full network alignment validation still runs again at preview/apply.

Snapshots carry `generation_sources`: model/request ID, prompt, input hash/base
revision, generated object IDs, reserved amount and receipt time. This describes
origin, not exact equivalence after manual edits. Later revisions, export and fork
retain receipts. Clients cannot provide arbitrary receipt contents; forks copy
neither executable jobs nor spend reservations.

## Checks

From `apps/web`:

```sh
pnpm exec vitest run lib/place-build.test.ts lib/place-build-server.test.ts lib/place-scene-server.test.ts components/sketch/place-builder.test.tsx
E2E_PLACE_BUILD=1 pnpm exec playwright test e2e/place-build.spec.ts
```

Prefer the local Docker replica set for repeated isolated browser runs:

```sh
MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true' E2E_PLACE_BUILD=1 pnpm exec playwright test e2e/place-build.spec.ts
```

This overrides only the test process, not saved application configuration.
The harness uses a fresh randomly named database and a loopback provider. It
deletes its own documents afterward but may retain empty collection schemas;
repeated runs against quota-limited shared databases can exhaust collection
capacity. Do not delete existing databases to make a test pass.

The opt-in browser suite starts a loopback fake planner, independent worker
processes and an isolated Next process/database, without forwarding model calls
externally. It checks the real
UI and server routes, concurrent requests, in-flight reload, preview/edit/apply,
stale results, cancellation, ownership, export/fork receipts, worker completion
with Next stopped, graceful in-flight SIGTERM, competing workers and recovery
after a real SIGKILL,
screenshots and actual pixels at desktop/mobile widths. It cleans only its own
documents; empty test collection schemas may remain where dropping databases is
not permitted. For recovery testing, deadline expiry is accelerated in the
test-owned database and the pre-validation crash boundary is reconstructed from
an actually saved response. These fixtures establish product wiring, not model
quality; they do not claim an operating-system kill at the exact storage boundary.

Backend `tests/test_place_build.py` checks configuration, preserved input, one-call
behavior, receipts, truncation and no hidden retries. See the
[progress log](WORLD_BUILDING_PROGRESS.md) for exact runs and failures.
