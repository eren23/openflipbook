# OpenFlipbook Sketch

Native draw-to-create and draw-to-correct workspace at `/sketch`. Entry points are
My Worlds > New Sketch and the current world's Draw to Edit action.

## Shipped In This Working Tree

- Excalidraw 0.18.0, lazy-loaded only in Sketch: shapes, arrows, text, freehand,
  undo/redo, imported images, and a fixed artwork frame.
- Blank-image creation and corrections of uploaded images or owned world nodes.
- Separate instruction drawing and editable-region layers. Rectangle, ellipse,
  and brush regions; whole-image editing is an explicit scope choice.
- Autosaved owner-scoped drafts, conflict detection, a saved-draft library,
  generation history, original/result slider, explicit Keep, and Discard.
- Keep creates a new immutable world node. It does not overwrite the source or
  silently promote the result to a place-identity reference.
- Portable `.excalidraw` scenes, `.ofb-sketch` bundles, and PNG exports.
  A bundle preserves the clean source separately from the drawing and mask.
- Optional style image, with independent model selection for Flare, Sunburst,
  and Nano Banana Pro through fal.
- Workflow menu: finished object/environment/artwork, material variations,
  reference-object placement, and alternate-view proposals. Presets are stored
  separately from the user's written instructions.

## Image Workflows

Finish / correct preserves the existing behavior by default. Blank drawings can
target an object, environment, or artwork. Material variation offers ceramic,
metal, fabric, wood, glass, or custom instructions. Its prompt requests the same
silhouette, proportions, placement, and camera; those semantic properties are
not a deterministic guarantee. Kept candidates can become a new draft's source
through Edit this version.

Object placement requires an imported scene or owned world source, a separate
object-reference image, and selected-area scope. The references are clean scene,
annotated scene, object, and optional style, in that order. The object reference's
background is not the target scene. Contact shadows must fit inside the selected
region: the compositor will not modify surrounding pixels to accommodate them.

Alternate view requires an existing source and explicit whole-image scope.
Eye-level, overhead, front, and three-quarter are prompt-guided proposals, not
calibrated camera controls. The renderer deliberately permits a camera change;
the preview is labeled "Proposed view / Geometry unverified", including after
reload. Keep retains the source's world/parent relationship for owned nodes,
but does not populate scene_view, promote canonical identity, or update geometry.
Camera-evidence conditioning and landmark verification remain follow-up work.

Workflow settings and both reference roles survive save, bundles, restore, and
version receipts. Incomplete drafts are allowed, but invalid workflow requests
are rejected before model submission. No mesh endpoint or dependency was added.
The new workflows have mocked integration/browser coverage; their visual quality
has not yet been live-evaluated. The earlier live correction receipts below do
not establish material, placement, or alternate-view quality.

## Run

Keep the existing MongoDB, owner-cookie, and R2 configuration. MongoDB must
support transactions (replica set or Atlas). The image backend needs `FAL_KEY`.

```sh
# apps/modal-backend
PORT=8003 SKETCH_ENABLED=1 MOCK_PROVIDERS=0 .venv/bin/python local_server.py

# apps/web
MODAL_API_URL=http://127.0.0.1:8003 NEXT_PUBLIC_SKETCH_ENABLED=1 pnpm exec next dev --hostname 127.0.0.1 --port 3003
```

Development enables the frontend unless `NEXT_PUBLIC_SKETCH_ENABLED=0`.
Production requires `NEXT_PUBLIC_SKETCH_ENABLED=1` at build time and runtime.
The backend always requires `SKETCH_ENABLED=1`. Existing non-Sketch generation
does not use this new render path. Nothing has been deployed or merged.

Docker Compose now forwards `NEXT_PUBLIC_SKETCH_ENABLED` as a web build argument.
Set it and `SKETCH_ENABLED=1` in the root `.env`, then rebuild web and restart the
backend. For an isolated production check with no provider keys, follow
[Local Development And Self-Hosting](LOCAL_DEV.md#isolated-production-check).
That check covers drawing, saving, mock generation, acceptance and reopening;
mock candidates do not establish image-model quality.

## Contracts And Guarantees

`sketches` stores source ownership, a monotonic revision, and the editable scene.
`sketch_runs` freezes each generation's complete draft and input assets. The
browser sends a draft ID/revision plus rendered instructions/mask to the existing
`/api/generate-page`; only the server constructs `sketch_input` for Modal.
Caller-supplied raw `sketch_input` is rejected by the web endpoint.

For corrections, the backend receives the clean original first, instruction
image second, optional placement object third, and optional style reference last. It validates dimensions and
nonempty masks before any provider submission. It pads/resizes references to
supported model dimensions, then maps the result back to the source frame.

Selected-area edits are composited against the original at full resolution.
White mask pixels with luminance >= 128 are editable; all other RGBA pixels
come from the original, exactly. The PNG is checked for zero changed pixels
outside the selected area. This guarantees pixel protection, **not** semantic
correctness, perfect boundaries, 3D consistency, or successful edits inside it.
Whole-image edits and blank creation deliberately make no protection claim.

Generation has one render attempt. A durable request ID prevents duplicate
submission; the browser retains it across a lost response/reload in the same
tab. Candidate acceptance is transactional and idempotent. Restoring a drawing
increments its revision rather than rolling the counter backward. A discarded
candidate retains its request receipt, so replay cannot silently rebill it.

Requests reserve $0.30 against existing daily/session spend limits before
submission. This is an estimate-based guard, **not an invoice or guaranteed
provider-price ceiling**. Failed requests retain their receipts; no automatic
paid retry occurs. Mock outputs are labeled as such.

Draft APIs enforce ownership and use private/no-store responses. Asset files use
the existing unlisted R2 storage, not encrypted private storage. Sharing an asset
URL exposes that file. Deleting a draft does not delete kept nodes or immediately
garbage-collect its assets. Do not use this for confidential drawings without a
private-storage deployment policy.

## Live Trial Receipt: 2026-09-10

These are small samples, not a model leaderboard. Seven paid submissions were
made, with $2.10 of conservative per-call estimates against the approved $4
trial budget. Exact invoiced cost was not available from the returned responses.

| Trial | Time | Observation |
| --- | ---: | --- |
| Flare, create | 39 s | Lighthouse left, harbor right, tavern above; finished image, no guide strokes |
| Nano Pro, create | 245 s | Correct relative layout; illustrative result; substantially slower in this sample |
| Flare, corrected mask | 40 s | Cyan lighthouse crystal changed to ruby red; outside changed = 0 |
| Sunburst, corrected mask | 60 s | Same requested correction; outside changed = 0 |
| Flare, native UI | see receipt | Real browser region -> generate -> Keep -> reload; outside changed = 0 |
| Two initial correction trials | 39 / 55 s | Invalid experiment: the harness mask missed the crystal; retained, not counted as quality wins |

All guides, masks, outputs, prompts, and receipts are under
[`research/assets/sketch-trials`](research/assets/sketch-trials).
The native UI replay explicitly blocks generation and recorded zero attempts.
The Desktop film `openflipbook-sketch-proof-2026-09-10.mp4` is a 15-second cut of
the actual native recording and saved-result replay, with the generation wait
removed. It is a functional proof, not a claim of 15-second model latency.

The live scripts are opt-in and refuse to overwrite a completed trial receipt:

```sh
# apps/modal-backend: one paid call
.venv/bin/python -m tests.sketch_trial --live --model openai/gpt-image-2.5/flare/edit --case correct --output /tmp/new-sketch-trial

# apps/web: one paid native demo, or free replay of its saved result
SKETCH_LIVE_DEMO=1 node scripts/record-sketch-demo.mjs
node scripts/replay-sketch-demo.mjs
```

The replay's local owner state stays in ignored `test-results`, never in a
committed artifact. Existing receipt directories intentionally prevent reruns.

## Verification And Remaining Work

Web typecheck, production build, full unit suite and coverage floors pass.
The backend suite and 87% coverage floor pass (88.29% measured). Browser tests
cover desktop/mobile drawing, exports, save/reload, ownership, revision conflicts,
protected corrections, stale acceptance, restore, discard, and idempotent Keep.
Free E2E tests require both `E2E_SKETCH=1` and `E2E_MOCK=1` and must point to a
separate localhost backend running `MOCK_PROVIDERS=1`.

Before broad rollout: durable background jobs/cancellation and crash recovery,
asset retention/garbage collection, wider multi-image and style-reference evals,
and an honest public demo of more than one edit. Current model execution is a
bounded request, not a durable queue. Imported scenes are compatible with
Excalidraw-based frontends; there is no direct Spiderchat connector yet.
