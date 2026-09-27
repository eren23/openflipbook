# Lighthouse Camera And Architecture Controls

September 9, 2026 (Chicago). Eight image trials and 48 vision calls under the
user-approved $4 ceiling. **0/8 complete passes. No video, publication, merge,
deployment or default change. Paid work stopped at $1.46125254 accounted/reserved.**

The portable comparison is on the Desktop in
`openflipbook-overnight-controls-2026-09-09/index.html`, alongside every original
output, source crop, guide, judge receipt, manifest and ledger. The new local
guide is `/dev/spatial-transitions/lighthouse`, gated by `SPATIAL_STUDY=1` and
unavailable in production. It is not part of normal map navigation.

## What Worked, What Did Not

| Method / seed | Camera /10 | Style /10 | Architecture | Complete pass |
| --- | ---: | ---: | --- | --- |
| Nano + color guide / 521 | 9 | 9 | Fail: crown, annex | No |
| Nano + color guide / 522 | 9 | 6 | Fail: tower base, annex | No |
| Nano + clay guide / 521 | 9 | 9.5 | Fail: tower base, annex | No |
| Nano + clay guide / 522 | 4 | 8.8 | Fail: tower base, annex | No |
| Qwen eye level / 521 | 0 | 10 | Automatic pass | No |
| Qwen eye level / 522 | 0 | 10 | Automatic pass | No |
| Qwen low angle / 521 | 0 | 10 | Automatic pass | No |
| Qwen low angle / 522 | 0 | 10 | Automatic pass | No |

These are model judgments, not measured camera calibration. All eight passed
the output framing and single-target checks. Assistant inspection of all eight
full images rejected all eight as faithful ground-level arrivals. User review
is **not recorded**. The separate [visual review](19-lighthouse-control-review.json)
does not rewrite provider receipts or claim to be human sign-off.

The guide supplied useful viewpoint information: three of four generated views
passed the camera judge, compared with the preceding prompt-only trial's camera
failure. However, this is not a controlled one-variable comparison with that
earlier trial: prompts, input ordering and reference content all changed.

The most convincing guide image is `guide_clay-521`, an illustrated low exterior
with a plausible horizon. It is still the wrong building: the long arcaded annex
has become a small gabled cottage and the tiered faceted base is gone. Color 521
adds extra crown arms. Color 522 has weak surface detail. Clay 522 sits on a
painted ground patch against a flat gray foreground, closer to an isolated
illustration than an inhabitable scene. None is suitable for a success demo.

Qwen retained substantially more of the source-visible crown, base and arcade,
but all four results remain elevated views looking into the crown and onto the
annex roof. Changing its native elevation control from 0 to -30 did not produce
the requested standing-height camera in this input/configuration. The outputs
are not identical pixels: peripheral platforms, columns and vegetation vary.
Judge phrases such as "exact same artwork" overstate what is established.

## The Guide Is Part Of The Failure

This was a landmark-specific Three.js proxy, not the earlier unrelated quay.
It models a tapered tower, open crown, two curved arms, floating crystal and
attached annex. Its dimensions, unseen surfaces and level ground are explicitly
authored assumptions. Camera position is `[12, 1.65, 24]` in assumed metres,
looking at `[0.8, 6.6, 0]`, with a 39-degree vertical field of view for the paid
1280 x 720 guide. A 53-degree mobile view is for inspection only.

**My proxy omitted visible architectural evidence.** Its plain rectangular
annex and simple tower base do not reproduce the source's long arcade or tiered
faceted base. The prompt prioritized guide silhouette/arrangement, so the model
received conflicting architectural instructions. The guide's simplified form
appears in the generated results. That is a plausible conditioning explanation,
not proof of causality; this batch cannot separate model limitations from a
deficient guide. It does not establish that a correct guide would succeed.

The preflight proved rendering, camera placement and framing, but did not prove
architectural fidelity. Next time both checks must pass before paid submission.
The frozen guide and its hashes remain unchanged as evidence of what was used.

## Method

- Reused the hash-verified automatic physical crop of Crystal Lighthouse from
  the [reference preflight](17-physical-reference-check.md). No new extraction,
  planner call, hand-selected replacement crop or app-world write occurred.
- Nano Banana Pro edit: color/clay guide first, real crop second; one PNG,
  1K, 16:9, no web search; seeds 521 and 522 for each guide. The same prompt
  explicitly separates camera/silhouette guidance from architectural reference.
- Qwen2511 Multiple Angles: crop only; horizontal angle 0, vertical 0 or -30,
  zoom 5, adapter strength 1, 28 steps, guidance 4.5, regular acceleration,
  one 1280 x 720 PNG, same paired seeds and safety checking enabled.
- The [fal endpoint documentation](https://fal.ai/models/fal-ai/qwen-image-edit-2511-multiple-angles/api)
  exposes these native angle controls and builds a corresponding angle prompt.
  A learned adapter with numeric controls is not a calibrated physical camera
  or saved geometry. The endpoint parameters are verified; obedience is tested
  by the actual output, not assumed from the parameter name.
- Color and clay differ only in guide appearance within the Nano pairs. Qwen's
  elevation differs within its pairs. Comparing Nano to Qwen is a comparison of
  complete methods, not equal conditioning, compute or model-independent seeds.
- Exported and inspected depth too, but **did not submit depth conditioning**.
  No trajectory-conditioned video, multi-view reconstruction or 3D generation
  was tested in this batch.

Each exact final candidate received the five existing production vision checks
(identity, camera, medium, detail, exterior arrival), plus one pilot-only
architectural comparison against the original crop. Crown, tower body, annex
and single scene must each explicitly pass. Unknown/missing evidence rejects;
a high score on another axis cannot compensate. All calls used
`google/gemini-3.7-flash`, with raw responses preserved.

The existing production verifier accepted two guide outputs despite their
architectural changes, and identity scores were 9-10 for all guide outputs.
The added categorical check rejected all four. This is useful negative-example
coverage, **not a validated general identity judge**: it was designed for this
lighthouse after earlier failures, and it has no independent cross-world
positive/negative calibration. It remains in experiment tooling only.

## Cost And Reproducibility

| Item | Accounted / reserved USD |
| --- | ---: |
| Four Nano images, verified quote $0.15/image | 0.60000000 |
| Four Qwen images, conservative $0.20 reservation each | 0.80000000 |
| 48 OpenRouter judge calls, reported usage | 0.06125254 |
| Total | **1.46125254** |

The live fal quote was $0.035/megapixel for Qwen. Its reservation is deliberately
higher than a simple one-output-megapixel calculation; it is not a claimed
invoice charge. fal invoice reconciliation returned unavailable. All 56 ledger
cells completed. No hidden rerolls or additional paid work followed. The $4 cap
was a ceiling, not a spending target; more than $2.53 remains unused/reserved-free.

`tests.continuity_bench.lighthouse_control_pilot` is offline by default and checks
reference, guide-frame and implementation hashes. Live execution requires
`LIGHTHOUSE_CONTROL_PILOT=1` plus `--run`, validates current pricing, reserves
before each request and refuses an already-submitted ledger. Do not rerun it to
start a different experiment. Each image uses one recorded queue submission;
polling never substitutes a fresh POST for an uncertain request.

The ignored artifact directory is
`apps/modal-backend/tests/continuity_bench/reports/lighthouse-control-pilot/`.
Guide exports and their contract/hashes are in the sibling `lighthouse-guides/`.
The offline gallery builder is `tests.continuity_bench.lighthouse_results`;
it validates candidate hashes before packaging and imports no providers.

## Verification

- Desktop 1280 x 784 and mobile 390 x 844 browser checks: nonblank color, clay
  and depth; lateral controls change pixels; reset returns identical pixels;
  no page errors or horizontal overflow. Full tower visually inspected.
- Paid guide export: exact 1280 x 720, three frame hashes and source hashes.
- Camera/geometry unit checks: fixed height/FOV, landmark framing across lateral
  positions at both aspect ratios, unchanged geometry across modes, disposal.
- Payload/budget tests: fixed model/seed/size/cardinality, opt-in, price-change
  rejection without generation, architectural unknown/failure rejection.
- Full web suite: 1,135 tests passed. Coverage: lines/statements 80.32%,
  functions 83.48%, branches 88.47%; all existing floors passed unchanged.
- Full backend suite: 1,336 passed, two skipped. Coverage 88.28%, above the
  unchanged 87% floor. TypeScript typecheck and scoped Ruff checks also passed.
- Four Playwright checks passed, including the portable gallery at desktop and
  mobile sizes. Every gallery image decoded, every local link existed, and no
  HTTP request occurred. Screenshots were visually inspected. This is local
  regression evidence, not production rollout validation.

## Next Decision

1. No-cost first: revise a **new version** of the guide to retain the visible
   faceted base, long arcaded annex, roof proportions and crown profile. Inspect
   reference, oblique proxy view and proposed low view together. Keep this
   frozen version unchanged. Mark newly invented geometry rather than imply
   reconstruction. Stop if the source cannot constrain a useful guide.
2. Keep these four architecture failures and Qwen's camera failures as explicit
   negative examples. Add independently reviewed positives before considering
   any new production identity gate.
3. Only then propose a small paired test of that corrected guide. Do not spend
   leftover approval on more angle/prompt rerolls or video from these endpoints.
4. A second controlled viewpoint and return through the same saved geometry
   would be a separate test after one faithful arrival exists. This batch does
   not establish continuous movement, map-wide 3D or automatic consistency.
