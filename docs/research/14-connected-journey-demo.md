# Connected Journey Demo, 2026-09-09

## What Exists

A 27-second editorial film and a navigable, saved four-node world:
harbor map -> market -> shop interior -> market -> map -> lighthouse -> map
-> market revisit -> map. This is no longer just a closer crop of one picture.

The film is on the Desktop under `openflipbook-connected-journey-2026-09-09/`.
That folder also contains unedited desktop/mobile browser-test recordings,
decoded film frames, the input/output receipts, rejected candidates and source
images. The local world URL is in `local-world.json` under
`apps/modal-backend/tests/continuity_bench/reports/connected-demo/`.

**Scope:** the arrivals were manually directed and visually selected, then
seeded into the existing saved-node embed. This is not an automatic end-to-end
generation benchmark, and it does not establish persistent 3D geometry or
reliable one-click arrivals. The film is composed from those saved images;
the separate browser recordings show actual app navigation.

## Still Selection

| Candidate | Decision | Observation |
| --- | --- | --- |
| market-1 | Keep | Curved quay left, market right, matching illustrated palette; still a slightly elevated camera |
| shop-1 | Reject | Duplicated the shop while leaving the original facade visible |
| interior-1 | Keep | Door left, provisions/sacks right, modest timber room; newly invented interior behind the known facade |
| lighthouse-1 | Reject | Enlarged tower over a hazy aerial backdrop, not a plausible arrival |
| lighthouse-2 | Keep | Landmark-only reference gave a plausible low-angle arrival; crown/crystal/attached house recognizable, detail simplified |

All five used `fal-ai/nano-banana-pro/edit`, one 2K image per submission.
Five reservations of $0.25 = **$1.25 reserved against the approved $3 cap**.
Billing lookup returned unavailable; this is not an invoice total. No new
video-generation calls or LLM/judge calls were made. Both rejected images
remain accounted for and are excluded from the saved route.

The paid runner is offline by default, has a durable locked ledger, persists
request IDs before polling, and never retries an ambiguous submission. Cached
results do not upload or resubmit. Deeper views require hash-matching accepted
parent reviews. Reference crops preserve source pixels and cannot overwrite a
frozen attempt. The lighthouse crop is an experiment, not a production policy.

## Navigation and Film

The seed script writes only to hard-coded localhost Mongo/MinIO stores. The
embed publish record is in the isolated local test DB, not a public deployment.
No owner session or existing world was modified. Target points and node/image
identities are persisted in transition contexts, with no invented camera pose.
The market marker was corrected from the draft prompt metadata to the actual
stalls at (0.656, 0.354); the historical prompt receipt is left unchanged.

Approaches reframe the actual parent pixels; camera changes are explicit cuts.
No generative in-between, crossfade that conceals mismatches, or simulated
walk-through is presented as continuous geometry. The film uses editorial
holds and extra lighthouse headroom, so it is not frame-identical to the app's
transition timing. Audio is original synthesized ambience/chimes, not a music
sample. Original source pixels at the final map return match the beginning
before captions and lossy video encoding.

Verification:

- Backend: 1,184 passed, 2 skipped.
- Six offline film tests: timeline coverage, direction, explicit cuts, tower bounds, uniform transforms and raw map return equality.
- Two Playwright journeys, 1440x900 and 390x844: every node/return/revisit, reload, exact stored-image SHA-256 matches, no generation requests, no page errors, no horizontal overflow.
- Brave: manually inspected map markers, market, shop interior, back navigation and lighthouse.
- Web typecheck and focused Python Ruff checks pass.
- Encoded film: 1920x1080, 30 fps, 810 frames, 27 seconds, AAC audio. Twelve decoded samples visually inspected; no blank frames or caption collisions in those samples.

## Production Fix Found

The balanced image-edit default and explicit legacy Pro pins were using the
text-only `fal-ai/nano-banana-pro` slug. Edit and continue now normalize that
specific slug to `/edit`; text-to-image generation routing is unchanged.
Regression tests verify the actual endpoint, retained reference inputs and
reported effective model. This affects the old explicitly pinned place-identity
pilot, which now carries a methodology correction. The normal enter router
already used the proper edit endpoint; this does not explain every bad arrival.

## Reproduce Without Spending

From `apps/web`, with the existing isolated local stack running:

```sh
node scripts/seed-connected-demo.mjs
E2E_CONNECTED_DEMO=1 E2E_BASE_URL=http://127.0.0.1:3002 pnpm exec playwright test e2e/connected-demo.spec.ts
```

From the repository root, use an empty output directory:

```sh
apps/modal-backend/.venv/bin/python scripts/record-demo/compose_connected_film.py /path/to/new-cut
apps/modal-backend/.venv/bin/pytest -q scripts/record-demo/test_connected_film.py
```

Paid shot configuration is `scripts/record-demo/connected-route.json`. Do not
delete the ledger, alter frozen attempts or create a new output directory to
bypass the remaining budget. There is no automatic reroll/promotion step.

## Next Evidence

Test whether landmark-local references improve automatic arrivals on several
worlds, especially avoiding duplicate buildings and map-as-backdrop failures.
Judge arrival framing and architecture separately from medium similarity.
This curated route is useful demonstration material, not evidence to switch
strict arrival or generated transitions on globally.
