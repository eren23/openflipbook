# Physical Reference Check

September 9, 2026 (Chicago). Six real vision calls; **$0.0125400825** reported
by OpenRouter, below the separately approved **$1** cap. No generated images,
videos, reruns, deployment or default-flag changes.

## Result

The localization step found the selected physical place in all three sources.
The largest improvement is North Point: the original reference was mostly its
printed label; the new reference contains the lighthouse and attached cottage.
Crystal Lighthouse is more tightly framed around its tower, crystal and annex.
The citadel remains a largely overhead chart, with no meaningful new elevation
evidence. Cropping preserves source pixels; it cannot reveal hidden architecture.

The automatic coverage verifier returned **3/3 passes**. That is **not 3/3 valid
arrival references**: assistant visual review flags the citadel as a false positive
for establishing a ground-level exterior. Its full footprint is visible, but its
vertical proportions and facades are not reliably established. The verifier's
existing roof-only/occlusion warning did not prevent this acceptance.

These are single reference-only trials, not end-to-end generation, a reliability
estimate, a user sign-off, or proof of accurate camera movement. The previous
12-image batch still has zero complete passes; its receipts remain unchanged.

## Before And After

### North Point Lighthouse

| Original Automatic Crop | Proposed Physical Crop |
| --- | --- |
| ![Original crop dominated by the lighthouse label](assets/arrival-reference-pilot/fishing_lighthouse-original.png) | ![Proposed crop containing the lighthouse and cottage](assets/arrival-reference-pilot/fishing_lighthouse-proposed.png) |

Assistant review: a substantial targeting improvement. The tower, lantern,
base and cottage are now inspectable. Margins are very tight at the top and
cottage edge, so the automatic claim of complete unclipped coverage should not
be treated as a pixel-perfect certification. Suitable for further inspection,
not proof of a correct new viewpoint.

### Crystal Lighthouse

| Original Automatic Crop | Proposed Physical Crop |
| --- | --- |
| ![Original lighthouse crop with a large section of cliff](assets/arrival-reference-pilot/harbor_lighthouse-original.png) | ![Proposed crop focused on the crystal tower and annex](assets/arrival-reference-pilot/harbor_lighthouse-proposed.png) |

Assistant review: the original already contained the structure. The proposed
crop retains the crystal, forked crown, tower body, base and attached building
while removing excess cliff. This is the strongest next test reference because
its visible vertical architecture is substantially more informative than a plan.

### Sandstone Citadel

| Original Automatic Crop | Proposed Physical Crop |
| --- | --- |
| ![Original overhead citadel reference](assets/arrival-reference-pilot/oasis_citadel-original.png) | ![Proposed citadel crop still showing the overhead chart](assets/arrival-reference-pilot/oasis_citadel-proposed.png) |

Assistant review: target association and footprint coverage are good, but this
does not establish a faithful eye-level exterior. Do not promote this case from
the automatic pass alone. Keep footprint coverage separate from elevation
evidence in the next verifier iteration.

## Method And Receipts

The same three source images and the first context-first trial's automatic
label, appearance and bounding box were reused from the original saved requests.
Source hashes were checked against both provenance and the original manifest.
No human review boxes or feature annotations were used as model inputs.

Each source received one localization call and one separate verification call
using the actual proposed crop. Both used `google/gemini-3.7-flash`; the second
call did not receive the locator's rationale. Separate calls using the same
model are not independent proof. All six completed, with provider IDs and usage
recorded. No requests were repeated or left ambiguous.

Original/proposed boxes, crop hashes, raw replies, exact requests, provider IDs,
usage and implementation hashes are in the ignored output directory:
`apps/modal-backend/tests/continuity_bench/reports/arrival-reference-pilot/`.
The Desktop copy is `openflipbook-reference-check-2026-09-09`.

## Next

1. Separate whole-footprint coverage from usable elevation evidence. Add this
   citadel false positive to the evaluation set before promoting the preflight.
2. Use Crystal Lighthouse for one bounded standing-height arrival experiment.
   Passing crop inspection is only an input gate; the new image must still pass
   identity, camera, style, detail, arrival checks and visual review.
3. Keep invented geometry explicit and defer video until the destination passes.
   Additional generation requires a new quote and approval; this run used only
   the six approved vision calls.
