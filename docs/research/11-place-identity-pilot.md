# Canonical Place Pilot, 2026-09-06/07

## Decision

Keep strict generation experimental and OFF. Canonical references plus rejecting
failed outputs are useful, but this pilot does not establish reliable entering
or zooming. No production flags or deployments were changed.

## Method

Three checked-in, verified illustrated maps from `tests/click_bench/fixtures`:
fishing village / North Point Lighthouse, oasis / citadel, harbor / Crystal
Lighthouse. Each target gets enter and close-up, baseline versus strict, for
12 cells. Both arms use nano-banana-pro and at most one actual image submission
per cell. Text/judges used the configured Gemini 3.7 Flash route. This is a
small diagnostic comparison, not a statistically powered benchmark.

The runner invokes the real generation stream but does not save app nodes.
Production receipts and a separate identity/style audit are recorded. Baseline
`accepted` in the artifact means a final event was published, not that its
quality judges passed. Some baseline close-ups attempted a second render; the
pilot stopped those before submission, so their legacy receipt's attempts=2
does not mean two paid image calls occurred.

| Target / Transition | Baseline Published | Strict Published | Main Failure |
| --- | --- | --- | --- |
| North Point / enter | yes | yes | Strict lighthouse still distant, behind foreground houses |
| North Point / close-up | yes | no | Wrong lighthouse; baseline returned the wider map |
| Oasis citadel / enter | yes | no | Identity/style drift |
| Oasis citadel / close-up | yes | no | Wider map, not a closer view |
| Crystal Lighthouse / enter | yes | no | Architecture changed despite matching medium |
| Crystal Lighthouse / close-up | yes | no | Wider map, not a closer view |

Strict rejected five of six candidates; baseline published all six despite
failing receipts. The sole strict pass scored identity 9, medium 9.5, and
camera 10, but visual inspection shows it does not adequately enter the target.
This is a judge false positive on target framing, not a successful demo shot.
The harbor strict enter visibly replaces the distinctive crystal assembly
with a different lantern/roof. Style similarity alone does not prove identity.

## Budget and Artifacts

Original cap: $5. Final conservative reservations: **$4.20**, including an
overestimated $3.60 carry-forward after an interrupted first pass. This is not
the provider invoice. The first accounting implementation crossed UTC midnight;
the resumed run used a persistent run-wide ledger, now regression-tested.
Cancelled cells and failures were not treated as free. No further paid calls
were made after the 12-cell completion.

The frozen [JSON receipt](11-place-identity-pilot.json) records the implementation
hash used for each source. Later changes to SSE camera stamping and UI handling
were covered by free tests, not another paid rerender. Full images and per-cell
receipts remain locally under
`apps/modal-backend/tests/continuity_bench/reports/place-identity-pilot/`.

Runner, from the backend directory:
`PLACE_IDENTITY_PILOT=1 .venv/bin/python -m tests.continuity_bench.place_identity_runner`.
It resumes completed hash-matching cells and retains its budget across runs.
Run one process at a time. Do not delete the ledger to reroll without a new
spend approval. Missing cells or failed audit calls make the report incomplete.

## Browser Receipt

Brave, isolated mock backend and Mongo database, at 390x844 and desktop:
Inspector rename/lock/crop persisted; old name remained an alias; saved-view
Enter reused an existing node; overlap chooser listed both market places;
New view opened and submitted the camera picker. Forced mock rejection and
Retry kept the source permalink and page count unchanged, with a separate
unpublished-candidate preview and no acceptance override. Mock spend labels are
synthetic estimates, not additional pilot charges.

The browser uncovered two mobile bugs fixed here: wrapping image controls
covered tap targets, and the camera picker was clipped by the image frame.
Controls now flow below the mobile image; the picker is portaled and bounded
to the viewport. Component/API tests cover stale writes, reload, ownership,
reference immutability, malformed input, cancelled work, and fork/export.

## Next Evidence Needed

Measure target prominence/arrival, not just whether the place appears somewhere
in the image. Expand to interior and multi-hop transitions, diverse media, and
independent human review before promotion. OUTWARD compositing and exact centre
pixels remain a separate experiment under #252, with no new success claim here.
