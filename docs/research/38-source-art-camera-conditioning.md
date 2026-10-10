# 38. Source artwork at a saved street camera

Date: 2026-10-04. World: the freshly generated Glassroot Quarter harbor map.
Model: `fal-ai/qwen-image-edit-2511`. Two first-camera jobs, each with a
$0.10 reservation for two candidates and their SAM measurements. Neither
result was accepted. These are reservation amounts, not a provider invoice.

The material-crop reference improved the viewpoint and visible fantasy detail,
but it did **not** establish a geometry-consistent first keyframe. The strict
camera gate remains unchanged, and no canonical walk video was generated from
either failed result.

Both jobs used the same saved camera, 1024 × 384 render, object identities,
appearance description and original artwork. The saved input hash was
`414bb8134ffed615c87642822ad4568ec85a150e0de013fe8c8a90b6ad566c5a`.

## Actual results

| Conditioning | Candidate | IoU | Centre x / y | Subject area ratio | Camera gate |
|---|---:|---:|---:|---:|---|
| v4: render first, full aerial artwork second | 0 | 0.281174 | +11.87% / −12.51% | 0.428037 | Failed |
| v4: same request | 1, stored | 0.285097 | +11.63% / −12.41% | 0.427860 | Failed |
| v5: render first, material crops second | 0, stored | 0.735615 | −2.67% / −2.83% | 0.744869 | Failed |
| v5: same request | 1 | 0.133086 | +17.30% / +1.99% | 0.187870 | Failed |

Visual inspection found that v4 copied the aerial composition and parchment
labels despite explicit camera-authority wording. The stored v5 image was a
ground-level cobblestone street with detailed masonry, timber, lanterns,
plants and coloured roofs. It still changed the measured building silhouette
and generated garbled sign lettering despite the negative prompt.

The gate uses a centre tolerance of 3%, area ratio from 0.8 to 1.2, and a
minimum painted difference of 12. IoU is a reported diagnostic, not a separate
minimum threshold. V5 candidate 0 satisfied the centre and painted checks,
but its area ratio was below 0.8. A visually appealing draft therefore remained
unaccepted and ineligible as a verified chain source.

## What changed in v5

The second image became sixteen small crops taken from the original artwork,
with neutral gutters and a rearranged order. Source pixels were retained
without resizing. Crop selection avoided visible parchment strips and the
overview horizon in this actual source. The reviewed 552 × 552 sample sheet
contained stone, timber, glass, roof tiles, lanterns, moss and water without a
coherent aerial layout or visible labels.

The original source hash stayed pinned:
`63f3112ad1d64500be656d402c0a7a65398fb4fce14ffd1113ef1f80771e53c8`.
The reviewed atlas hash was:
`11b565dbebad510f5173019dd891627ed46c50d14dba3e16499beb4c63052a4e`.
The actual asset's `reference_preparation` matched the reviewed metadata,
including both hashes, source/output dimensions and every crop rectangle.
The worker checks recomputed preparation against the saved job before submit.

`saved-camera-qwen-keyframe-v5` also pins the supported negative prompt for
aerial/isometric composition, grids, lettering and parchment banners. The
[published Fal schema](https://fal.ai/models/fal-ai/qwen-image-edit-2511/api)
provides `image_urls` and `negative_prompt`, without a per-image geometry/style
weight. This input remedy is an empirical improvement on one world and camera,
not a documented guarantee of camera or place-identity preservation. The
atlas and negative prompt changed together, so this trial does not isolate
their individual effects.

## Preserved local evidence

Private ignored evidence is under
`apps/web/test-results/fantasy-fresh-rhWGis/`:

- `media-keyframe-1791127620346-14145a0d/`: original v4 request, job,
  asset, output, screenshot, trace and uncut browser recording.
- `media-keyframe-v5-1791128694569-8c47c524/`: separate v5 request and
  the same evidence types; the original action was retained.
- `source-art-material-crops-v1.png` and `.json`: reviewed atlas and exact
  preparation metadata.

The copied JPEGs were independently hashed against their saved assets:
v4 `956db0e5740c4f75ab072d012f462ef32b47e913fb30e3d93f6a4f7f66e6650a`;
v5 `a33cd222505eeabca5d1f5d89e770d023e33f713563a5c478ce0e6cdf50a209a`.
Both receipts report `camera_gate_passed: false` and
`content_accepted: false`. Provider completion means that bytes are stored;
it does not mean that those bytes passed the camera or content review.

The later native image-first street clips were also rejected as a mapped walk:
they put the Inn opposite the Bookshop, whereas the source has both on the
left. Their files and receipts remain historical evidence, not a verified
map-to-street demonstration.

## Named landmarks and structural controls

Four subsequent Nano Banana Pro trials used reviewed whole-building crops
from this same source, then exact saved-camera mask contours and depth. None
passed both camera and four-building identity review. Their held ceilings
were $0.30 each; none was accepted or used for a new video.

| Trial | IoU | Centre x / y | Area ratio | Reason retained as a draft |
|---|---:|---:|---:|---|
| Map + four crops | 0.6461 | +3.39% / +1.57% | 1.3139 | Enlarged foreground and Conservatory |
| Explicit saved bounds | 0.7531 | +0.75% / +3.95% | 1.2596 | Foreground Conservatory and facade drift |
| Registered contours + depth | 0.8029 | +0.84% / −4.46% | 0.9486 | Correct order, failed vertical registration |
| Source-reviewed roof/hall estimates | 0.6589 | +2.40% / +4.61% | 1.5088 | Conservatory obstructed street, wrong Inn sign |

The source-reviewed geometry revision changed only four total heights and
four roof heights. It retained footprints, doors, windows, route cameras and
the Bookshop's 46,071-pixel target mask. These are authored estimates from the
map, not a recovered metric reconstruction. The generic Conservatory still
lacks the source's faceted glazed envelope, and the fountain and dock are not
reconstructed. Camera thresholds were not adjusted to fit failed images.

A separate opt-in Flux General image-to-image profile now uses the saved
render, untouched depth, and a pure opaque black/white edge PNG derived from
the actual saved render and object pass. The annotated identity overlay is
retained for review and is never used as the edge control. The original map
is the scalar appearance reference; the four reviewed crops remain mandatory
source provenance, but this model does not receive four separate references.
The [Fal API](https://fal.ai/models/fal-ai/flux-general/image-to-image/api)
supports simultaneous Union depth/canny controls and `reference_image_url`.

The profile fixes seed 42, 28 steps, strength 0.7, reference strength 0.65,
ControlNet Union conditioning 1 from 0 to 1, one JPEG, and a $0.15 held ceiling.
No IP adapter or real CFG is enabled. The saved camera requests 688 × 384;
actual original output must be upright JPEG at exactly these dimensions.
Raw bytes are archived before SAM, and the same bytes are gated and stored.
No crop, stretch, normalization or implicit chain is allowed for this profile.
A fixed seed does not establish identity across different cameras. Structural
conditioning is not a guaranteed geometry lock: the camera gate and a manual
review of all four landmarks remain required before acceptance or video.

The first Flux pilot ran once through the product UI and was rejected.
The original JPEG and gated final candidate are identical (150,687 bytes,
SHA `e1d2b7d781020ac241656ac890b08d03fc3362bc7d2594f5f4865ed78d711d87`).
It preserved a block-like street envelope but remained a blurred flat restyle,
without books, moth emblem, forge hearth or glazed Conservatory. SAM found no
building mask, so the camera gate failed. It is not accepted or eligible for
video. Evidence: `flux-keyframe-1791144431373/` beneath the private directory.
A second, explicitly enabled `saved-camera-flux-reference-controlnet-v2`
profile retained the same source, camera, seed, reference strength and strict
gates, but used the Union model card's simultaneous-control example scales
(depth 0.2, canny 0.4) and Fal's default image-to-image strength 0.85. The
v1 contract remains unchanged. This was one diagnosed test, not a seed reroll.

V2 passed the silhouette gate: IoU 0.988974, centre −0.05% / −0.14%, area
0.988974, painted difference 27.303. It was nevertheless **rejected for
content**: the source's projecting book window/stacks, carved moth emblem,
open forge hearth and transparent faceted Conservatory were all absent.
It remained a dark/red flat scaffold restyle with generic windows and a faint
invented block skyline. Original raw and final JPEG bytes matched exactly
(171,590 bytes, SHA
`fe56ec09e70407622061619f1e77f455ed6d27000ef91b495f419b0167bf67ba`).
Evidence: `flux-keyframe-1791145159850/` beneath the private directory.

This confirms research 36's limitation: a passing silhouette and a changed
pixel average do not verify authored fantasy content or map identity. Neither
Flux result was accepted. The second camera and video were not submitted.
Further paid trials stopped. Aggregate held ceilings are $4.45 of the original
$5 cap; $0.55 remains unused. No matching route video has been produced.

## Accepted images as video inputs

The explicit `accepted-only-v1` walk policy now accepts exactly two ordinary
688 × 384 saved cameras with reviewed original JPEGs. It pins their ordered
asset IDs, byte hashes, camera/dependency hashes, source-map hash and review
hash separately from the existing `views_sha256`. Quote, scheduling, worker
claim and recovery recheck both anchors and the current source map. A fresh
worker capability is required. This policy generates no replacement images,
quotes one five-second H3 leg at $0.40, and carries zero paid retry allowance.
Failures and ambiguous submissions preserve existing work. Recovery may only
rebuild storage from a completed, verified original, after source checks.

The UI exposes this policy only for a two-camera walk. Export/import retains
both exact anchors and the independently sized original source artwork;
archives remain playback evidence. An actual 2048 × 1152 map versus 688 × 384
anchor roundtrip is covered. The focused verification passed 269 web tests,
TypeScript, lint and independent review. Provider completion is labelled
“draft ready for review” in the illustration UI.

This is an implemented input/provenance guarantee, not an empirical claim
that H3 preserves facade identity throughout an interpolated clip. No real
job was submitted for these failed drafts, and no second Flux anchor was
charged. A successful source-faithful first image remains the unresolved
prerequisite for the user's map-to-walk-video goal.
