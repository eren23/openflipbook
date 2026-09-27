# Exterior Arrivals

Status: implemented locally behind existing strict-world flags. The first
[live pilot](research/16-automatic-arrival-pilot.md) produced 12 fresh candidates
and no complete quality passes. No production default change, deployment or
merge is implied.

## Behavior

A normal strict-mode place-scene click from a map requests an exterior arrival:
near the selected structure, outside, at human eye height. It must preserve the
recognizable structure, not invent a doorway or silently turn the request into
an interior. Explicit interior requests remain separate. Ambiguous places still
use the existing chooser; matching saved views still replay without generation.

The server selects references in this order: curated immutable crop, valid
first-seen appearance, valid image-local appearance, then footprint projection
only from a known map camera. An uploaded root with unknown camera needs an
image-local reference, not a guessed projection. Curating is an optional override,
not a prerequisite when automatic extraction supplies a valid reference.
Reference provenance records the source node, selection method and image hash;
backend logs also record the actual crop hash, policy and candidate request ID.
Client-supplied reference bytes and provenance are not trusted.

Every final candidate passes the existing identity, style, camera, detail and
applicable spatial judges plus four categorical arrival checks:

- `near_target`: the selected structure is nearby and inspectable.
- `exterior`: the camera is outside.
- `single_target`: no duplicate instance or facade.
- `scene_not_map`: no aerial map backdrop or inset.

Each check returns `pass`, `fail` or `unknown`. All must pass. Missing, malformed,
truncated or unavailable evidence cannot pass. A bounded retry receives the
failed axes; no edit happens after judging. Rejection retains the source and
offers a separate unpublished candidate with Retry/Dismiss. Client acceptance
and node persistence also reject failed arrival receipts. Historical receipts
without arrival checks remain replayable, not retroactively quality-certified.

## Configuration

Enable World Mode and the existing `WORLD_IDENTITY_STRICT=true` on web/backend
and `NEXT_PUBLIC_WORLD_IDENTITY_STRICT=true` in the web build. Defaults remain off.
`arrival_intent` is optional and accepts only `exterior` or `interior`; it is
ignored for non-strict generation and only affects place-scene rendering.

Backend-only `WORLD_ARRIVAL_REFERENCE_MODE` selects `context_first` (default) or
`target_first` for exterior arrivals. Context-first sends the world then the
canonical crop; target-first sends the crop then the world as context. Prompt
image roles follow that ordering. Unsupported reference models or invalid
policies fail before image submission. Other rendering modes retain their order.

`WORLD_ARRIVAL_PHYSICAL_REFERENCE=true` adds an experimental preflight, off by
default. Before planning/rendering, automatically selected references are
relocated against the full original image to include the physical structure,
not just its printed label. A separate inspection sees the exact proposed crop
and checks target association, physical content, whole-structure coverage and
single-target identity. All four must explicitly pass. Curated crops are checked
but never relocated. Missing evidence, errors and a 60-second timeout stop the
request before image generation; the saved reference and world remain unchanged.
The runtime crop is request-local, not written back as a new identity anchor.
Logs retain original/effective boxes, source/crop hashes and inspection receipts.
Automatic references add up to two logical vision calls; curated references add
one. Transport retries and model fallibility still apply outside the pilot meter.

Explicit exterior arrivals enforce an eye-level camera contract on both servers;
a client aerial hint cannot weaken the instruction or camera judge. This is a
contract, not a recovered camera pose or proof that a generated image obeys it.
The Nano Banana edit paths now forward the requested aspect ratio instead of
implicitly using `auto`, as supported by the [Pro edit schema](https://fal.ai/models/fal-ai/nano-banana-pro/edit/api)
and [standard edit schema](https://fal.ai/models/fal-ai/nano-banana/edit/api).
Other model families retain their existing framing behavior. No visual improvement
is claimed until fresh output passes review.

## No-Spend Audit

From `apps/modal-backend`:

```sh
.venv/bin/python -m tests.continuity_bench.arrival_audit --prepare
```

This only writes an ignored local manifest and review crops. It imports no
provider and makes no network calls. Existing submitted trials/receipts/ledgers
cannot be overwritten by preparation. Start the web with `SPATIAL_STUDY=1` and
open `/dev/arrivals`; the viewer and allowlisted asset route are unavailable in
production. It is read-only and has no generation control.

Three real maps, two reference policies and two runs produce 12 planned cells.
Source/code hashes, click positions and human review features are frozen in the
manifest. Human boxes are evaluation annotations, never injected as automatic
runtime references. Preparation starts with no candidates or human verdicts and
zero approved/reserved spend. The existing local report now contains the approved
live batch; preparation must not overwrite its submitted artifacts.

The opt-in `tests.continuity_bench.arrival_live` adapter and web script
`scripts/run-arrival-pilot.mjs` ran the approved batch through the real handlers,
with durable per-call reservations. Before any additional batch, quote
extraction, resolution, planning, images, judges and failures;
obtain explicit approval, use a durable reservation ledger, and record actual
automatically extracted metadata and provider receipts. Do not resubmit an
ambiguous request. Require full judge receipts and human review on both runs of
all cases before proposing a canary. This is a pilot, not a reliability estimate.

## Verification And Limits

Backend tests cover reference order, exterior planning, unknown evidence,
retry feedback/final-byte judging and offline artifact preservation. Web tests
cover server reference selection, authorization, acceptance/persistence guards
and study states. The opt-in `e2e/arrival.spec.ts` uses isolated local Mongo/Minio
fixtures and mocked generation to exercise rejection, retry, saving, return,
reload, zero-submission revisit and ambiguous clicks at desktop/mobile sizes.
Its mock images prove workflow behavior, not arrival quality.

The [reference-only follow-up](research/17-physical-reference-check.md) has now
run: six vision calls, $0.01254, no image/video generation. It improved the
lighthouse crops but exposed a citadel false positive in the coverage verifier.
The preflight remains experimental and off by default. Its offline input
preparation can be inspected with:

```sh
.venv/bin/python -m tests.continuity_bench.arrival_reference_pilot
```

Default execution is offline and verifies source hashes against the original
automatic request receipts; human review annotations are excluded. The proposed
live check was three sources, at most six vision calls, a separate $1 hard cap,
and no image/video generation. Live execution requires explicit approval followed by
`ARRIVAL_REFERENCE_PILOT=1` and `--run`. Its separate ledger cannot replay an
already-submitted run, and all calls reserve funds before submission. Old arrival
results are not overwritten or retroactively promoted.

The [one-image destination component experiment](research/18-crystal-ground-arrival.md)
has run and was rejected: duplicated split-screen output and camera 4/10.
Framing passed, but identity scoring remained too permissive. Total spend was
$0.15654 accounted/reserved. Its offline preparation is inspected with:

```sh
.venv/bin/python -m tests.continuity_bench.arrival_destination_pilot
```

It reuses the hash-verified Crystal Lighthouse physical crop, sends it first with
the original map as context, and requests one 1K 16:9 standing-height exterior.
The fixed prompt avoids the shared enter builder's input-aspect preservation
clause, which conflicts with this portrait reference crop. This prompt change
is experimental, not a production prompt fix or a reconstructed camera pose.
Five existing judges inspect the final bytes; a separate dimension check verifies
landscape framing. There is no extraction, planner, automatic publication, video
or image reroll. The separate $1 cap requires approval and
`ARRIVAL_DESTINATION_PILOT=1 ... --run`; preparation itself is offline. This is a
component experiment, not a normal-click end-to-end success or an isolated
reference-order ablation. Its submitted ledger must not be replayed for a new
image; the original output and receipts remain unchanged.

The [lighthouse control study](research/19-lighthouse-control-pilot.md) tested
eight images using color/clay Three.js camera guides and Qwen's native angle
adapter. Three of four guided images passed the camera judge but all four lost
architecture; Qwen kept more visible architecture but stayed overhead in all
four. No complete passes, $1.46125 accounted/reserved under a separate $4 cap.
The authored guide itself simplified the source's arcade and faceted base;
correcting that input is the next no-cost step, not another identical reroll.
The pilot-only architectural gate rejected the two guided outputs accepted by
the existing verifier. It is not calibrated or installed as a production judge.
The new study at `/dev/spatial-transitions/lighthouse` is offline, gated and
unavailable in production. Its color/clay/depth exports and camera checks prove
rendering and authored camera placement, not recovered geometry or faithful
architecture. All trial receipts remain separate from saved app views.

The separate [persistent v2 prototype](research/20-persistent-lighthouse.md) now
models the arched annex and tiered base and supports a fixed exterior route,
exact same-browser return and paused-state reload. It is available at
`/dev/spatial-transitions/lighthouse-v2` under the same development-only gate.
No paid generation or normal map-click integration was added. Its architecture
and appearance still need review; it does not supersede the failed paid results.

This does not recover 3D geometry, establish unseen entrance/interior topology,
or improve AI video motion. Keep source-pixel approaches and explicit cuts until
the destination and any claimed continuous movement earn separate visual passes.
