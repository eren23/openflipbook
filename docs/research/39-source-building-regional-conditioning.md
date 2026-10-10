# 39. Source building identity at the street camera

Date: 2026-10-05. Status: both polished source-family street images are now
server-measured, reviewed and selected. A new five-second, four-metre walking
preview using those exact images is saved and playable. The four building
families remain recognizable, but intermediate Bookshop door/window topology
morphs; the clip remains unaccepted and the longer walk is unfinished.
Current read-only local browser checks did not reproduce visible map flicker.

The previous controlled Flux test passed the camera measurement but produced
generic buildings. It received the original map as one global appearance
reference. The four reviewed building crops were provenance checks, not four
regional provider inputs. Camera registration alone therefore did not establish
the identity of the Bookshop, Inn, Forge and Conservatory.

## Original inputs, with explicit region bindings

`apps/web/scripts/source-identity-pilot-pack.mjs` exports an owned saved world
through GET requests only. It verifies the preserved original JPEG bytes,
reviewed crop rectangles, unchanged scene revision 3, original camera requests,
saved view metadata and all four pass hashes for both existing cameras. The
original source happens to have a `.png` filename; encoding is determined from
the bytes. Neither source nor geometry is regenerated.

The pack contains four original building crops and four separate, opaque,
688 × 384 visible-object masks per camera. Each crop/mask pair carries the same
stable canonical object ID. Changed revisions, replacement IDs, changed camera
matrices, swapped crops or altered pass bytes fail validation.

The actual local pack is
`test-results/fantasy-fresh-rhWGis/source-identity-pack-r3/pack.json`, SHA256
`1f2c4a310372ce92e7468ce1cef70305b85eee1bac92195d4e659a4c7a78eee8`.
Its first-camera visible region sizes are 46,071 / 7,349 / 37,302 / 6,952
pixels for the Bookshop / Inn / Forge / Conservatory. Eight exporter tests
passed, including independent original approval snapshots and the production
saved-input fingerprint comparison. The real export made no API writes or
provider submissions.

## Deterministic source surface projection

`apps/web/lib/source-art-projection.ts` accepts explicitly authored planar
surface correspondences. A target-camera ray must meet the authored plane,
the saved depth, the exact object mask, and optionally the saved normal pass.
Only an opaque, valid original source pixel is copied; unsupported pixels retain
the saved render. Source-pixel and surface-index maps permit independent byte
verification. This is a planar projection, not a recovered complete 3D scene.

The first local prototype authored four street-facing wall planes. Complex
roofs, protruding signs, window interiors and unseen architecture remain
unsupported. Source annotations exclude parchment occlusions. These authored
correspondences remain drafts and have not been approved as keyframe artwork.

| Building | Camera A source coverage | Camera B source coverage |
|---|---:|---:|
| Mossbound Bookshop | 84.06% | 86.60% |
| Glassroot Inn | 39.39% | 34.03% |
| Lantern Forge | 59.40% | 68.44% |
| Tideglass Conservatory | 25.27% | 23.46% |

The two cameras are the original four-metre pair. The prototype copied 65,533
and 62,642 exact original pixels respectively. Independent counts found zero
changed protected channels and zero differences from the indexed original
source pixels. The comparison still shows obvious unsupported proxy geometry;
it is evidence of preserved source details, not a finished fantasy street.

Private review images are in
`test-results/fantasy-fresh-rhWGis/source-projection-1791183427325/`:
`source-planes-review.png` and `two-view-projection-review.png`.
Seventeen focused projection tests and the existing 27 warp tests passed.

A subsequent six-plane draft adds only source-visible parts of the Inn and
Conservatory's south walls, with source occlusions excluded. It raises Inn
coverage to 52.63% / 48.59% and Conservatory coverage to 47.38% / 47.77% in
the two cameras. It changes no previously supported source samples and loses
none. Bookshop and Forge coverage are unchanged. The latest partial comparison
is `source-projection-expanded-1791184357993/two-view-projection-review.png`;
its unsupported gables, openings and roofs remain visibly unfinished.

## Local regional model experiment

The isolated local test under
`apps/modal-backend/scripts/source_identity_local/` uses pinned SDXL,
IPAdapter Plus and one Xinsir Union ControlNet, with each building crop supplied
to its matching output mask. In the pinned Diffusers implementation,
`IPAdapterAttnProcessor2_0` multiplies each image-attention contribution by the
corresponding downsampled mask. This provides regional conditioning, not an
exact final-pixel boundary or a guarantee of architecture preservation.

Model weights are selectively downloaded outside the repository, with immutable
revisions and SHA256 checks. The verified download totals 12,825,932,798 bytes.
Inference is offline, outputs remain unaccepted, and no existing app generator,
camera gate, world or video is changed. The normal model-offload launcher has
an available-memory preflight; CPU and MPS share this Mac's physical RAM.
An execution path must fit the current machine before any inference can run.

A tiny actual Metal/disk-offload probe passed three repeated forwards with zero
absolute difference from its resident reference and preserved the real regional
attention processor. It loaded no pretrained models and peaked at about 321 MB
process RSS. Its receipt explicitly says that full SDXL memory fit is unproven;
this probe does not authorize bypassing the normal 11 GiB preflight.
The private receipt is `local-mps-disk-probe-01/receipt.json` under the same
evidence root. Diffusers documents
[group offloading to disk](https://huggingface.co/docs/diffusers/v0.35.0/optimization/memory).

The first full launch reached denoising but failed because PyTorch's
`MultiheadAttention` reads its child output-projection weights functionally.
Ordinary leaf hooks therefore left those weights on CPU. The pinned
`disk_groups.py` groups that attention module and all its descendants together,
while retaining ordinary leaf groups elsewhere. A second actual Metal probe
using the real Union residual-attention block and regional processor passed
three bit-identical forwards. No attention processor was replaced.

The corrected first-camera run completed in 326 seconds at 688 × 384. All 70
regional processors received the four exact spatial masks, across 1,750 calls.
Recorded stages had at least 3.58 GiB available physical memory; a live guard
remained active. This demonstrates one complete bounded local execution, not
universal hardware capacity or image quality. The separate execution profile
declares FP32 VAE tiles of 256 pixels, staged disk loaders and a 3 GiB MPS limit;
the standard 11 GiB launcher floor remains unchanged.

The actual candidate SHA256 is
`ecf80be2c67db91aca3f912124345e0569d57a949ccef6ec10a1b1d0e715f6dd`.
Visual review rejected it: the Bookshop became a flat green facade with small
rectangular windows, the Inn became generic masonry, the Forge lost its open
hearth, and the Conservatory became a generic glazed gable box. Regional
references affected colors and materials but did not preserve architecture.
The ground and overall rendering also lacked the original fantasy detail.

The immutable output, execution receipt and rejection are in
`local-regional-disk-02/`. No paid camera measurement, app import or acceptance
followed this failed content review. A separate experiment used the verified
partial source projection as its initializer, with strength 0.45 instead of the
frozen original 0.85. It completed in 171 seconds, but also failed content review:
the Bookshop became brick and ivy with rectangular cutouts, the Forge lost its
hearth, and the far buildings lost their original identities. The street still
retained flat proxy ground and sky. Its candidate SHA256 is
`274eaba66f8fddd5d11ffac92f73f9f9a6d9974e4d318d9a8c8831cc1fdbea50`,
preserved with its rejection in `local-regional-projection-03/`.

The input proof establishes original pixels before diffusion; it does not
establish their survival afterward. Neither local candidate is eligible for
video. Arbitrary saved proxy window recesses also interrupt the original book
window and hearth in the deterministic projection. Further work needs explicit
source-preserving completion or a separate visual facade interpretation, rather
than another unchanged model retry. Draft source registration remains unapproved
and cannot itself qualify an anchor.

Before the built-in draft camera check, the previous paid pilot held $4.45 and
had $0.55 unused. One subsequent SAM check holds another $0.01, bringing the
current total to $4.46 with $0.54 unused. These are held allowances, not invoices.
No new Fal image generation or walking video has run in this experiment.
Both camera and architectural review remain necessary before accepting anchors
or generating a walking video.

## Source walking draft and built-in image edit

A separate local walking study at `http://127.0.0.1:35715/` paints continuous
facades with the original source artwork. It removes the arbitrary proxy window
cutouts from this visual interpretation, preserving the books and hearth during
movement. The original map can be shown beside the walk; a draft layout minimap
uses the actual four footprint IDs and camera position. The original canonical
scene, saved views and pass evidence are untouched.

Playwright verified the two original camera positions, forward/reverse movement,
release freeze, automatic stop at the four-metre endpoint and pause on blur.
Three idle canvas captures have identical hashes. This is a visual draft with
baked flat facade artwork, repeated known sides, authored roof/sign/glass details
and tiled paving. It is not complete reconstructed architecture or an accepted
walking video. Files are in `fantasy-fresh-tools/source-walk-visual/`.

That study now includes a playable 8.4-second H.264 MP4 in
`walk-export-1791192587967/source-painted-walk.mp4`, SHA256
`9a408103551ca01a90841f2fe23718695285ca0516a4c4a8f931e69c231c1fa3`.
It starts with the original map comparison and records actual continuous browser
movement from A to B. Root reviewed decoded frames 1, 3 and 4. Browser playback,
seeking and exact HTTP byte ranges passed; the preview includes a Watch walk
button. This is an export of the source-painted draft, not AI-generated footage
or accepted artwork. A separate optional 35-metre walk reaches z8 with verified
stop/release/blur controls and identical idle captures. That far end remains
visibly unfinished, so it has no presented long-walk video.

One built-in `image_gen.imagegen` edit used the partial source projection as the
target and the original map as the architecture/style reference. Visual review
found the book-filled arch, moth sign, open hearth and faceted glass crown
recognizable. The original 1678 × 937 output is retained in
`builtin-source-street-01/candidate-original.png`, SHA256
`733f4303fe90730c219ee252eb1ac720e600aa7c46e64ffcbaee98afea04f792`.
The exact prompt is saved beside it. This is a separate built-in-tool draft,
not a Fal/Nano/Flux output or a camera-passed asset.

For a separate owner draft, one width-only resize to 688 pixels rounded the
ideal height 384.181168 to 384; no crop or warp was applied. The raw output is
preserved and this normalization is declared separately. The exact JPEG SHA256
is `89de097b60ee07fddf762ee2d7e30bd00766dc2cdbd6c5ed3321f5209ced96aa`.
One SAM measurement of that same JPEG failed the unchanged Bookshop gate:
IoU 0.73069, horizontal centre -0.00392, vertical centre -0.06931, area ratio
0.82269. The permitted centre offset remains 0.03. It stays unaccepted, with no
app import or new video. Independent identity review found recognizable source
features, but proportions/openings and street layout were reinterpreted.

The free composition experiment completed in `builtin-source-restored-01/`.
Its PNG master restores all 68,043 verified original source-supported pixels;
the remaining decoded completion pixels are unchanged. A separate JPEG preview
is explicitly lossy. The original generated image and failed measurement remain
untouched. Visual inspection rejected this composite: mismatched bases and
roof/wall joins remain, and the generated hearth duplicates the restored hearth.
No second SAM call, import, acceptance or generated walk was made for it.
Pixel provenance alone does not establish coherent architecture.

After recovery, a second built-in edit included the exact structural guide with
the source projection and original artwork. It improved the Bookshop's ground
contact and produced coherent continuous walls, but invented a second Forge fire
and a small extra house beyond the Inn. `builtin-source-geometry-02/` preserves
this rejected draft. A narrowly targeted edit removed those two additions while
retaining the source-position arched hearth and other building details.
`builtin-source-geometry-03/candidate-original.png` is 1678 × 937, SHA256
`008be74eefa0e6ec545809d19892f82d6dc5e2186a7dc5eeed94b9b01048f1a7`.
Its prompt is saved beside it. A separate width-only normalized 688 × 384 JPEG,
SHA256 `2a7719b47b7c880d4a017bda44c26c3a2c2061e685bdb097f50cd5f5f0bbf5a8`,
passed the unchanged primary Bookshop camera check: IoU 0.90010, centre x
-0.00555, centre y -0.01302, area ratio 0.95016. This was one actual SAM request
on those exact JPEG bytes; no crop, warp or changed tolerance was used. The
separate proof is in `builtin-source-geometry-gate-03/`. Independent visual
review found the four identities recognizable, with remaining architectural
interpretation in bay/door proportions, Inn details, glass crown/footprint and
fountain depth. This private draft/measurement is not itself an accepted asset.
The original source, camera evidence and old measurements are intact.

The local frontend was rebuilt into a separate preserved distribution before
switching its owned process. The owner-local artwork import route is now live
at port 35704, with the worker unchanged. The runtime refresh itself performed
no artwork import or acceptance.

The exact first-view JPEG was subsequently imported through the owner route as
an unmeasured draft (`local_931f165e-4ecf-47b8-aa80-25199a08a7bc`). Its final
comparison initially mistook the expected internal `view_capture_fence` increase
8→10 for a scene change. A separate GET-only completion verified the preserved
acknowledgement and identical stored JPEG, source, camera and all four passes;
only that operational counter changed. No duplicate import was made.

New owner-local verification is now available through a source-bound $0.01
quote. The server reserves and durably claims one SAM request, rechecks saved
source/ROI/pass/JPEG bytes, and creates an immutable measured derivative while
preserving the imported original. Unknown acknowledgements cannot resubmit.
UUID collisions and source/ROI changes are rejected before an eligible result;
later legitimate owner review remains readable. 56 related tests, TypeScript,
scoped lint and independent review passed. The owned frontend was rebuilt again
with the worker unchanged.

One actual trusted check of the first imported JPEG passed with the same metrics.
After root's visual review of the exact final JPEG and source identities, the
existing owner selection route selected the derivative
`local_verified_eea13c46200c23eb_a0ba972e-e4bf-4a97-b6c5-3f18b16f43f1`.
Its owner review binds the exact JPEG hash. The original import stays unmeasured.

`builtin-source-camera-b-04/` completes the second ordinary saved view with the
first painted view as a separate appearance reference. Its raw SHA256 is
`8f5f32fe72b2dc4f571dd7d522c3a8b6e0ceec9f2c1d7d16f276333a12133062`;
the separately normalized JPEG is
`e27b330913c8a70479de6e9dd16160be2b5b5a9fe99f5c6ab40d831111bca09e`.
Independent review found recognizable continuity, but its one crop/text SAM
request returned no usable mask. No IoU/position metric is available; it remains
unaccepted. A full-frame visual-prompt alternative is being investigated without
changing the failed receipt or gate thresholds. No polished walking video has
been generated. Held pilot reservations are $4.49 of $5, leaving $0.51 capacity.
The two painted images and original map are visible at
`http://127.0.0.1:35715/street-artwork.html`.

After the next recovery, the second exact JPEG was imported through the same
owner route as `local_7350198f-653b-4f31-8a5d-aa481f75456c`. The free import
checked its stored 230,870 bytes and SHA256 without normalization or provider
calls. It remains unmeasured and unselected. Canonical source, scene, camera and
passes stayed unchanged; the separately checked operational capture fence
advanced 13→15 as expected. Evidence is `builtin-source-camera-b-import-04/`.

The opt-in full-frame SAM profile passed 257 backend tests and independent review.
Its separate B05 check used the same JPEG with positive/negative points derived
only from the saved object pass. It returned the intended Bookshop mask, but
failed the unchanged camera limits: centre y −0.05094 and area ratio 0.77147
(IoU 0.71126). The old null-mask result remains intact. Most missing pixels were
in the lower Bookshop wall, obstructed or replaced by steps and planter clutter.
A new built-in local edit, `builtin-source-camera-b-geometry-06/`, rebuilds that
foundation while keeping the other three buildings. Its normalized JPEG SHA256
is `ad9f6f7f0abc4723f269bf336d04c5c475b69565ce0243969f6d695b99d9ff60`;
it remains unmeasured and unselected pending a distinct check. Held pilot
reservations are now $4.50/$5.

Read-only browser checks covered the comparison gallery, editor Plan/Reference,
spatial World map, saved A→B→A camera switching, and `/play` source-map/atlas
pan and zoom. No visible flicker or script/HTTP errors were reproduced. Layout,
DOM and camera state stayed fixed; a few raster-edge pixels varied by at most
one RGB unit. Initial presence/metadata writes in `/play` were blocked before
network submission. The checks did not change the owner world or submit models.

B06 improved the vertical error but still failed: centre y −0.03553 and area
0.78545. A further local wall-width repaint, `builtin-source-camera-b-geometry-07/`,
preserves the same source family with a partially clipped book-filled bay. Its
unchanged normalized JPEG SHA256 is
`4883e3434a2d3971600a054f1f2f6a208917dd645960904fd700f81b8c3cd5b1`.
The separate B07 full-frame check passed: IoU 0.83396, centre x −0.00586,
centre y −0.02057, area 0.95626. Earlier failures remain intact. This private
measurement does not itself select or verify a production asset.

The app's opt-in trusted visual verification now derives and checks the same
geometry and point proof server-side, binds the selected profile in the quote
and durable claim, and preserves existing default/A replay. 52 related tests,
TypeScript, lint and independent review passed. The owned frontend is refreshed
at port 35704 (PID 37427, build `fv7g9aOjKXGLYgU2hqxDn`); the worker stays
unchanged. B07 import, trusted verification and owner selection are pending.
Held pilot reservations are $4.52/$5.


B07 was subsequently imported through the normal owner route with its exact
233,298-byte JPEG preserved. One trusted full-frame check passed the unchanged
camera thresholds and created measured derivative
`local_verified_9eedab9b622cd538_c148a88f-0f0d-4d01-8153-151d524e906b`.
After reviewing the final stored JPEG, the normal owner review selected that
derivative for camera B. The original import remains unmeasured. Evidence is
`builtin-source-camera-b-import-07/`, `owner-local-verify-b07/` and
`owner-review-b07/`; earlier failed images and receipts remain intact.

One accepted-only-v1 H3 submission used the exact selected A03/B07 JPEGs,
without paid keyframe generation or automatic retries. Job
`3c41240e-800c-4921-a9dd-0c192cca5239` completed and its owner library reopens
the same 1,375,923-byte MP4, SHA256
`c60b97d7d4fb424cd1ecfd10e94e0ddb68d846f83504911e76da570afd032fb0`.
It is five seconds, 688 × 384, 24 fps, and decodes fully. Twenty temporal
samples retain forward motion, four recognizable building families and one
Forge hearth. Around seconds 1–3 the Bookshop door/window ordering morphs;
exact intermediate architecture is not established. The clip is a preview,
not an accepted full film, and does not complete the longer 35-metre walk.
Evidence is `source-consistent-accepted-walk-01/`.

The private player at `http://127.0.0.1:35715/street-walk.html` serves that
actual MP4, supports W/S scrubbing with release/blur pause, endpoint controls,
and native playback. It shows both reviewed endpoint paintings, the original
map, and an explicitly approximate progress schematic. Browser checks passed
full playback, seeking, HTTP ranges, mobile layout, stable paused frames and
zero script errors. The actual owner Walk video library also played and paused
the saved clip in a GET-only browser check. Player evidence is
`apps/web/test-results/fantasy-fresh-tools/source-walk-visual/street-walk-verification.json`.
The updated comparison gallery is `http://127.0.0.1:35715/street-artwork.html`.

Held pilot reservations are now $4.93/$5, with $0.07 remaining. This includes
the one $0.40 walking-video reservation; it is a reservation estimate, not a
provider invoice. All code and evidence remain local and uncommitted.


## Continuation: walking controls and reviewed long-route support

The saved walk library now uses the production `SavedWalkPlayer` for walk
videos. Focused W/S or arrows and held Enter on the direction buttons move
through existing video bytes; real mobile touch holds work too. Release,
focus/tab loss, endpoint limits and changing clips pause safely. Consumed
walking keys do not move the underlying 3D camera. Native controls remain;
progress reports clip seconds rather than an invented calibrated map position.
Motion-study path-video playback is unchanged.

New opt-in `accepted-route-v1` supports 2–12 ordinary reviewed 688 × 384
camera artworks, with a five-second leg per adjacent pair. Every selected JPEG,
camera, source map and exact-image review is bound before quoting, scheduling
and every paid claim. It generates no replacement images and reserves no paid
retry. Missing, stale or changed anchors stop before spending; failed legs
preserve their work and stop later legs. Complete clips can only resume free
media reconstruction. Existing `accepted-only-v1` two-anchor receipts and
quotes remain compatible. Archive/export/import preserve full route evidence
as inert playback records, with no executable claims or fresh attestation.

Illustrated route preparation can explicitly save an ordinary camera at every
checkpoint for artwork review, and automatically chooses the reviewed-only
policy after those saves. Existing automatic-paint preparation remains a
separate explicit choice. These controls do not certify every generated
intermediate video frame as architecturally exact.

Four fresh scene-r3 ordinary cameras were saved at x24/y1.6/z35,31,27,23,
all north-facing/FOV60/688 × 384. With reviewed A(z43) and B(z39), their six
camera positions cover 20 metres. All 16 new stored geometry passes reopened
with exact hashes. The old r2 checkpoints remain historical; source pixels,
scene definitions, accepted A/B JPEGs and their selected IDs are unchanged.
The capture-only operational fence increased 24→28. The new four views have
no painted or reviewed artwork. The Inn is the largest visible building
already at z35, so further camera checks must not force the Bookshop after it
leaves the view. Evidence: `current-forward-route-03-1791208200000/`.

The owned frontend and idle worker were refreshed to build
`4FdSmJV6nG7GW18Ukpn9C`, frontend PID64612, worker PID65429. The new worker
advertises both reviewed-route and existing two-anchor capabilities. Full
source scene/view/artwork/reference records and all 27 current source/pass/
selected-image blobs matched before and after, as did the paid ledger and
saved video jobs. Two failed worker-helper preflights left the original worker
running: they exposed an omitted terminal `invalid` build state and two
historical 688 × 384 cameras. The corrected checks classify that preserved
invalid receipt as terminal and bind the exact current six-camera inventory.
Failed evidence remains intact; no in-flight work was interrupted.

223 focused web tests across eight suites, TypeScript, scoped lint, independent
reviews and a clean isolated production build passed. Real owner browser/API
checks verify W/S release, held Enter, mobile touch/release, 390-pixel layout,
map return, range playback, zero writes and zero page errors. A live six-camera
reviewed quote correctly returns no price with “Camera 3/6 needs reviewed
artwork bound to its current camera and source map.” Both two-camera policies
still return the same $0.40 quote and accepted-anchor fingerprint. Evidence:
`reviewed-route-live-1791209024034.json` and
`saved-walk-controls-qa-1791208950857/receipt.json`.

No new paid generation or video ran in this continuation. Pilot reservations
remain $4.93/$5. The original five-second/four-metre preview still has visible
intermediate architecture morphs. The prepared 20-metre route is not yet an
illustrated long-walk video; it needs four reviewed paintings first.


## Delivery correction: browser ownership

The initially sent native editor link did not show the walk in an ordinary
browser. Its HTML was 200, but the scene/library requests returned 403 with
“This world is not owned by this browser.” The test-owner session worked.
Omitting the camera parameter also selected the latest unillustrated camera
for that owner session. Actual evidence is `entry-access-qa-1791210479041/`.
This delivery failure was separate from the saved MP4 or route-generation code.

The existing loopback preview now opens the illustrated walk at
`http://127.0.0.1:35715/` without needing that private test cookie. It bundles
and mounts the exact production `SavedWalkPlayer`, SHA256
`965783d6854968b5fb14fc32d796dde53e9bb084e72a74e220ae89271c55b994`,
with the unchanged five-second MP4, original source and reviewed paintings.
It reports the prepared 20-metre route honestly as missing four paintings.
The prior rough geometry page remains byte-identical at `/draft-walk.html`,
and the prior manual-player HTML remains at
`/street-walk-before-native-player.html`. Main-app ownership checks and world
publication state are unchanged. Entry bundle evidence is
`apps/web/test-results/fantasy-fresh-tools/source-walk-visual/native-player-build.json`.
No new video, image generation or paid call ran for this delivery correction.

Final anonymous desktop/mobile verification is
`source-walk-visual/native-landing-qa-1791211338758/receipt.json`. The preview
server now serves stylesheet files as `text/css`; production controls now
reference a defined `savedWalkActions` flex rule. Keyboard, real touch, release,
blur, full five-second playback, seeking and navigation passed without owner
API requests, failed network requests, console errors or horizontal mobile
overflow. Three paused screenshots were identical. 32 focused player/path UI
tests and scoped lint passed. This corrects delivery and controls layout; the
video itself and the remaining long-walk/architecture limitations are unchanged.

The same controls CSS fix is also live in the isolated main frontend build
`6tKTmUVF6r-DYUsKVE3tN` (PID 73884); worker PID 65429 is unchanged. The
clean build and source-hash checks passed before replacing the owned listener.
Receipt: `owner-entry-recovery-runtime-1791211348725.json`. The main editor
continues to require its owning browser; the anonymous delivery link is the
loopback preview above. No application or provider writes occurred.

## New next-street concept preview

At the user’s request to see something new, one built-in imagegen call produced
`source-walk-visual/assets/next-camera-c-concept-v1.png`, intended as the next
eight-metre street view. Inputs were the original map, exact saved camera-three
geometry, and the older B04 painting (`polished-camera-b.png`). This last input
is a legacy reference, not the current selected B07. The image is a new painting,
not a crop of an earlier view. The Inn and Conservatory are larger and the
Bookshop/Forge move to the edges, but façade openings change and exact saved
camera alignment is unverified. It has not been imported, selected or trusted.
No new video or paid-pilot provider call ran; existing world and pilot cap are
unchanged. Exact prompt and input/output hashes are saved in
`next-camera-c-concept-v1.prompt.txt` and `next-camera-c-concept-v1.json`.

## Photo origins on the map

The loopback `map-photo-origins.html` explorer links the original painting to
six saved camera positions, spaced 4 metres along the 20-metre route. A03 and
B07 are the two reviewed endpoints at 0 and 4 metres. Legacy B04 is a separate
variant at the same 4-metre camera. The new concept targets camera three at
8 metres; its exact camera match remains unverified. Checkpoints at 12, 16
and 20 metres show their exact saved layout renders, not finished paintings.

All six saved cameras have x=24, y=1.6 and z=43/39/35/31/27/23, facing −Z.
The camera plan uses those coordinates and the saved scene footprints.
Horizontal field of view is 91.938527 degrees and vertical field of view is
60 degrees, derived from each saved projection matrix. Markers/arrows over
the original painted map are manually placed approximate street positions;
existing per-wall draft correspondences do not provide a global ground-plane
calibration. The explorer makes this distinction visible rather than claiming
recovered camera positions in the painting. `map-photo-origins.json` stores
the complete mapping and exact image hashes; data verification and independent
read-only review passed for all six poses and eight image variants. The
standalone walking player’s Open map link now opens this explorer. No provider
call, image generation or world write was needed.

Final anonymous desktop/mobile QA is
`source-walk-visual/map-origins-qa-1791213428019/receipt.json`. After visual
inspection, approximate overlay revision 2 moved the initial harbor point from
water to the paved approach. The exact scene coordinates and image bytes did
not change. Marker/plan selection, all eight image variants, keyboard focus,
photo links, player Open map/return navigation, mobile layout and stable idle
frames passed with zero page/console/resource/API errors. Prior screenshots
and receipts are preserved as historical drafts.
