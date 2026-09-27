# Controlled Lighthouse Video Pilot

Run: September 8, 2026, America/Chicago (September 9 UTC).

**Result: structural conditioning follows this pixel-anchored approach closely, but adds no clear visual value over the free reference. No production promotion.** All five authorized clips completed, without rerolls. A cached rerun reused all five request IDs and retained the same $1.90 reservation against the $3 cap. Provider billing reconciliation is unavailable: this is not a measured $1.90 invoice.

## Frozen Experiment

The source is the existing `harbor_aethelgard.jpg` fixture (1376 x 768). The destination is a crop of those same pixels, not the earlier incorrect harbor arrival. This isolates a 2D approach toward the Crystal Lighthouse on the left. It does not test new-viewpoint arrival, recovered depth, unseen architecture, or continuous 3D travel.

The source-coordinate landmark region is `[0.082, 0.074, 0.127, 0.438]`; the tap is `[0.138, 0.312]`. Padding 0.045 produces crop `[0, 0.029, 0.528]`. The free reference uses a uniform smoothstep affine transform over 121 frames at 24fps. No independent x/y stretch is used. The full annotated region remains in bounds on every reference frame.

Inputs comprise an RGB reference clip, a Canny edge sequence, and first/middle/last PNGs rendered from the source. Structural inputs are 1280 x 704, with source content contained in `[9, 0, 1261, 704]`. Fast anchors are 1920 x 1080 with content rectangle `[0, 4, 1920, 1072]`. Small contain-rounding differences are recorded rather than hidden by stretching.

| Configuration | Controls | Actual Output | Reserved |
| --- | --- | --- | --- |
| Structural 0.35, seed 101 | RGB + edges + first/mid/last | 121 frames, 5.042s, 1280 x 704 | $0.35 |
| Structural 0.60, seed 101 | Same controls | 121 frames, 5.042s, 1280 x 704 | $0.35 |
| Structural 0.35, seed 202 | Same controls | 121 frames, 5.042s, 1280 x 704 | $0.35 |
| Structural 0.60, seed 202 | Same controls | 121 frames, 5.042s, 1280 x 704 | $0.35 |
| Endpoint-only Fast, seed 101 | First/last images only | 145 frames, 6.042s, 1920 x 1080 | $0.50 |

Structural route: `fal-ai/ltx-2.3-quality/reference-video-to-video`. Fixed settings: `video_strength=0.9`, `preserve_original_video=true`, `skip_control_preprocess=true`, 15 inference steps, guidance 1, prompt expansion off, and audio off. Denoise strength and seed are the only structural-arm variations. Fast uses `fal-ai/ltx-2.3/image-to-video/fast`, its native six-second option, 1080p, 24fps, and audio off. FFprobe confirms no audio stream in any returned clip.

Both routes receive the same prompt asking for a continuous reframe toward the lighthouse, preservation of the full crystal/tower/base and illustrated style, and only optional subtle water motion. New viewpoints, dives, cuts, dissolves, new buildings, titles and music are excluded. Structural negative prompting does not suppress artwork/painting. Effective arguments, returned prompts/seeds, and output hashes are retained in receipts.

The live pricing receipt returned $0.0024075/generated megapixel for structural and $0.06/second for Fast. Requested dimensions/frame counts yield a rate estimate of $1.4193 for the batch. Reservations round upward with headroom and per-clip floors, totaling $1.90. These are estimates and local reservation limits, not an enforceable provider billing cap. No missing billing record is treated as free usage or a refund.

## Visual Audit

Root and an independent agent inspected all five 11-frame contact sheets against the deterministic reference, with additional full-size off-keyframe and endpoint checks. These are assistant observations, not a blind human preference test or exhaustive review of every frame.

| Configuration | Observation | Decision |
| --- | --- | --- |
| Structural 0.35 / 101 | Crystal, tower, and base retained in sampled frames; mild smoothing/repainting | Keep as a conservative comparison candidate |
| Structural 0.35 / 202 | Similar approach and preservation; no meaningful seed advantage established | No clear gain over reference |
| Structural 0.60 / 101 | Correct approach; softer linework and small tower-top/roof changes | Added changes are not demonstrated improvements |
| Structural 0.60 / 202 | Correct approach; more crystal/bowl and nearby detail shifts | No reason established to prefer over 0.35 |
| Fast / 101 | Correct lighthouse destination; zoom lags through the middle and catches up | Does not follow the intended timing faithfully |

All five end at a recognizable close-up of the correct lighthouse. Endpoint recognition is not pixel identity. Structural control limits the wrong-direction failure in this fixture, but the result largely resembles the source-pixel zoom we already have. More repainting did not make the movement more convincing.

The independent audit's supplementary upper-crystal template search found Fast's feature center displaced by about 3.94% of the content-image diagonal at 50% progress and 3.56% at 70%, with a smaller feature scale before catching up at the endpoint. This coarse local-feature correspondence supports the visible timing drift; it is **not** the planned full-landmark bounding-box metric.

**The strict four-corner error <=3% across all 11 samples remains unverified.** No independent set of 11 observed full-landmark bounds was established. Expected overlays are reference positions, not detected output landmarks. Receipts explicitly keep `sampled_geometry=unverified`; neither visual similarity nor the supplementary feature check grants a strict pass. The offline review importer can compute that metric later from genuinely observed boxes without new model calls.

This comparison changes endpoint, conditioning, native resolution, and duration between Quality and Fast. It compares usable configurations, not an isolated causal estimate of structural conditioning. One fixture and two structural seeds do not establish general reliability.

## Reproduce and Inspect

From `apps/modal-backend`, using the existing Python dependencies and FFmpeg/FFprobe:

```bash
# Free preparation and configuration preview. No credentials or network.
.venv/bin/python -m tests.video_transition_bench.controlled_runner

# Authorized batch only. Keep the original output directory and ledger.
SPATIAL_VIDEO_PILOT=1 .venv/bin/python -m tests.video_transition_bench.controlled_runner --run

# Offline, hash-bound visual review; no credentials, uploads, or API calls.
.venv/bin/python -m tests.video_transition_bench.controlled_runner \
  --review ../../docs/research/13-controlled-video-review.json
```

Paid execution checks both live billing units before any upload, checks the whole pending batch against the remaining cap, locks the ledger, reserves before submission, and uses raw queue POSTs without automatic retries. Known request IDs resume through GET. Ambiguous submission retains its reservation and refuses automatic resubmission. Changed frozen inputs or receipt fingerprints fail closed. Do not delete/move the ledger or use a fresh `--out` to repeat this authorization.

Completed cached execution verifies output hashes, skips uploads/pricing/queue/download calls, and only retries the read-only billing lookup. A full mocked batch and replay test verifies exactly five initial submissions, seven shared uploads, then zero uploads/submissions/polls on replay. The live rerun preserved all five IDs and the $1.90 reservation. Original latency receipts are retained; they are sequential end-to-end timings, not a controlled speed benchmark.

Raw media, decoded frames, input hashes, ledger, pricing, and per-configuration receipts live under `apps/modal-backend/tests/video_transition_bench/reports/controlled-lighthouse/` (git-ignored). The Desktop delivery is `~/Desktop/openflipbook-controlled-video-2026-09-08/`; it contains the complete evidence and this report. The [hash-bound visual audit](13-controlled-video-review.json) and [machine receipts](13-controlled-video-pilot.json) are versionable summaries.

The read-only viewer is `/dev/spatial-transitions/controlled`. Start the web dev server with `SPATIAL_STUDY=1`, or use the existing local server at `http://127.0.0.1:3002/dev/spatial-transitions/controlled`. Both page and asset API return 404 in production, even if the flag is set. Only fixed experiment assets are allowlisted; no ledger or credentials are exposed.

The viewer preserves native aspect ratios, offers synchronized normalized seeking and independent native playback clocks, and labels the reference-position overlay as expected rather than observed. Seeking is supported by byte-range responses; this fixed a real browser failure where fully loaded MP4s would jump back to frame zero. Play, pause, reset, all five selections, desktop/mobile layout, nonblank decoded pixels, refresh, and absence of generation requests are covered by the opt-in local Playwright test:

```bash
E2E_CONTROLLED=1 E2E_BASE_URL=http://127.0.0.1:3002 \
  pnpm --filter @openflipbook/web exec playwright test e2e/controlled-video.spec.ts
```

## Verification

Final verification: 1,172 backend tests passed with two skipped and 87.46% production-module coverage. All 1,081 web tests, the full web coverage suite, TypeScript check, and backend Ruff check passed. Web coverage is 79.74% lines/statements, 82.13% functions and 87.39% branches, above the existing floors. The local Playwright test passed at desktop/mobile widths with all five saved clips and no page errors. Brave also sought both panels to 2.5s; its Dark Reader extension injects SVG attributes and triggers a development hydration warning, which was inspected and left unsuppressed. No browser extensions or user settings were changed.

## Next Decision

Keep deterministic source-pixel motion as the fidelity baseline, with an explicit cut when a continuous geometric connection cannot be established. No production navigation, video model default, generation cache key, or automatic-descent setting changed in this pilot.

Before paying for another model, finish the independent whole-landmark measurements and get a human playback verdict on whether any generated clip earns its cost. A further authorized trial should target a specific missing benefit, such as water-only motion while preserving the architecture, or repeat the low-denoise configuration on a second fixture. New-viewpoint arrival remains a separate geometry/identity problem.
