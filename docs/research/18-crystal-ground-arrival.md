# Crystal Lighthouse Ground Arrival

September 9, 2026 (Chicago). One image and five vision-judge calls under a
separately approved $1 cap. **Rejected. No reroll, video or publication.**

## Output

![Full unmodified candidate: two near-identical lighthouse panels divided by a black line](assets/arrival-destination-pilot/candidate.png)

Reference used as image 1:

![Automatic physical crop of the Crystal Lighthouse](assets/arrival-destination-pilot/reference.png)

## Result

| Check | Result |
| --- | --- |
| Eye-level camera | 4/10, below the floor of 7 |
| Single target | Fail: side-by-side duplicated scene |
| Nearby / outside / scene rather than map | Automatic pass |
| Identity | 9/10, but assistant review finds architectural drift |
| Medium | 9.5/10 |
| Detail articulation | 8/10 |
| Output dimensions | 1376 x 768; passes the 16:9 rounding tolerance |
| Combined automatic acceptance | False |
| Assistant visual acceptance | False |
| User review | Not yet recorded |

The complete image is a split-screen pair, not one immersive view. The camera
still looks down over the ground and annex roof. The source's open bowl crown
becomes a larger raised-prong arrangement; large buttresses appear around the
tower base, and the annex becomes a substantially different gabled structure.
Recognizable subject matter and similar colors are not sufficient place identity.

The camera and duplication gates correctly rejected this attempt. The high
identity score remains too permissive for the architectural continuity we need.
Framing is the one clear control success here; it does not establish a correct
viewpoint. This component failure does not change or overwrite the previous
12-image batch or the successful physical-target localization observation.

## Method

Reused the hash-verified automatic Crystal Lighthouse crop from the
[reference check](17-physical-reference-check.md), followed by the original map
as a context image. Submitted one `fal-ai/nano-banana-pro/edit` image, 1K, PNG,
explicit 16:9, web search disabled. There was no extraction or planner call.

The fixed prompt requested a camera approximately 1.6 metres above ground,
looking forward or upward, one target only, with no aerial view or inset. It
omitted the shared enter builder's conflicting input-aspect preservation clause.
This is a prompt-driven experiment, not a calibrated or geometry-controlled
camera, not a normal browser-click test, and not a one-variable ablation.

The production strict verification function judged the exact final image bytes
for identity, medium, camera, detail and arrival using `google/gemini-3.7-flash`.
All five calls completed. No image correction ran after judging. The dimension
check was separate and deterministic. No result was saved into a user's world.

## Cost And Receipts

- fal image: $0.15 reserved at the verified API quote, not invoice-reconciled.
- OpenRouter judges: $0.00653994 reported usage.
- Total accounted/reserved: **$0.15653994**, below the $1 cap.
- Image request ID: `01a0891d-550e-7fd0-9617-91fc25a1bb5b`.
- Output SHA-256: `177d5f0817ff839fdeaa0d4cafa9d5c4e631ddcd938f81a61000af6db4bca096`.

The original source, crop, full candidate, prompt, implementation hashes, raw
judge replies, provider IDs and ledger are in the ignored directory
`apps/modal-backend/tests/continuity_bench/reports/arrival-destination-pilot/`.
A copy is on the Desktop as `openflipbook-ground-arrival-2026-09-09`.

## Next Decision

Do not run another near-identical prompt-only reroll or build a success video
from half of this split image. Both would obscure what failed.

The next useful experiment needs independently inspectable structural/camera
evidence: a minimal landmark-specific guide with a known standing-height camera,
not the unrelated quay blockout treated as recovered geometry. Any dimensions
or unseen surfaces authored from the image must be labeled as assumptions.
Verify that guide before quoting another generative call. Separately retain the
citadel's missing-elevation case and this lighthouse's architectural drift as
negative examples for the reference and identity evaluations.
