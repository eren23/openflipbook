# Automatic Exterior Arrival Pilot

September 9, 2026. Local experiment; approved cap **$5**. No graduation.

## Result

**12 fresh images, 0 complete runtime passes, 0 assistant visual sign-offs.**
Eleven outputs fail the eye-level camera gate; the other has insufficient
reference coverage to establish full architectural identity. Neither reference
order earned promotion. Do not turn this batch into a success demo.

Viewer: `http://127.0.0.1:3002/dev/arrivals`. Raw sources, candidates, actual
reference crops, requests, judge replies and receipts are under
`apps/modal-backend/tests/continuity_bench/reports/arrival-audit/` (ignored output).

## Method

Three saved maps: fishing village, oasis citadel and crystal-lighthouse harbor.
One automatic extraction per source; clone only those extracted root records
into isolated local sessions. No curated anchor, human bbox, rewritten appearance
or manual target ID was injected. Each trial uses the ordinary browser map click,
server reference selection, real planner, image edit and final judges.

Two context-first and two target-first submissions per map. Pin
`fal-ai/nano-banana-pro/edit`, one image per trial, 1K, PNG, web search off and
provider-managed randomness. Native editing does not set an aspect ratio; some
outputs became portrait. Background extraction, segmentation, prefetch and video
were blocked. No corrective edits or additional image rerolls were submitted.

This is an end-to-end pilot, **not a prompt-identical reference-order ablation**:
the app re-plans each trial. Initial manifest, executed implementation hashes and
actual requests are recorded. This small sample is not a reliability estimate.

## Evidence

Camera acceptance floor: 7.

| Source | Context-first camera scores | Target-first camera scores | Main failure |
| --- | --- | --- | --- |
| Fishing village | 8, 1 | 1, 0 | Label-heavy crop; map backdrop, border or duplicated tower |
| Oasis citadel | 2, 0 | 0, 1 | Elevated overview of gates and roofs, not standing height |
| Crystal harbor | 0, 0 | 0, 1 | Aerial closeup; some portrait outputs |

Identity scores were 9-10 and style scores 7.8-10. Those high scores did not
establish successful arrival. The narrow fishing crop excludes the base and
cottage, preventing identity verification of those structures. The citadel's
invented vertical proportions also received generous identity scores.

The categorical arrival judge caught a map backdrop and duplication, but passed
several elevated views. The separate camera gate is essential. Do not average
the checks into a passing score. Assistant visual notes are labeled as such;
the user's human review has not happened. No candidate was accepted/published.

## Bugs And Amendments

- The first fishing and harbor arrival replies contained valid JSON inside a
  Markdown fence. Fixed complete-fence parsing with regression tests. Truncated,
  malformed and mixed replies still reject. Original decisions remain intact;
  offline parser replay is separate, with no extra judge calls or publication.
- Two initial browser setups converted Mongo dates to strings, breaking map
  hydration. Fixed the cloning harness and retained setup-failure receipts.
  Those cell attempts made no model calls; their retry was ledger-checked.
- The fishing camera reply was incomplete despite a `stop` finish reason.
  Its original response is retained. Unknown camera metadata was preserved.

## Cost And Checks

12 images at the live-quoted $0.15 rate: **$1.80 reserved**. 81 LLM calls report
**$0.1464306525** through OpenRouter usage. Combined accounted/reserved total:
**$1.9464306525**. The fal billing-event lookup was unavailable, so its $1.80
portion is not invoice-verified. No top-up, extra image reroll or video call.

Reservations persist before submission; ambiguous requests are not blindly
resubmitted. The live backend is stopped. The ordinary app and viewer remain.
Full backend coverage passes at 88.06% (floor 87); full web coverage, typecheck
and lint pass. Four desktop/mobile Playwright checks pass with mocked generation,
separately from the paid pilot.

## Next

1. Localize the physical structure, not its printed label. Verify crown, body,
   base and attached-building coverage before treating a crop as identity proof.
2. Make aspect ratio and standing-height camera explicit. The present editor
   preserves aerial composition more reliably than it reprojects the scene.
3. Test one structural/camera-control approach on a sound reference, recording
   any invented geometry separately. Keep explicit cuts and defer more video
   spend until both the destination and movement pass.
