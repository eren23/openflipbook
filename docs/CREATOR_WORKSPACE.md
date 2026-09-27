# Creator Workspace

Implemented locally September 9, 2026. This is the library and private-lore
milestone; it does not change model routing, generation defaults, or geometry.

## Product Surface

- `/` is My Worlds: saved artwork, titles, view counts, search, pinning,
  rename, archive/restore, and links to create or upload a world.
- Continue loads every page of the saved session graph, restores the selected
  node and its ancestry, and decodes its saved image before displaying it.
  Missing data or images produce a retryable error, not a fresh generation.
- Visiting a saved view records the resume node after its image loads.
- The world notebook is available from the library and the play toolbar.
  Place notes are available in the Place Inspector's Notes tab. Existing
  place-note entries also appear in the notebook.
- Notes use explicit Save. Failed saves retain the draft; concurrent edits
  return a conflict and require a choice between versions before overwriting.
  Closing, switching notes, and leaving the page warn about unsaved changes.
- Place notes use stable place IDs, not names. Renames update the displayed
  label; removing a place retains an editable notebook entry with its last
  saved label and a place-unavailable marker.

## Ownership And Privacy

Access uses the existing `ofb_owner` HTTP-only cookie and `session_owners`
records. There are no accounts, cross-device sync, or recovery mechanism in
this milestone. Clearing the cookie loses access from that browser; this is
not encrypted storage or protection from the server/database operator.

Creator reads never mint an owner cookie or claim an unowned legacy session.
The explicit identity POST establishes a browser cookie before source-free world
creation. Creation claims only a new UUID world, together with its content in one
transaction; it refuses to claim a pre-existing unowned legacy world.
Anonymous and foreign-owner note requests fail closed. The library queries
only sessions already owned by the current browser and does not return tokens.
Existing owned sessions need no backfill; worlds with saved scenes but no image
nodes now appear and resume in the World editor. Ownership records with neither
nodes nor scenes are omitted. Without configured persistence the library shows a recoverable
configuration state instead of pretending that storage succeeded.

Private data lives in separate Mongo collections:

| Collection | Key | Data |
| --- | --- | --- |
| `creator_worlds` | Session ID | Private title, pin/archive flags, resume node/place, last-opened time, creation receipt hash and source-free visibility |
| `creator_notes` | Session ID plus world/place ID | Plain text, saved label, revision, timestamp |

All creator API responses use `Cache-Control: private, no-store` and `Vary:
Cookie`. Writes require JSON and reject a mismatched browser Origin. Notes
are limited to 20,000 characters and rendered as text, never HTML. Revision
checks are atomic: a stale save returns HTTP 409 and cannot replace newer text.

World/map reads, reference reads, session reads, exports and forks consult
`creator_worlds.visibility` to enforce owner access for new source-free worlds.
Legacy image worlds retain their existing unlisted-link behavior. Forks of
private worlds retain private visibility and their library title, but do not
copy private notes or the original creation receipt. No private notes are
included in Codex state, generation inputs, exports or forks.
Library titles and archive flags do not rename or unpublish public worlds.
No private notes are passed to a model or added to application tracing.

### Atomic World Forks

World forks now read and copy their content in one Mongo snapshot transaction.
Geometry heads/history, connections, map/entity metadata, immutable mesh/material
bindings, permitted camera/illustration assets and the new owner's record commit
together. Failure leaves none of that copy visible. This requires the same Mongo
replica-set transaction support as structural editing; there is no non-atomic
fallback for standalone Mongo.

`POST /api/sessions/:id/fork` accepts `{node_id, request_id}`. A retained request ID
is scoped to the browser credential. Retrying it returns the same owned copy,
including after a server restart or subsequent edits to either world. Reusing
the ID for a different source returns 409. Older callers may omit the request ID
and receive a fresh copy per call, so those callers do not get retry deduplication.
The editor and share button establish the browser credential first and retain
their fork payload after failed responses. That in-memory UI retry draft does
not survive a browser reload; the committed copy remains in My Worlds, and the
server receipt remains durable. No jobs or spending reservations are copied.

Private source permissions are read in the same snapshot. Public-viewer forks
still omit private camera views and mesh concepts, and source-free forks remain
owner-only and private. Private notes, publication state and source ownership
tokens are never copied. Immutable file references are reused, not downloaded
again or regenerated. This is an atomic in-instance copy, not archive import,
backup/restore or recovery of deleted object-storage bytes.

### Snapshot Content Exports

`GET /api/export/session/:id` now reads authorization, page metadata, scene
heads/history, map/entity state, asset records, connections and camera/illustration
bindings in one Mongo snapshot transaction. Downloads of immutable files happen
after that transaction. A concurrent edit cannot change an exported camera's
accepted artwork or historical status halfway through the download.

Exports fail rather than return a truncated graph or omit missing page/reference
images. Limits are 500 nodes, 500 references, 5,000 records per scene/asset/artwork
collection, 32 MiB aggregate snapshot metadata, 200 MiB mesh content, 64 MiB each
for materials and saved camera content, and 384 MiB aggregate downloaded content.
These are buffered exports, not streaming archives; the limits are payload limits,
not a hard process-memory ceiling. Saved view/illustration, mesh and material
downloads verify stored byte lengths and hashes. Existing page/reference images
without stored hashes receive checksums of the exported bytes, not retrospective
proof of their original generation bytes.

Every ZIP has `manifest.json` with format `openflipbook-world-content`, version 1,
snapshot time, owner/shared scope, and SHA-256/length for every other file. The
manifest is an integrity inventory, not a signature. PNG/WebP page bytes retain
their file type. Node metadata retains model/prompt provenance, extraction time,
lineage, observer/transition information and saved clip URLs. Transition source
images are included among the immutable references.

Owner exports also include unused mesh/material assets, exact current scene
heads, the full tombstone-bearing `entity-registry.json`, and a whitelisted
`workspace.json` with the saved resume/walk position. Shared exports do not gain
private views, concepts, registry tombstones, workspace state or unused assets.
No ownership credentials, notes, active jobs or spending reservations are bundled.

### Private Content Import

My Worlds now offers **Import World** for complete owner-snapshot ZIPs. Inspection
validates the archive inventory, original asset bytes and supported dependencies
before showing a preview. Explicit confirmation creates a new private world;
inspection alone creates neither world content nor ownership. Node IDs and storage
keys are remapped, while place/object identities, scene history and camera bindings
are retained. Owner view exports include exact `capture_metadata`, including the
request fingerprint needed to preserve illustration dependencies, not credentials.

Apply stages assets and reads them back to verify length and SHA-256 before one
transaction publishes content, ownership and the durable retry receipt. Retrying
the same request after a lost response returns the same world. Browser reload can
recover a pending preview but never automatically applies it. No generation jobs
or spending reservations are imported or resubmitted.

Owner manifests advertise `content_import_version: 1`, but still set
`restore_supported: false`: this is **not full backup/operator recovery**. Imports
reject incomplete/shared archives, external arrival clips or entity reference
images, legacy material atlases and saved views lacking exact capture metadata.
Unbound concept drafts, notes and ownership credentials are not bundled. Staged
ZIPs and orphaned uploads currently have no automatic cleanup. The 384 MiB payload
limit is not a hard process-memory ceiling. Checksums establish integrity, not
trusted provenance or fresh generation quality.

Import checks map repaint source-page lineage, accepted-head history, exact
registration continuity and the saved geometry baseline before remapping IDs.
Conflicting page bytes under one original storage key are rejected. Tests cover
map projection and repaint preparation after a two-floor/material/connected-world
ZIP round trip. Desktop/mobile browser tests also restore an upstairs walking
position, descend the imported flight and exit, and cross an imported adjoining
boundary in both directions after restarting Next. Mesh/material bytes remain
identical and no new provider submissions occur. These are fixture-backed
restoration checks, not fresh generative quality or clean-host acceptance.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/creator/worlds` | Owner-scoped list; `q`, `archived`, `cursor`; 20 results/page |
| POST | `/api/creator/identity` | Establish browser credential before creation; does not create or claim a world |
| POST | `/api/creator/imports?request_id=...` | Inspect and stage an owner content ZIP; `application/zip`; no world publication |
| GET | `/api/creator/imports/:id` | Recover the browser-scoped import preview or applied receipt |
| POST | `/api/creator/imports/:id` | Explicitly apply `{action: "apply", sha256}`; atomic private publication, idempotent retry |
| POST | `/api/creator/worlds` | Atomically create a source-free world; `{request_id, definition}`; same-request replay returns saved content |
| GET | `/api/creator/worlds/:id` | Verify existing ownership without claiming |
| PATCH | `/api/creator/worlds/:id` | Update private library metadata; validate resume node or place belongs to session |
| GET | `/api/creator/worlds/:id/notes` | Read private world/place notes, including orphan entries |
| PUT | `/api/creator/worlds/:id/notes` | Save `{place_id, text, revision}`; null place ID means world note |

## Verification

### Registered Illustration Workspace

The scene editor at `/sketch/world` has an Illustration view beside Plan, 3D,
Plan + 3D and Walk. The camera library's **Open illustration** action opens the
selected saved view there. This is separate from **Reference**, which displays
imported artwork without claiming registered geometry.

The main surface fits the exact saved image aspect ratio, without cropping.
The inspector retains camera history, generation consent, comparison, brush and
eraser controls, and protected-preview/accept actions. With no artwork selected,
the main surface explicitly displays the saved source render. Historical camera
bindings stay labelled historical; browsing does not generate or accept content.

Object selection uses the saved semantic mask, not image recognition. Existing
objects in the current place share selection with the plan, 3D and inspector.
Connected-chunk objects outside the current place are not promoted into the
local inspector; use the place selector to edit those. Brush selection can span
visible saved object identities independently of the inspector's single object.

Switching workspace modes preserves the current illustration request, prompt,
brush tool, radius and strokes. Unresolved generation/composite requests disable
camera switching and new captures until their retained request is resolved.
The selected saved camera and Illustration mode are kept in the URL for reload;
unsent brush/prompt drafts are not durable across reload or a place change.

Same-camera geometry refresh also works from Illustration. It creates a temporary
offscreen renderer only on the explicit refresh action, then releases its GPU
context on success or failure. The scene viewport is unmounted while Illustration
is open. This does not add paid generation or make image edits into 3D materials.

This view is covered by the isolated `e2e/place-build.spec.ts` workflow, separate
from the library/private-notes suite described below. Fake-provider browser
coverage establishes UI, registration and recovery behavior, not visual quality
of fresh model output.

```sh
pnpm --filter @openflipbook/web typecheck
pnpm --filter @openflipbook/web test:coverage
```

The browser suite is deliberately opt-in and localhost-only. It uses the
existing local development stack: Mongo at `127.0.0.1:27017`, database
`openflipbook_healthcheck`, and MinIO at `127.0.0.1:9000` with the local
development credentials. The web server must use that same database and
MinIO bucket (`openflipbook`), with world mode enabled. It creates uniquely
named fixtures and removes only those fixtures afterward.

Run from `apps/web`, with the local server already running:

```sh
E2E_CREATOR=1 E2E_BASE_URL=http://127.0.0.1:3002 pnpm exec playwright test e2e/creator-workspace.spec.ts
```

Checks include desktop/mobile library actions, explicit note saves and draft
guards, two-tab conflict resolution, pagination beyond 200 saved nodes,
reload and failed-resume recovery, owner isolation, legacy non-claiming,
orphan retention, and private-data exclusion from public/export/fork routes.
Browser model-call routes are blocked, and resume tests assert none were
requested. The suite uses existing fixture artwork and no paid generation.
