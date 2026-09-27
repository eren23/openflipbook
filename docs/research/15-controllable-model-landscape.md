# Controllable Models: Evidence and Options

Snapshot: September 9, 2026. Scope: illustrated place arrivals, camera movement,
and persistent spatial consistency. Execution order lives in the
[current roadmap](../ROADMAP.md).

September 12 addendum: the separate H3 Max camera-controls endpoint is now a
planned geometry-guided experiment. Its calibration, evaluation, budget and
promotion gates live in the roadmap's
[camera video experiment](../ROADMAP.md#geometry-guided-camera-video-experiment).
This does not change the historical evidence below or authorize paid runs.

This is a planning report, not a model benchmark or permission to spend. Provider
capabilities below were checked against public documentation. Except where
explicitly recorded, they have not been tested on our worlds.

## Decision Summary

Test Ray 3.2 and Seedance 2.5 against the same illustrated movement task. Keep
H3 and LTX as existing comparison tools, not assumed winners. Separately test
one small Marble environment to investigate persistent space. Do not replace
the app's illustrated map experience with the development blockout.

The distinction is architectural:

- Endpoint conditioning says where a clip should start and finish.
- Video/depth/trajectory conditioning supplies evidence about the movement
  between those endpoints. Adherence still needs measurement.
- A saved 3D asset lets a renderer revisit the same geometry without asking a
  video model to invent it again. That geometry may still misinterpret the image.
- A real-time world model responds during generation; interactivity alone does
  not establish durable place identity, exportability, or a production API.

No option establishes automatic map-to-interior consistency merely by being
called a world model or accepting camera controls.

## What We Actually Have

| Evidence | Observed result | Does not establish |
| --- | --- | --- |
| [H3/LTX pilot](12-transition-video-pilot.md): six clips, three input pairs | Generated motion and recognizable supplied endpoints; input arrivals were already wrong | Correct landmark arrival or continuous geometry |
| [Controlled LTX pilot](13-controlled-video-pilot.md): five clips | Structural control followed a source-pixel lighthouse zoom; no clear visual gain over the free reference | New viewpoints, recovered depth, or the proposed strict landmark-error pass |
| [Connected journey](14-connected-journey-demo.md): saved four-node world and 27-second film | Several curated places, working navigation, stable saved-image returns | Automatic arrival selection or uninterrupted 3D travel |
| Local `/dev/spatial-transitions/geometry` | Authored Three.js quay/shop layout, camera movement and same-scene return; prior focused unit/browser checks passed | Reconstructed map geometry, acceptable final artwork, or AI-styled 3D motion |

The geometry export attempt failed at the range-input fill before producing a
completed capture manifest. No completed geometry-guided H3/LTX comparison or
clean exported film exists from that attempt. Fixing it is conditional on the
guide being useful, not a reason to keep expanding the prototype.

The checkout also contains uncommitted implementation and experiment work. This
report is not a statement that those changes are merged or deployed. The older
image-edit pilot has an endpoint-routing correction documented in
[report 11](11-place-identity-pilot.md); do not treat its affected runs as clean
evidence about a model's reference-image ability.

## Model Shortlist

### Ray 3.2: First Motion Experiment

Fal endpoint: `luma/agent/ray/v3.2/video-to-video`.

The input schema exposes a source video, optional appearance keyframes at source
frame indexes, and separate depth, normals, trajectory, pose and face controls.
Up to 64 guide images are documented. Explicit controls cannot be combined with
`auto_controls`; a starting image and the multi-keyframe list are alternatives.
[Fal API](https://fal.ai/models/luma/agent/ray/v3.2/video-to-video/api).

Our hypothesis: an independently validated camera guide plus our illustrated
appearance can produce movement worth showing. This is a test priority, not a
claim that Ray is the quality winner. Luma distinguishes motion preservation
from shape preservation and warns that small details can follow motion only
approximately. The web application's sliders must not be copied blindly into
the API's different parameter schema.
[Luma controls guide](https://lumalabs.ai/learning-center/articles/ray-3-2-controls-and-workflows-in-depth).

Not integrated or run on this project's worlds yet.

### Seedance 2.5: Reference-Driven Challenger

Fal endpoint: `bytedance/seedance-2.5/reference-to-video`.

Accepts image, video and audio references. Fal documents coarse 3D footage as a
guide for camera movement, layout and entrances, with additional images defining
appearance. This makes it a relevant comparison to Ray, not just another
first/last-frame interpolation model.
[Workflow guide](https://fal.ai/learn/devs/how-to-use-seedance-2-5),
[API](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api).

Assign each reference a clear role; a bundle of inconsistent images is not a
scene contract. Native long clips and reference capacity are provider features,
not proof that our building will remain unchanged. Start with a short move and
no requested scene cuts. Not integrated or run here yet.

### Light-X ReCamera: Targeted Camera Experiment

Fal endpoint: `fal-ai/lightx/recamera`.

Accepts an existing video and either trajectory parameters or a target camera
pose; documented modes include gradual motion and dolly zoom.
[API](https://fal.ai/models/fal-ai/lightx/recamera/api).

Useful hypothesis: a bounded lateral move or orbit can be directed more
explicitly than through prose. It still synthesizes video, so it is not our
persistence layer. Its camera convention must be checked against a simple
calibration scene before mapping app coordinates to it. Not integrated or run
here; defer unless the first comparison exposes a specific camera-control gap.

### Marble 1.1: Persistent-Space Experiment

World Labs model: `marble-1.1`, through the World API, separate from fal.

Generation supports text, image, multi-image and video inputs. The returned
assets include Gaussian splats, a panorama and a collider mesh. This provides
a concrete path to retaining and rendering the same generated environment.
[Quickstart](https://docs.worldlabs.ai/api),
[asset schema](https://docs.worldlabs.ai/api/reference/worlds/get).

Our hypothesis: one illustrated, ground-level place can become an inspectable
saved environment. Start with one room or small quay segment, not a whole
top-down city. A single view leaves unseen surfaces underdetermined; inspect
those inventions and style preservation before connecting the result to a map.

Generation and local camera movement must remain separate operations. Store
the chosen asset and provenance; do not regenerate on every turn or revisit.
Current repo has no Marble integration. Account access, API credits, asset
download rights and a suitable browser renderer must be checked first.

### H3 and LTX: Existing Comparators

The H3 Max route we use accepts first and last images; its public input schema
does not expose the trajectory/depth controls above. Extra types elsewhere in
an API page are not necessarily callable fields on that endpoint.
[H3 API](https://fal.ai/models/minimax/h3-max/image-to-video/api).

The newer `minimax/h3-max/camera-controls` endpoint exposes subject-relative
camera keyframes, but no ending-image input. Do not substitute its model ID into
the existing first/last-image adapter. This newly documented capability is a
candidate for calibrated geometry-derived paths, not evidence of spatial
accuracy on our worlds.
[Camera-controls API](https://fal.ai/models/minimax/h3-max/camera-controls/api).

LTX Quality's reference-video endpoint accepts a precomputed depth/edge/pose
control video and first/middle/last appearance images, with structural and
denoise controls. It limits resolution multiplied by frame count; validate
dimensions and duration before submitting.
[LTX API](https://fal.ai/models/fal-ai/ltx-2.3-quality/reference-video-to-video/api).

Keep their saved outputs as historical evidence. They are not fair head-to-head
competitors to new models unless source, destination and task also match. A new
model string alone is insufficient: each endpoint needs validated arguments.

### Watch, Do Not Depend On

Genie 3 is an interactive world-model research direction, with a public Project
Genie experience. That page is not evidence of an API we can ship against.
[DeepMind](https://deepmind.google/models/genie/).

Odyssey's developer portal currently describes Odyssey-2 Max rollout to existing
API users and priority-access requests for newcomers. Treat access as unverified
for this project. Research announcements and accessible integration are separate
milestones. [Developer portal](https://developer.odyssey.ml/).

## Cost Envelope, Not Authorization

Published prices checked September 9, 2026. Recheck the selected endpoint and
account before every new batch. Estimates exclude additional still generation,
paid judges, storage and tax; unsuccessful submissions may still incur cost.

| Proposed work | Published basis and estimate | Proposed reservation |
| --- | --- | --- |
| Two Ray clips, 5s each, 720p SDR | $1.08 each, $2.16 total | Within the motion batch below |
| Two Seedance clips, each 5s output with 5s reference video, 1280x720 | Token formula gives about $2.77 each, $5.55 total, including input seconds | Combined Ray/Seedance batch: $10 |
| Up to two Marble 1.1 worlds from non-panoramic images | 1,580 credits each at 1,250 credits/$1: about $2.53 total | Separate $3 generation reservation |

Sources: [Ray pricing](https://fal.ai/models/luma/agent/ray/v3.2/video-to-video),
[Seedance pricing](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video),
[World API pricing](https://docs.worldlabs.ai/api/pricing).

World API billing is separate from Marble web-app credits; its minimum credit
purchase is $5. A $3 generation reservation does not authorize a $5 top-up or
automatic refill. Seedance charges reference-video duration as well as output;
the token formula, not a rounded output-only rate, governs the estimate.

All proposed batches are UNAPPROVED. Previous experiment budgets do not carry
over. Use durable reservations, frozen input hashes, recorded effective model
arguments and request IDs, no automatic rerolls, and GET-only resume for known
jobs. Retain failed/ambiguous submissions in the ledger. Replays must not submit
new generation requests. Receipts must distinguish estimates from actual bills.

## Recommendation

The next deliverable should be a small, inspectable comparison, not another
large framework or an edited film that hides failures. Test movement and place
identity separately; promote only a result that passes both. The
[roadmap](../ROADMAP.md) defines the order, acceptance gates and stop conditions.
