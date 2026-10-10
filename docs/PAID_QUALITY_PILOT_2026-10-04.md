# Integrated paid quality pilot — October 4, 2026

The user authorized paid models on October 4: “we can use paid models i guess np”.
This pilot has a cumulative **$5 reservation ceiling**. The original allocation is
**$4.04**, including one explicit illustration retry and one explicit motion retry.
A separately reviewed $0.40 layout extension brings allocated ceilings to **$4.44**.
These are ceilings, not spending targets. No paid request was submitted to prepare
this quote. The machine-readable quote is saved locally at
`apps/web/test-results/paid-quality-pilot-2026-10-04/quote.json`.

This is an initial bounded study toward the fresh generated-quality milestone in
[the release integration record](RELEASE_INTEGRATION_2026-10-03.md#remaining-generated-quality-acceptance)
and [the world-building goal](WORLD_BUILDING_GOAL.md). Use one persistent source-free
world, with generated layout, material tiles, a prop and whole architectural mesh,
one floor furnishing proposal, structural and appearance edits, saved camera
captures, adjoining expansion, and a bounded five-second camera study. Verify the
same building and its entrance against saved geometry in plan, map, illustration,
3D, interior, upstairs and return views. The saved world now has four connected places and eight structured buildings
inside an 80 × 80 metre bounding box, with 4,608 m² of occupied ground. The shape
is irregular. Separate complete fantasy and nonfantasy worlds and rich generated
image/video consistency still require acceptance.
The pilot preserves failed attempts and
reports quality honestly; an authored fixture or passing silhouette is insufficient
evidence of generated content identity.

## Current rates and reservations

Prices were checked against primary provider pages at 09:57 UTC on October 4.
The quote pins source captures to **768 × 768** pixels, text-only planning, full
system/user text inputs to at most **32,768 UTF-8 bytes**, and completions including
reasoning to **16,384 tokens**. Larger requests require an amended quote.

| Phase | Maximum requests | Reservation per request | Phase ceiling |
| --- | ---: | ---: | ---: |
| Initial layout | 1 | $0.20 | $0.20 |
| Material tiles | 3 | $0.08 | $0.24 |
| Prop and architectural mesh | 2 | $0.85 | $1.70 |
| Floor furnishing proposal | 1 | $0.20 | $0.20 |
| Structural and appearance proposals | 2 | $0.20 | $0.40 |
| Saved geometry captures | Free | $0 | $0 |
| Keyframe illustrations, including one explicit retry | 3 | $0.10 | $0.30 |
| Adjoining layout proposal | 1 | $0.20 | $0.20 |
| Five-second motion, including one explicit retry | 2 | $0.40 | $0.80 |
| **Allocated total** | | | **$4.04** |

`google/gemini-3.7-flash` currently costs $0.75 per million input tokens and $3.75
per million output tokens under standard discounted routing. Undiscounted rates
are $1.50/$7.50. Conservatively treating each input UTF-8 byte as a token gives
`32,768 × $1.50/M + 16,384 × $7.50/M = $0.172032` per limited request; the $0.20
reservation covers that amount. The existing planner/edit adapters make one
completion and disable SDK retries and format-repair calls. Reasoning shares the
completion ceiling. No web-search suffix or image input is included. [OpenRouter model and rates](https://openrouter.ai/google/gemini-3.7-flash).

`bytedance/seedream/v5/pro/text-to-image` has tentative pricing of $0.0675 for
images up to 1536 × 1536 area. The existing material adapter requests one
1024 × 1024 JPEG tile, reserved at $0.08. [Seedream exact endpoint](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image).

`fal-ai/hunyuan3d-v3/text-to-3d` costs $0.45 for LowPoly, plus $0.15 for PBR and
$0.15 for custom face count. The pinned existing request uses PBR, 40,000 faces,
LowPoly and triangles, totaling $0.75; reserve $0.85. No multiview input or
unquoted substitute model is included. [Hunyuan exact endpoint](https://fal.ai/models/fal-ai/hunyuan3d-v3/text-to-3d).

`fal-ai/qwen-image-edit-2511` currently costs $0.03 per megapixel. The existing
keyframe job requests two outputs, then one `fal-ai/sam-3/image` mask for each.
Conservatively using one full megapixel per output gives `2 × $0.03 + 2 × $0.005 =
$0.07`, within the pinned $0.10 reservation. Explicit output dimensions prevent
the source image size from silently increasing the quote. The earlier source
comment estimating $0.035 per Qwen image is historical. [Qwen exact endpoint](https://fal.ai/models/fal-ai/qwen-image-edit-2511),
[Qwen input schema](https://fal.ai/models/fal-ai/qwen-image-edit-2511/api),
[SAM-3 exact endpoint](https://fal.ai/models/fal-ai/sam-3/image).

H3 Max's current 768P promotional price is $0.048 per second until October 15;
regular pricing is $0.08 per second. Reserve the regular rate: five requested
seconds cost $0.40. The pilot uses `minimax/h3-max/camera-controls`, the current
`h3-source-relative-v2-measured` adapter, 768P, and the existing balanced expansion
mode. Camera-keyframe times are normalized to 0–1. The root agent independently
checked the exact camera-controls endpoint's promotional and regular prices.
Confirm the local capability rate before submission.
[H3 current and regular prices](https://fal.ai/models/minimax/h3-max/camera-controls),
[camera-control schema](https://fal.ai/models/minimax/h3-max/camera-controls/api).

The existing depth and region-edit alternatives cost $0.04 and $0.075 per
rounded-up megapixel respectively. They are documented for comparison and are
not included as paid substitutions in this allocation. [Depth endpoint](https://fal.ai/models/fal-ai/flux-control-lora-depth/image-to-image),
[inpainting endpoint](https://fal.ai/models/fal-ai/flux-general/inpainting).

## Execution and evidence

Compare live local capabilities with model IDs, reservations and frozen parameters
before each claim. Reserve against the **cumulative** pilot ledger before submitting;
keep ambiguous submissions charged until resolved. Never resubmit an unknown
request or an invalid text proposal automatically. A retry requires a known failed
attempt, an explicit new claim and available phase/global reservation. The two
allowed illustration/motion retries are already included in their phase ceilings;
other stages have no retry allocation. The original $0.96 headroom is reduced to **$0.56** by the separately reviewed
growth extension. It permits no additional calls without updating the saved allocation.

Persist exact provider request IDs, input/output hashes, raw responses, assets,
validation failures and final composites. Structural edits preview/apply once;
appearance edits preserve geometry; refresh affected saved views and inspect
protected surroundings. Keep camera/silhouette verification separate from owner
content approval. Evaluate real camera direction, landmark preservation,
occlusion, architecture and endpoint/timing checks before calling a video ready.
Pause and preserve on failed consistency checks. Reopening the world, replaying
saved video or recovering storage alone must submit no new paid work.

The source supports these endpoints, but public model pages are not authenticated
availability checks. The backend's general context limits are larger than this
pilot's quoted limits, so the harness must enforce the pilot byte/dimension bounds.
Provider billing and local reservations are different records; preserve both where
usage is available. This five-second calibration provides bounded motion evidence,
not proof of full multi-place route-video quality or completion of every goal.

## Live run record

The fresh private project is `ofb-pilot-68f3debad82e`, with evidence in
`apps/web/test-results/quality-pilot-TAMG5M`. Credentials, ownership cookies and
provider environment files in that ignored directory are private. The approved
quote SHA is `1d9cbbeb3f238d3b21dd6173606d010ce34fa2132f8321c961b46452623ddec6`.

At 10:19 UTC all six initial paid jobs had completed: one Gemini layout, three
Seedream tiles and two Hunyuan meshes. The layout produced a two-floor Copper
Workshop, a bakery, a bookshop, connecting paths, an upper-floor chair and an
explicitly non-enterable garden kiosk. Root inspected the actual plan/3D preview
and all three material images before applying the exact reviewed definition.
Both GLBs and all tiles were downloaded through their private product routes and
checked against stored SHA-256 hashes. The kiosk has 12,524 triangles and three
PBR textures (28.3 MB); the chair has 7,019 triangles and three textures (34.2 MB).

The application ledger reserved **$2.14** for these six jobs. OpenRouter's
authenticated generation receipt reported **$0.021551062** for the layout;
`layout-openrouter-billing.json` preserves that receipt. The fal amounts remain
quoted reservations, not an invoice. No request was resubmitted.

The first free capture applied revision 2 and saved a 704 × 576 render, depth,
normal and object-ID pass. During walking, its first movement autosave exposed a
verifier timing defect: sequential camera reads compared a queued pose with a
later moving frame. The attempted check failed rather than claiming traversal.
Its trace, uncut recording, walk receipt and original frame timing are retained;
the harness drained the worker and stopped only its own services. A stores-only
inspection found all six jobs ready, zero worker heartbeats and the unchanged
$2.14 ledger before any explicit recovery. This is a verifier failure, and does
not establish either passing or failed architectural traversal.

The first moving-camera measurement used an Apple M5 host with **SwiftShader
software rendering**, not hardware acceleration. Desktop median/p95 frame
intervals were 41.7/58.4 ms at 1280 × 900; a 390 × 844 viewport measured
15.5/18.0 ms. These are browser frame delivery diagnostics, not GPU timings or a
physical-mobile benchmark; raw results are preserved in
`capture-first-attempt/performance.json`.

The second free attempt resolved autosave timing but failed a waypoint check
after a 35 cm keyboard overshoot. It is preserved in `capture-second-attempt`
with its trace and recording. Capture then removed artificial RPC delays and
used actual keyboard pulses near waypoints. At **10:40:57 UTC**, the third
attempt passed all traversal checks: physical resumption of the saved exterior
position, exterior and partition door crossings, both ground rooms, the upper
room at 4.8 m eye height, stair descent, outdoor return, entrance return, and
restoration after reload. Geometry stayed at the exact approved revision 2.
`walk-1791110301219-evidence.json` records measured cameras, actual app autosaves
and checkpoints; its uninterrupted capture video and trace remain local. The
third attempt reused the already recorded performance result for the same
geometry and made zero provider submissions.

At 10:45 UTC the same world had also completed and applied one upper-floor
furnishing proposal, one structural edit, one appearance edit and one adjoining
layout. Root reviewed each exact generated definition before application. The
structural edit moved only the Workshop one metre east; the appearance edit
changed only its wall tile scale. Saved root revision 5 preserves its floor plans,
stairs, openings and furnished upper floor. The adjoining Canal Tea House and Tool
Store bring the connected world to five structured buildings. The east portal and
second enterable building still require a separate physical traversal check.

The read-only close-up review inspected the actual upright chair and garden kiosk
from two angles and verified the bench/barrels leave the upper stair opening clear.
Its canonical scene and saved walk position stayed unchanged, with no browser
writes. Evidence is in `floor-review-result.json` and its uncut recording.

The first Qwen illustration completed but failed both silhouette/camera validation
and root content review: it zoomed/cropped the view, enlarged the roof and added
architectural elements. The one explicitly quoted retry also completed but failed,
with silhouette IoU 0.700, vertical centroid shift 0.074 and area ratio 1.349. Root
inspected its exact image and rejected the shifted/enlarged roof, changed gable and
added facade framing. Both images, provider receipts and failed assessments remain
saved. No illustration was accepted; no further illustration retry is allocated.
The original evidence is in `illustration-first-attempt`; the retry is in
`illustration-retry-attempt`. These are completed provider requests with failed
quality, rather than successful generated-architecture proof.

At 11:02 UTC all twelve submitted paid jobs were ready and the application ledger
reserved **$3.14**. The five authenticated OpenRouter generation receipts report
**$0.072299451** in total, preserved in `openrouter-billing-receipts.json`.
The fal reservations remain separate from actual invoiced spend. Explicit recovery
checked every saved request, unchanged root/annex geometry and ledger before
restarting the same private project; it made no model calls.

The free connected walk then passed all eight checks in
`connected-walk-1791112208255-evidence.json`: real east-boundary handoff,
entry into the second structured building (Canal Tea House / Tea Lounge),
restoration of its saved interior pose, reverse handoff, physical return to the
root entrance and reload restoration. Every actual app autosave was accepted;
all saved geometry and connections were unchanged. Its trace, checkpoints and
uncut recording are retained. This proves connected walking in the five-building
world at this revision; subsequent growth requires a new network check.

Root separately reviewed an additional two-call layout quote before any growth
submission. `growth-quote-approved.json` has SHA
`a04ff542c6a697e7fe0cc4a7c1fc9e544146b7b38f9c967ad7763c54608703c4`,
reserves **$0.40**, and holds every original phase allocation unchanged. Total
allocated ceilings are now **$4.44**, within the root-imposed **$5** pilot cap.
It permits a 16 × 40 western lane with two buildings and a 40 × 40 northern
garden with one contemporary building. No new material or mesh generations and
no automatic retries are included. The intended result is an irregular connected
80 × 80 bounding box with eight buildings, not a fully filled square or independent
repetitions of complete fantasy and non-fantasy worlds. The original quote and
original paid request identities remain unchanged.

The first western growth execution exposed a driver callback timing defect after
the product acknowledged its durable request. The harness stopped its own writers
and retained all stores. Read-only reconciliation found the exact original job
`adjacent_0bece32d-28a4-46e5-aeff-90b3c04bd3a7` still scheduled, with no
provider claim/request/lease fields: the worker had stopped before processing it.
Its original $0.20 reservation remains held. This attempt does not prove a
completed or applied western layout. Recovery must restart that same durable job,
without creating a replacement request.

At **11:23:29 UTC** both growth layouts were reviewed and applied through ordinary
UI controls. The original western job resumed without a replacement POST. Saved
western and northern scenes are revision 2; the original root and annex remain
exact revisions 5 and 2. `growth-north-saved-network.json` records **four places,
eight unique structured buildings, an 80 × 80 metre bounding box and 4,608 m² of
occupied ground**. Original scenes, connections, IDs and generated asset bindings
stayed unchanged. Three additional buildings use provider base colors, with no
new assets. Root inspected actual plan/3D previews and recorded exact proposal SHA
approvals before each apply. The northern pavilion retains ordinary small windows
and the supported pitched roof; its prompt alone does not establish a rich new
architectural style or a separate complete contemporary-world repetition.
Application reservations are now **$3.54** for fourteen paid product jobs.

The connected physical walk passed again after both additions, now against the
four-place eight-building saved network. Evidence is
`connected-walk-1791113293053-evidence.json`: all eight checks passed, including
tea-house interior restoration, reverse boundary travel, root return/reload and
unchanged complete network. Root walker verification now derives both global
offsets from the current network (16,40), so its observed global entrance
(36,78.8) is validated against local saved pose (20,38.8) without injecting poses.

Root inspected all five frozen 704 × 352 geometry frames before the first H3
request. Study SHA is
`9384c0914d7c7ce8d0db2e81eaa2f8e49ba70e86136333ad27a641653f52e734`;
comparison SHA is
`4654a80bc54f023cd0334323050275fa4f6b9ce6bc98d2dd00bb2da78342c016`.
The five-second approach keeps the original Workshop, bakery and bookshop visible;
this single-place source does not contain all eight buildings. Tolerances were
frozen before submission, including 3% position, 20% size and 1% aspect ratio.

The first H3 job `8959a314-436d-490f-8374-853275a50c85` completed and its exact
silent MP4 SHA is
`28188b4b9cd36afa5749278f258ec428ebc269ed24e5a28c50d49759a8af9c89`.
Offline decoding produced 1440 × 704, 5.166667 seconds, zero audio streams.
`motion-decoded-original/samples.json` records exact presentation timestamps and
five decoded PNG hashes. Duration passes the frozen tolerance, but aspect ratio
is 2.27% different from the 2:1 reference and the observed approach overshoots its
geometry path. The output remains unaccepted; actual landmark measurements are
being retained, with no expected geometry copied into observed bounds. The
application reservation is **$3.94**, separate from actual billed usage.

The original clip has a saved and reopened **failed** product comparison review
`c2409dc6-b092-47e8-84f4-b3c415bc4e93`. All 15 observed landmark boxes were
measured from decoded video pixels, with ±4-pixel edge uncertainty. Endpoint size
errors are 85.49% for Workshop, 96.40% for Bakery and 67.78% for Bookshop; position
errors are 7.53%, 8.24% and 4.33%. Uncertainty cannot bring them within the frozen
limits. All 124 decoded frames were inspected in six sequential contact sheets:
continuity and occlusion order passed, while architecture remains unreviewed
because the small source cannot certify each opening. Legacy product provenance
uses a human-measurements enum; this evidence is explicitly an agent-recorded
comparison, not independent human attestation. Original receipts, failed review,
reference frames and video are preserved in `motion-first-attempt`.

Root approved preparation of one explicit, already allocated $0.40 motion retry
after the saved known failure. It uses ordinary camera controls for a gentler
40-to-36-metre approach and a viewport aimed at a standard 5:3 capture. Default
capture dimensions snap to 32 pixels; actual saved dimensions must be inspected,
not assumed. The production adapter, model and numeric tolerances stay unchanged.
The historical 0.6 distance gain amplifies the original approach, and its accuracy
does not transfer reliably to this scene. This retry is a bounded experiment, not
a verified calibration fix; its exact new frames require root review before
any paid claim. No third motion attempt is authorized by this allocation.

Authenticated OpenRouter billing now covers all seven planning/editing jobs:
**$0.107836986** reported, preserved in `openrouter-billing-receipts.json` with
HTTP 200 for each exact generation ID. The first-five receipt remains immutable
in `openrouter-billing-first-five.json`. fal amounts are still reservations.

The free retry study saved actual **640 × 384** source references (5:3), all five
inspected by root before submission. Study `bef92c42-74c2-4f4c-b061-7afd9190c458`
has SHA `68a44bcc18dc38155f5480f0dbccd7260d89b0a86d8dd5cf527dc5f74ac2996a`
and comparison SHA
`1c4cd3bf4415e649fb775ee68005f26492882f38f7413b5ce3b0467128d31682`.
The second and last H3 job `aea8b6d6-17a0-42b6-b390-8a3396508507` completed
at 11:57 UTC; silent MP4 SHA
`36b3a279d769ba5acf8be82681f2edeee537f4fb55694a5149a53b6fcc5a10e4`.
Actual decoding confirms **1280 × 768**, 5.166667 seconds, zero audio streams.
Aspect ratio and duration now pass; landmark comparison remains pending actual
measurement. Both clips are preserved and unselected. Application reservations
are **$4.34** across **16 completed paid jobs**, within **$4.44** allocated holds.
No further model retry is allocated.

Final free replay completed at 12:04 UTC, run
`replay-1791115273926-d48feb8a`. It verified **54 immutable media receipts**,
all generated material/mesh bytes, both motion studies, and every saved scene
and build library across four places, eight buildings and three connections.
Network SHA stayed
`3bd62df43ff5707aa2074720edfa7ce7198ad7ab01078c8adbbbc35d803643e2`.
Actual saved-video play, pause, seek and replay passed without selecting either clip.
The current furnished and edited root **revision 5** passed all nine physical
walking checks, including both ground rooms, upper room, stair descent, exterior
return and reload restoration. Evidence is `walk-1791115290319-evidence.json`;
96 validated app autosaves, zero rejected autosaves, zero generation submissions.
The walker observes global coordinates and converts them to the saved root-local
frame (origin16,40); it never injects a pose or resets geometry. Uncut video,
trace and real screenshots are retained. Root inspected the actual upper-room
screenshot after the run.

The final retry also **fails** the unchanged product geometry comparison. Its raw
observations SHA is
`949192c62317a1a2ed28168618011825560e3a8de6eef4ce5c2571ffd74108c7`.
Endpoint size errors are **33.68%, 38.41% and 29.31%**, versus 20%; position errors
are4.62%,5.43%,1.41%, versus 3%. All three size failures remain outside tolerance
with ±4-pixel edge uncertainty. All124 actual frames and six contact sheets were
inspected by the animation agent and root. Broad identities, occlusion and visual
continuity persist; detailed architecture remains unreviewed, and the approach
decelerates into a near-stationary tail. This is agent-recorded evidence, not
independent human attestation. The second output remains unaccepted. The single
allocated motion retry is exhausted; no further provider requests are scheduled.

The last motion review was saved and reopened as
`5c31db20-dee3-419d-bebb-023bb334559e`, outcome **fail**, selected=false.
The full operator backup then completed: **28 collections**,
**67 objects**, **76,676,994 blob bytes**. Manifest SHA
`a2a0a847a25ddaff28fbccae31687d5f8ddda4874b7af07d3f3758574ecb76aa`. Every archive SHA, length, BSON document and row count
was validated by the official restore validator without destination writes.
The worker exited 0, all heartbeats were cleared and all 16 paid jobs were ready;
no pending job exists. Only this pilot's writers were stopped and its volumes
retained. Actual restore/reopen verification uses a separate fresh target.

Its first startup stopped before restoration: the Compose 5.0.2 wait command
failed while both explicitly waited one-shot init containers had exited successfully. Both init
containers and persistent stores exited 0; no official restore command or model
call ran. The failure and fresh target are retained; startup handling is being
corrected before an explicit empty-target resume.

The explicit same-target pre-restore resume **passed** at 2026-10-04T12:16:59.082Z.
It preserved the exact first failure receipt and environment, then verified
successful init exit codes and an empty destination before the official restore.
Target `ofb-check-dcce3140f76f`, evidence
`apps/web/test-results/quality-pilot-restore-OIsW89`, database
`quality_pilot_restored`. All **28 collections**, BSON rows and indexes, and
**67 objects** matched the backup before and after actual read-only reopening.
The restored browser verified all four places/eight buildings/three connections,
**55 immutable media receipts** including the newly saved retry review, and
**five generated material/mesh assets**. All four 3D canvases rendered nonblank
(RGB ranges 184–222); root inspected every actual restored screenshot. Durable
walking position remained unchanged, zero browser writes were attempted, zero
page errors occurred, zero model calls ran and no worker was created. Original
source evidence stayed unchanged throughout the check. Uncut video and trace
are retained. Target services stopped successfully; all target volumes remain.

Final harness verification: **96 tests pass**, with ESLint, TypeScript and diff
checks clean. The restore wrapper passes 13 hostile configuration guards and 9
known pre-restore resume guards. Production release baselines remain the pinned
2,778 web tests, 1,774 backend tests and 9 fresh-store E2Es recorded separately.
The pilot improves evidence for real source-free generation, editing, furnishing,
connected navigation, replay and recovery. It does **not** pass generated-image
geometry consistency or requested AI camera fidelity, nor the separate complete
fantasy/nonfantasy world repetitions. Those quality limitations are preserved
explicitly; no failed artwork or video was selected and no extra reroll ran.
Changes remain local and uncommitted.

Final cleanup stopped both isolated projects without removing volumes. The
pre-cleanup source environment receipt is preserved byte-for-byte as
`environment-after-restore-before-stop.json`; the active receipt now truthfully
records the original pilot as stopped. Final selected evidence and limits are in
`pilot-final-result.json`. No external app connection, commit, deployment or
publication occurred.
