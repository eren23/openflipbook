# Place Identity

## Available Controls

World Mode's Place Inspector lists mapped places, their saved views, editable
names and appearances, and identity locks. A saved session image can be selected
and cropped as a canonical reference. Enter reuses a matching saved view;
New view opens the camera picker and deliberately bypasses that reuse.
Overlapping places get a chooser instead of an arbitrary winner.

Reference metadata stores an immutable image key, node ID, and normalized crop.
Recropping does not silently swap in a later node revision. Owner-checked PATCH
writes update linked Codex and geometry metadata in one Mongo transaction.
Concurrent edits return 409. Mongo must support transactions (a replica set,
including the existing single-member Compose setup, or Atlas).

Locks protect curated names and appearances from extraction. Re-import preserves
identity metadata. Fork remaps reference node IDs while retaining original image
keys; world ZIP exports include reference bytes and `references.json` separately
from potentially edited page images. No database migration is required.

## Experimental Verification

**Default OFF. Not ready for promotion.** To test locally, enable
`WORLD_IDENTITY_STRICT=true` on both web server and backend, and build the web
with `NEXT_PUBLIC_WORLD_IDENTITY_STRICT=true`. World Mode must also be on.
Compose passes these flags explicitly. A strict client talking to a flag-off
server gets an error, not an unverified fallback. Rebuild the web with the public
flag false to roll back; disabling only the server intentionally fails closed.

The server resolves the target, source bytes, canonical reference and spatial
context from that session. Client-supplied reference bytes are discarded.
Every applicable judge must return a finite passing score on the final bytes:
identity (or interior identity), medium, camera, detail, zoom direction, and
spatial grounding when layout is known. OUTWARD adds source-containment judging.
No corrective image edit happens after acceptance.

Failed or unavailable judges produce an unpublished candidate with Retry and
Dismiss. They do not replace the map, save a node, reparent an OUTWARD root, or
start extraction. Strict requests make at most two image submissions, including
provider transport retries, and honor smaller caller limits. Reservations count
failed submissions and enforce existing estimated session/day caps before each
submission. These are process-local estimates, not an invoice or distributed
billing ledger. Deadlines bound provider and judge waits.

Thresholds: `WORLD_IDENTITY_ACCEPT_PLACE`, `WORLD_IDENTITY_ACCEPT_MEDIUM`, and
`WORLD_IDENTITY_ACCEPT_CONFORMANCE` default to 7. Detail uses existing
`VIEW_LOOP_ACCEPT_DETAIL` / `TAP_ZOOM_DETAIL_ACCEPT`; interiors use
`INTERIOR_ACCEPT`. Invalid thresholds fall back to finite defaults.

## Verification

Free tests: `pnpm --filter @openflipbook/web test:coverage` and, from the backend,
`.venv/bin/python -m pytest --cov=providers --cov=generate`.
The local-only `apps/web/scripts/seed-place-inspector.mjs` creates an isolated
two-page world in `openflipbook_healthcheck`, with three places and a deliberate
overlap. It requires the local Mongo/Minio services and never targets production.

The bounded [visual pilot](research/11-place-identity-pilot.md) is not a quality
graduation. OUTWARD pixel preservation remains off; issue #252 is still open.
