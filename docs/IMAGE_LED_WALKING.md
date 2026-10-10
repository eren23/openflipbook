# Image-led walking

The source map and reviewed street artwork define the appearance of an illustrated walk. A saved 3D scene remains available for physical movement, but its estimated doors, windows and roofs do not become constraints for this profile.

`image-led-v1` is a separate route and generation contract. Its checkpoints are normalized locations on the owned source image, not recovered metric cameras. Landmark identities retain stable world entity IDs and complete source crops. Their source-image locations and the resulting viewpoint are explicitly approximate until a separate registration is reviewed. Generated artwork never edits the canonical world geometry.

The first still uses the original map, recognizable landmark references and the route's relative placement. A later still puts the exact previous accepted artwork first, while retaining the original map and landmark references. This prevents a discarded or historical draft from silently becoming the next view. No proxy render, depth pass, shuffled texture atlas or estimated opening mask is part of this profile.

Each paid operation requires a current quote and a durable claim. Source and reference changes invalidate eligibility before submission. An ambiguous submission stays ambiguous; a retry retrieves the same known provider request or stored result instead of making another image. Originals are stored without replacing their bytes. Playback images are declared derivatives.

Review has separate purposes:

- **Identity:** the same architectural features, building families, signs, hearths and materials remain recognizable.
- **Route:** perspective and near/far or left/right relationships plausibly follow the selected route.
- **Spatial registration:** a map point is an estimate unless there is independent calibration. An identity pass cannot establish calibration.
- **Temporal continuity:** doors, windows and other features retain their ordering throughout a clip. They may become occluded, but must not relocate or transform into other openings.

Only reviewed adjacent stills can supply a clip. Endpoint similarity alone cannot accept the film. Missing, rejected or changed anchors stop that segment. Existing `accepted-only-v1` and `accepted-route-v1` geometry-bound policies retain their original validation.

Content exports include route, source, original media and review evidence. Imported records remain inert historical content, without leases, provider request credentials or permission to submit jobs. Operator backups continue to preserve complete job and spending history.

Implementation checks establish wiring, provenance and durability. They do not establish visual quality. The visible acceptance study remains three consistent street views, followed by six map-linked checkpoints, with intermediate clip inspection and forward/reverse playback. Generic facades with a perfect proxy mask and the historical clip whose Bookshop door swaps sides are negative examples.

## Backend configuration

The independent backend transport is `/image-led-walk/capabilities`,
`POST /image-led-walk/generate`, and `GET /image-led-walk/requests/{request_id}`.
It requires `FAL_KEY`, `SHARED_TOKEN`, `IMAGE_LED_WALK_ENABLED=1`, and an explicit
reservation for the selected model from 0.15 to 10. Defaults disable generation;
`MOCK_PROVIDERS` also disables submission and provider reads. The reservation is
an operator-set ceiling returned by current capability checks, not live provider
pricing or an invoice. Verify current pricing before enabling. `IMAGE_LED_WALK_MODEL`
defaults to `fal-ai/nano-banana-pro/edit`, whose legacy
`IMAGE_LED_WALK_RESERVATION_USD` requests one 1K PNG, 16:9, seed 42,
safety tolerance 4, no web search, no synchronous mode and no extra generations.

The operator can select only the following additional fixed profiles. Each has a
separate reservation variable defaulting to zero; changing the model alone cannot
reuse the NanoPro ceiling. New quotes and workers require `image-led-walk-v4` /
`image_led_walk_v4`; the provider workflow profile remains `image-led-v1`.

| Model | Explicit reservation variable | Fixed output and input constraints |
| --- | --- | --- |
| [Sunburst](https://fal.ai/models/openai/gpt-image-2.5/sunburst/edit/api) `openai/gpt-image-2.5/sunburst/edit` | `IMAGE_LED_WALK_SUNBURST_RESERVATION_USD` | One opaque 1536×864 PNG, quality high, up to 16 references; optional PNG repair mask. |
| [FLUX 3](https://fal.ai/models/blackforestlabs/flux-3/edit-image/api) `blackforestlabs/flux-3/edit-image` | `IMAGE_LED_WALK_FLUX3_RESERVATION_USD` | One PNG, 16:9, resolution `1k`, prompt expansion disabled, integer safety tolerance 4; up to 10 references, each at least 256 pixels per dimension and at most 4 million pixels. |
| [Seedream 5 Pro](https://fal.ai/models/bytedance/seedream/v5/pro/edit/api) `bytedance/seedream/v5/pro/edit` | `IMAGE_LED_WALK_SEEDREAM5_RESERVATION_USD` | One 1536×864 PNG, safety checker enabled, standard prompt enhancement; up to 10 references. Overflow is rejected rather than allowing the provider to keep only the last 10. |

Provider parameters are fixed and model-specific. Arbitrary endpoints, extra
parameters, invalid reference dimensions and overflow fail before uploads or a
paid claim. Ordered references are the optional unapproved repair target, the
immediately preceding reviewed image, the original map, then named source crops.
Sunburst alone accepts a separate hash-bound PNG mask matching the repair target.
These masks are image-plane pixel-edit regions, not calibrated physical openings,
depth or derived 3D masks. Web repair preparation requires an owned saved original
receipt for the exact source, source binding, full route and checkpoint. Repair
targets and masks join the immutable quote fingerprint without granting approval.
The ordinary route UI does not provide a mask editor.

An unsent old quote must be refreshed after a model change. Already submitted
jobs recover through `GET /image-led-walk/requests/{request_id}?model=...` using
their immutable quoted model, with no new POST. Legacy status requests omitting
the model still use NanoPro even after the operator selects another profile.

The web must authorize source ownership, derive whole-building crops, confirm
the exact quote and durably claim the job before this internal transport is
called. Backend validation requires private PNG/JPEG bytes matching every
descriptor hash, dimensions and byte count. It checks 1–8 unique architectural
references, 2–12 route points in the original image frame and the preceding
reviewed image for later checkpoints. The original illustration is explicitly
oblique or of unknown projection. Neither image coordinates nor generated media
establish metres, cardinal direction or camera calibration.

The backend performs one queue POST without redirects, transport retries or
provider retries. Known request status/result reads remain available after new
generation is disabled. Original output dimensions and hashes come from decoded
bytes; the output is retained without normalization and remains unaccepted,
spatially unmeasured and subject to independent owner review. No SAM call or
automatic visual acceptance is part of this profile.

Image-led clips have separate `/image-led-walk/video/capabilities`,
`POST /image-led-walk/video/generate` and `GET /image-led-walk/video/requests/{request_id}`
endpoints. They use the existing motion enablement and operator reservation rate
in addition to `IMAGE_LED_WALK_ENABLED`. A quote covers one five-second 768P H3
first/last-frame leg: $0.40 at an operator rate of $0.08 per second. This is not
a live invoice. The web must pin reviewed adjacent endpoints, the source artwork,
architectural references and prior temporal reviews before claiming the job.
The video transport uses exact endpoint images and source-led architectural text;
it accepts no estimated translation distance or proxy camera trajectory. Audio
is unverified until the storage worker inspects it. Completed clips remain drafts
until temporal review; endpoint review cannot certify intermediate frames.

## Local implementation verification — 2026-10-05

The image-led API, quoted execution worker, source-map UI, and version-5 export,
import and owner-fork integration are implemented. Generation uses the source
image, whole-building references, normalized drawn route and reviewed previous
painting. It does not use a proxy render as architectural authority. Spatial
registration remains explicitly unmeasured. Owner review is separate from media
storage and from generic geometric checks.

Verification passed: 239 relevant web tests (including worker shutdown, existing
motion/path archive compatibility, owner forks and source-switch/modal layering
regressions), 495 related backend tests, full TypeScript checking, scoped ESLint,
and an isolated production build. Desktop/mobile fixture checks use actual
components but mocked transport and are identified as fixtures.

The actual private local world also passes authenticated source/B07 byte checks,
free route creation, exact UUID replay, persisted reload, six map checkpoints,
four original building crops, and stable source-map screenshots. The saved
six-point route is `959a4c41-9e95-4728-a720-7f6b3f2ed45d`, starting from the
current B07 asset. Its starting identity and route reviews are now rejected after the user and
two independent visual judges rejected B07 for this route. The five later
persisted stills and all clips are empty. Tests created no paid claims or provider
submissions and left the paid ledger unchanged. They establish behavior and
source provenance, not the visual fidelity of an unrun model output.

Readable failed raw images survive portable import as inert pending history.
Video import verifies identical encoded video streams between original and
silent playback, including the accepted 4.4–5.6 second duration range. Imported
records never restore generation claims or budget reservations.


## Curvature and independent visual review — 2026-10-05

The six separately staged previews failed both independent judge scopes. They
repeated a fountain-centered approach while the drawn path bends left. The
starting image already changed the source architecture and omitted the roofed
well beside the forge; reusing it for every position propagated that error.
The bookshop bay, inn frontage, compact conservatory, sculpture and street
boundaries were also rewritten. The final marker is on the approach, not proof
of arrival at the fountain. No staged preview is an accepted continuous walk.

New still and video inputs use prompt versions `image-led-walk-v2` and
`image-led-walk-video-v2`. The shared `image-led-route-intent.ts` helper derives
each local path heading, turn and named source landmark bearing using the
original image's pixel aspect. The backend validates these fields before any
provider upload. Crop centroids are image-plane evidence; they do not establish
ground positions, visibility or physical yaw. Context such as the well, terrace
edges and sculpture must survive independently of landmark crop descriptions.
Fresh v2 worker capabilities are required for new quotes. Known provider-request
GET recovery remains available for older prompt versions.

The user's requested agent workflow is recorded in `AGENTS.md`. Stage new
candidates privately and have two distinct subagents inspect the actual source,
references, route and candidate bytes: one for `source_identity`, another for
`route_context`. Bind their complete per-position reports to the exact source,
reference crops, full route intent, starting context, predecessor and ordered
candidates. Run `scripts/image-led-preview-gate.mjs` with a trusted local asset
root and the pinned manifest. Missing, failed, uncertain or stale reviews block
the showcase. A bad start blocks the whole sequence.

The gate checks actual local file hashes, source dimensions, authoritative route
intent and independently pinned judge identities. It overwrites a stale gallery
with a withheld page before checking; blocked output shows only the original
source and textual findings. Previously shared rejected images may be exposed
only through explicit diagnostic opt-in. Gate clearance neither changes owner
reviews nor authorizes paid submission. The current live route's rejected start
blocks its next quote, with no paid claim or ledger change. A privately staged replacement start from the original map and crops has now
passed both independent qualitative judge scopes. Later views and video have
not been generated or cleared; the old six-image sequence remains rejected.

A starting-view experiment may declare `requested_positions: [1]` while retaining
the complete source route and intent. The only permitted subset is a contiguous
prefix beginning at position 1; expanding it invalidates earlier report bindings.
Such output explicitly states its reviewed count and that the walk is incomplete.
This permits validating the start before generating more views without claiming
that unseen later positions or walking motion passed.

The replacement start is `private-start-v2/position-01.png` in the local
`fantasy-fresh-rhWGis` evidence folder, SHA-256
`69a98f21a7a45a4b0b340405514f334dcab9966e5dcae07fa97632da655d179b`.
It was generated with the built-in image tool from the original map and four
source crops, without B07. The prompt and both exact bound judge reports are
retained alongside it. Its roofed well, terrace layout, compact conservatory and
off-axis fountain address the starting composition error. Qualitative judging
does not prove calibrated placement or hidden façade details. The persisted
world still retains its rejected old starting frame; this experiment does not
silently replace it or approve a paid continuation.


### Stricter shape reassessment — 2026-10-05

After the user flagged continued geometry drift, both judges independently
reassessed the replacement start. The earlier qualitative passes were too
forgiving to establish unchanged architecture. Broad starting orientation and
well/terrace placement remain improved, but strict architectural shape is not
cleared: the fountain crown and tiers are rewritten, Forge opening inventory
changes, Conservatory facets/mullions differ, and clipped bay/roof surfaces
remain unverified. Viewpoint changes can explain occlusion and projected size,
but cannot establish that redesigned visible features are the same geometry.

`geometry-comparison-v1/all-in-one.png` under the local visual evidence folder
is an explicitly requested diagnostic figure: full original map and route,
current generated start, four original building crops and source/generated
fountain/well details. It uses existing pixels with preserved aspect and no new
AI generation. It is not another accepted showcase or a continuous walk.
Historical qualitative reports are retained; stricter evidence supersedes their
use as architectural shape clearance. Owner records and spending remain separate.

### Recursive repair and current presentation review — 2026-10-06

The v4 still profiles preserve reference order, model-specific parameters and
model-bound reservation ceilings. The existing owner/CSRF-protected walk POST
accepts `action: "quote"`, `kind`, `index` and optional `repair` to prepare a free
quote without changing reviews, creating jobs or reserving spend. Scheduling
still requires the returned exact quote and explicit consent. A repair target
must have an owned original receipt for the same source, route and checkpoint.
Rejected slots stay immutable; repairing their original into an empty slot in a
new walk does not approve or overwrite the rejection. There is no mask editor in
the ordinary walk UI.

Private repair records track the target, authoritative source region, actual
approved predecessor, strategy and genuine judge evidence. Two failures using
the same local strategy escalate to crop repair followed by full-scene
integration, whole-building repair, then context regeneration. A wrong starting
view or route topology requires context regeneration immediately. A repaired
crop alone cannot pass: both judges must recheck the whole scene, prior fixes,
surroundings and every requested position.

Every immutable manifest and its genuine reports must be registered with
`image-led-preview-gate.mjs --register-review` before presentation. The trusted
asset root contains `image-led-review-index.jsonl`, an append-only hash chain
pinning those exact manifest and report bytes. The gate checks this journal on
every evaluation. A later failed or unmeasured review of the same candidate,
position and source-route context withdraws earlier passes, even from shorter
prefixes. Missing, truncated or changed journal evidence blocks presentation.
Changed candidate bytes require fresh bound reviews; rejected originals and
their reports remain preserved.

The local gallery server rechecks the copied manifest against the current
journal on each request. A withdrawn gallery shows only its verified original
map and blocks direct requests for its generated media. The complete six-view
sequence requires a fresh full-prefix challenge before the default showcase is
restored. Presentation clearance remains separate from owner approval and from
the creation or temporal review of actual walking clips.

New still quotes also bind a `contain-jpeg-v1` playback canvas: the exact first
reviewed frame dimensions, the seed dimensions if starting from a seed, or
688×387 for a new walk. Every subsequent playback JPEG fits that canvas with
uniform scaling and dark padding; native originals remain unchanged. Changing
the canvas invalidates an unsent quote before a provider call. New still quotes
require a fresh worker advertising `image_led_walk_v4_canvas_v1`. Already submitted
jobs retain their immutable quotes and legacy playback behavior. Portable archives
validate the declared canvas and reproduce the derivative from its native original.

For a rejected checkpoint at a later position, use the existing owned action
endpoint with `{ "action": "fork", "id": "NEW_UUID", "index": CHECKPOINT_INDEX,
"revision": CURRENT_PARENT_REVISION }`. This free explicit action creates a new
route with the exact owner-approved prefix and its saved reviews, and empty slots
from that checkpoint onward. It preserves the parent's rejected media, reviews and
provider receipts. Completed clips entirely inside the copied prefix retain their
original bytes and existing review status; provider job claims are never copied.
The parent revision advances to fence concurrent review changes. A fork UUID is
idempotent, active or ambiguous submissions block new forks, and imported history
cannot become a live generation route. Then request a fresh repair quote on the new
walk using the old checkpoint's exact owned raw receipt. The fork itself performs
no provider call, reservation or owner approval.

The review panel exposes this as **New attempt from this position — free** on a
rejected or failed painting. It keeps an idempotent fork receipt across refreshes,
recovers the exact saved prefix through owned reads, and returns to the retry
position without submitting a generation. The owner requests and consents to a
new quote separately. A rejected starting seed is omitted from a restart at
checkpoint zero, so the new first view starts from the original map.
