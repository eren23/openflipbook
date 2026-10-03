# Geometry-Bound AI Camera Motion

September 14, 2026: read-only H3 preparation, reference-frame inspection,
private saved motion studies, default-off backend transport, durable motion jobs,
silent video storage and generation/review controls are implemented.
Provider calibration and real AI motion acceptance remain unfinished. This is a component of the
connected-product goal, not its completion.

## Current Product Boundary

`GET /api/world/:sessionId/views/:viewId/motion` requires world ownership and an
existing saved single-place exterior orbit view with a named target and a path
captured at time zero. It reuses the saved-camera validator and current scene
and immutable asset bindings. Historical geometry, mismatched camera matrices,
unbound targets, floor cutaways and unsupported paths reject before preparation.

The source is that view's accepted illustration when available, otherwise its
saved geometry render. An accepted image with missing or mismatched provenance
rejects; it does not silently fall back to a different image. Image identity,
hash, dimensions, scene revisions, asset hashes, target, path, adapter and exact
parameters participate in the preparation fingerprint. Storage keys are private.
The fingerprint is not a spending token or server geometry attestation.

The endpoint neither downloads images nor submits, reserves, stores or approves
generation. It returns `generation_enabled: false`, `calibration_required` and
the remaining checks. Changing accepted artwork changes the preparation even
when the camera is unchanged. Submission separately rechecks owned bytes,
dependencies, selection, preflight and approved price rather than trust this GET.

## Provider Mapping

Verified the live [fal schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/camera-controls)
on September 14. Endpoint: `minimax/h3-max/camera-controls`, distinct from the
existing H3 first/last-image route. It accepts one starting image, 2-12 ordered
normalized-time angle/distance keyframes and integer durations of 5-15 seconds.
It exposes no ending-image, depth, normal, mesh or world-camera-matrix input.

Adapter `h3-source-relative-v1-hypothesis` subtracts the starting azimuth and
elevation and divides each distance by the starting world distance. Initial
provider pose is therefore (0 degrees, 0 degrees, 1). Both angle signs are
currently positive hypotheses. They are NOT calibrated provider conventions.
Elevation offsets from a tilted source and distance ratios need empirical
verification; do not label them exact physical translations or metric controls.

Adapter `h3-source-relative-v2-measured` (2026-10-02) replaces v1 for new
studies. It uses the gains measured on 2026-09-27. Distance is sent as
`max(0.2, 1 - (1 - r) / 0.6)`, because H3 delivers about 0.6 of a requested
push. A pull-back (r > 1) is marked unverified. A turn over 30 degrees or a rise
over 15 degrees is a limit issue that blocks the quote. H3 orbits a nearer
centre, so part of a turn arrives as a pan and the target drifts. For a longer
or wider move, use a path video (first/last-frame legs between gated keyframes,
`PATH_VIDEO_ENABLED`). Research 36 has the live check: a push tracked the
geometry frames, an orbit gave about half the parallax. v1 studies keep v1 maths.

Signed turns are preserved without shortest-angle wrapping. Relative elevation
outside [-90, 90], fractional durations and malformed/degenerate paths reject,
not clamp. Existing local path constraints remain stricter than some provider
limits. No moving pivot, roll, lens/projection change or six-DOF travel is added.

Reference matrices at every authored keyframe plus 0%, 25%, 50%, 75% and 100%
retain the saved projection. The first matrix is the exact saved source matrix;
later ones follow the local path. These are evaluation inputs to be rendered,
not additional conditioning sent to H3. Provider interpolation is unverified.

## Walk Videos

A path video can also use an ordered list of saved views instead of a motion
study. This is how a walk becomes a video: an orbit study cannot show a walk,
and camera-controls has no end frame.

1. Open a /play route with **Walk it in 3D**. The editor opens the Walk view
   and walks the route.
2. In the inspector, select **Make walk video**. The editor shows it only when
   `PATH_VIDEO_ENABLED=1`. The editor walks the route as the tour does: it turns
   on the spot to each waypoint's heading, then goes straight. It sets a
   checkpoint after each 4 m walked or 30 degrees turned (`walkCheckpoints` in
   `walk-route.ts`), at the walker's eye (1.6 m) with a level gaze. If the route
   needs more than 12 checkpoints, the editor refuses it. Make the route shorter.
   If the route gives fewer than 2 checkpoints, the editor refuses it too,
   before it captures anything.
3. The editor captures each checkpoint and saves it as a walk view. This is free
   and calls no model. These views have the `walk_checkpoint` mark and their own
   limit of 240 for each place. They do not count toward the 50 saved views. The
   library list, the world export and forks do not include them. If a current
   checkpoint view of the place has the same camera and size, the server gives
   back that view and saves nothing new. Thus a second "Make walk video" on the
   same route does not use the limit. A checkpoint view cannot be refreshed or
   illustrated, and a motion study needs an orbit view.
4. Read the quote, give consent and generate. The job is one path video over
   the view ids. `GET /api/world/:sid/places/:pid/walk-videos?views=a,b,c` gives
   the quote and `views_sha256`. `POST` to the same path with
   `{ action: "generate", id, confirmed, view_ids, views_sha256, reservation, prompt }`.

Keyframe 0 is the accepted illustration of view 0, if there is one. If not, the
job paints keyframe 0 like a first keyframe, with the world's art. Each next
keyframe chains from the one before it. The chain moves camera A into the frame
of camera B by the chunk offset (`chainShift`), so views of connected chunks
line up.

The move of each leg comes from the two camera matrices. `forward_m` is the
eye's move along the level heading of A. `turn_deg` is the signed change of
heading (positive turns to the camera's own right). `rise_m` is the change in
eye height, and `orbit_deg` is 0. The subject is the object that the gate of
the end keyframe measures. The gate measures the most visible building when it
covers at least 3% of the frame (`GATE_MIN_SHARE`). If no building does, it
measures the most visible object of another kind with 3% (not a path or a
pond), and SAM-3 gets the name of its kind ("well", "tree"; else "object").
If no object has 3%, the gate does not compare silhouettes, and the paint
check alone decides. The keyframe records the subject (`gate_subject`: id,
kind, label, or null). A leg plans its length at
1.4 m/s, and at least 1.5 s for a turn on the spot. Then the usual leg length,
trim and retime apply.

H3 moves for the whole clip that a leg asks for (research 37). Thus each study
or walk leg asks H3 for its planned length, rounded up to whole seconds, with a
minimum of `LEG_MIN_SECONDS` (3 s). fal's schema accepts 0.92 to 15 s. Before,
each leg asked for at least 5 s. The backend gives its floor as
`leg_min_seconds` in `/motion/capabilities`. When a backend does not give it
(an older backend that refuses legs under 5 s), the web sizes legs at 5 s. A walk leg of 4 m (2.9 s planned) now costs
3 s, so the legs of a 4-leg walk cost $0.96 at $0.08/s, not $1.60. The web
side trims each clip at the end of its motion and retimes it to the plan
(0.5 to 2 times).

Billing, the one retry, refusals and provenance (view ids and their hash, not a
study) are the same as for a study path video. All views must be current 3D
views of the same place, at the same size. A geometry change during a job stops
it before its next paid step and releases the rest. A place has at most 20 walk
videos that are active or ready. Failed and cancelled jobs do not count.

In study and walk path videos, a keyframe that fails its gate is painted once
more. The job reserves this retry on its own, as it does for a leg retry. If
the retry passes, the job uses it. If it fails again, the job drops the
keyframe, so that the video does not show an invented picture:

- A failed keyframe 0 fails the job, because no chain or leg can start without
  it. The job releases the unspent reservation. (Accepted artwork at keyframe 0
  has no gate, because the job does not paint it.)
- The job skips a failed middle keyframe. The next keyframe chains from the
  last kept keyframe, and one leg goes from that keyframe to the next one. The
  leg's move is the real move between those two cameras. The leg adds the two
  planned lengths, and costs its own length.
  The job releases the rest of the two legs' reservation.
- The job drops a failed last keyframe and the leg into it. The video then
  ends at the keyframe before it, and the job releases the reservation of that
  leg.

The job does not drop a middle keyframe when the step from the last kept
keyframe to the next one is more than two checkpoint steps. For a study, the
view direction turns more than 60 degrees (orbit and elevation together), or
the distance changes by more than 1.5 x 1.5 = 2.25 times. For a walk, the eye
moves more than 8 m, or turns more than 60 degrees. A chain that long is not
reliable. Then the
job keeps the try that is nearer the gate (IoU) and flags it (`kept_reason`).
The job record shows the retry (`retry`), the drop (`dropped`, `drop_reason`)
on the keyframe, and the keyframe that each chain started from
(`chained_from`).

## Next Acceptance Work

1. Use the reference capture below to define a bounded calibration shot with an
   asymmetric landmark and identifiable doorway. Bind a saved motion study
   to its job. Visible object-mask measurements exist; doorway feature
   tracks and occlusion-order comparisons against generated video remain open.
2. Specify tolerances and calibration shots before any submission. Compare small
   left/right arcs, rise and approach against the same source; preserve failures.
   Verify current price and obtain explicit batch spending approval. Preparation
   and the previous asset-generation approval do not authorize this batch.
3. Exercise the implemented durable dispatch, cancellation and storage recovery
   against real provider receipts. Tests establish the state machine, not fal's
   actual behavior. Keep clips historical after edits; never update geometry
   from a video.
4. Verify generated clips against the saved references in the creator workspace.
   Playback selects the nearest sampled reference, but automatic landmark tracking,
   numeric video verdicts and synchronized continuous comparison remain open.
   Explicit acceptance is a creator selection, not a calibrated quality pass.
5. Prove the motion alongside linked sketch/3D edits, map refresh, building entry,
   expansion and return in one world. A good orbit alone does not pass this gate.

## Private Backend Transport

`providers/camera_motion.py` registers `/motion/capabilities`, `/motion/submit`
and `/motion/requests/:requestId` behind the backend's shared-token middleware.
This is transport for the future durable worker, not an owner-authenticated web
generation route or a job queue. The worker must reserve spending, freeze the
owned study and claim a submission before calling it. Do not enable it as a
standalone public generation endpoint.

New submissions default off. They require `MOTION_CALIBRATION_ENABLED=1`,
`SHARED_TOKEN`, `FAL_KEY`, non-mock mode, and an operator-reviewed
`MOTION_RESERVATION_USD_PER_SECOND`. The minimum accepted reservation is the
verified non-promotional 768P rate of $0.08/second; the launch discount expires
September 14. Capabilities expose a per-second reservation, and each submit
rechecks its duration-dependent total. These are conservative reservations,
not claimed invoice costs. Recheck [fal pricing](https://fal.ai/models/minimax/h3-max/camera-controls)
before enabling any paid batch.

The adapter accepts the versioned source-relative mapping only, 768P/balanced,
5-15 integer seconds, safety checks on, sync mode off, and 2-12 finite strictly
ordered keyframes. First pose must be `(time=0, azimuth=0, elevation=0, distance=1)`;
the last time is 1. Signed turns are preserved, including the provider's 32-turn
travel bound. Unknown fields such as end images, depth or mesh inputs reject.

Source input is exact private PNG/JPEG bytes plus SHA-256, byte length and saved
dimensions, not a caller-selected remote URL. Changed/truncated/animated images,
format mismatches and EXIF-rotated sources reject before transport. Only the
source image and supported parameters go to fal; geometry, adapter metadata,
reservation and evaluation references are not model-conditioning inputs.

Submission makes one HTTP POST, with redirects and transport retries disabled
and `X-Fal-No-Retry: 1`. Lost/malformed responses remain ambiguous for the
worker to retain, never an instruction to submit again. Status/result reads use
the fixed camera-controls endpoint and saved request ID. Turning off new
generation or its price does not strand an existing request; missing credentials
and mock mode still prohibit provider access. Terminal provider rejection is
distinct from a recoverable status/result outage. Expanded prompts are retained
in the response. Provider audio remains explicitly unverified: it exposes no
verified audio-disable field. The storage worker retains original bytes and
creates/inspects a silent derivative before making playback available.

Transport tests use mocked HTTP/provider responses and real image decoding.
They prove argument forwarding and failure handling, not provider availability,
calibrated directions, preservation of architecture or generated video quality.

## Local Reference Inspector

Saved path views now offer **Prepare motion references** in the camera library.
An explicit click fetches owned server preparation, checks the local snapshot
identity/revision/definition hash and asset bindings, and loads one temporary
scene with the existing renderer, textures and meshes. It sweeps the authored
path using the existing Rapier clearance/visibility checker. Clearance derives
from the saved projection's near-plane corners, not a default camera FOV.

All prepared sample cameras render color, depth, normals and object-mask passes
at the saved dimensions. The inspector scrubs the color frames locally. A
measurement callback reads exact mask pixels after conversion to top-left image
coordinates. Each known object gets visible-pixel area/fraction, centroid,
half-open normalized bounds and a frame-edge flag. Absent objects have zero
pixels and null bounds/centroids; unknown colors remain unknown. These are
visible opaque silhouettes, not inferred full-object extents or feature tracks.

Blocked preflight is retained with the reference frames, not changed to a pass.
The results stay explicitly labeled geometry references and H3 uncalibrated.
The app rechecks the preparation fingerprint after capture to reject concurrent
source/accepted-artwork changes. Edits, navigation and cancel abort pending work;
late responses cannot replace current results. No automatic provider call occurs.

Offscreen assets are loaded once per batch. The renderer, scene and physics are
released on success, abort and failure; rendering yields between frames and
encoded references are capped at 64 MiB. Unsaved captures remain transient;
the explicit save command below persists their evidence, not a generated clip.
Cross-platform recomputed matrices permit only 1e-10 relative numerical roundoff;
saved path parameters, bindings and source hashes still match exactly.

## Saved Motion Studies

**Save motion study** stores the source view, source-image identity/hash/length,
exact geometry definitions and immutable asset bindings, prepared provider
parameters, reference cameras, and every frame's render/depth/normal/object PNG.
The server validates image formats and dimensions, verifies stored source bytes,
matches camera/source metadata to its own preparation and recomputes landmark
measurements from the uploaded object masks. It does not attest that a browser
actually rendered those pixels from that geometry. Records explicitly retain
`client_rendered_saved_geometry` and `not_server_attested` provenance.

Client clearance reports, including blocked intervals, are retained as bounded
diagnostic evidence, never generation authorization. Earlier records without a
report display "not recorded", not "clear". Clear/blocked results still require
independent generation-time validation and later visual comparison with AI output.

Private endpoints:
- `GET/POST /api/world/:sessionId/views/:viewId/motion/studies`
- `GET /api/world/:sessionId/motion-studies/:studyId/:frame/:pass`

Reads require world ownership and use private/no-store responses. Frame reads
verify stored hash and byte length, and report unavailable/corrupt storage rather
than recapture. The list keeps old studies available as historical when current
geometry or accepted source artwork changes. Reload and scrubbing make reads
only; they neither regenerate references nor submit provider work.

Writes authenticate before buffering their streamed body (80 MiB cap), limit
source-plus-reference binary data to 48 MiB, and allow at most 20 studies per
view. Publication rechecks current preparation inside a transaction fenced by
the existing scene-source mechanism. Retry keeps the same request ID and frozen
payload; exact duplicate saves reuse the immutable record, including after the
source becomes historical. Conflicting reuse rejects. A lost upload/publication
can leave unreferenced content-addressed PNGs; storage garbage collection remains
unfinished. Pending browser-only retry state is not a durable provider job.

Not implemented here: independent server rendering or clearance attestation,
study/video export/import integration, automatic orphan cleanup, or
camera-model calibration. Studies remain references, not proof that H3 preserves
geometry.

## Durable Generation And Private Replay

The saved-study inspector includes an experimental mapping acknowledgment and a
separate, current dollar reservation. Both are required to schedule a calibration
clip. Merely loading, scrubbing, replaying or accepting a saved clip never submits
generation. Backend capability and a fresh worker heartbeat must be present;
the backend remains disabled by default. Local worker installations require
`ffmpeg` and `ffprobe` on PATH; the Docker `place-worker` target includes them.
`MOTION_DAILY_CAP_USD` defaults to $3 and shares the global/session spend ledger
with mesh, material and illustration generation. This operator cap is not user
approval for a paid batch.

Private endpoints:
- `GET/POST /api/world/:sessionId/motion-studies/:studyId/jobs`
- `GET /api/world/:sessionId/motion-studies/:studyId/videos/:assetId`

Scheduling verifies the exact owned study hash, current preparation, source
image bytes, local preflight status, frozen comparison hash and quoted price. A transaction fences scene
dependencies, reserves spend and inserts one job. Identical retries reuse the
same job, even after its source becomes historical. Conflicting identity reuse
rejects. Worker submission checks the study again, including exact queued
model, adapter, preparation hash and camera parameters. Input images must be
single-frame PNG/JPEG, unrotated, 32-1024 pixels on each side and at most 4 MiB.

The submission claim cannot expire back to a submit-ready state. Request IDs are
saved before the queued-state update. Lost submission responses remain visibly
ambiguous; known IDs recover through reads, not another POST. Cancellation only
refunds work still scheduled. Later cancellation discards publication but may
remain billable, including a late-arriving provider receipt. Source changes before
submission cancel and release the reservation once. Temporary source-storage
outages leave the job scheduled and cancellable.

Storage uses reclaimable leases. Provider downloads are allowlisted and bounded
to 150 MiB. Original bytes and their identity are retained before processing,
including outputs that fail video validation. FFmpeg stream-copies only the H264
video track, dropping audio, subtitles, data, chapters and metadata. The worker
checks dimensions/duration, confirms zero audio streams and decodes every frame
before publishing the silent derivative. Original and derivative hashes, exact
parameters, source study, adapter, request ID and expanded prompt are retained.
Storage-only retry retrieves the existing result or reuses verified stored bytes;
it never submits another generation. Missing/corrupted replay fails explicitly.

Replay supports authenticated single HTTP byte ranges after verifying the full
immutable file. This is necessary for browser seeking: serving only full 200
responses left the browser's seekable range at zero in the synthetic browser
test. Partial responses are private/no-store and never disclose file length to
an unauthorized caller. Each request currently reads/verifies the complete file;
streaming storage optimization remains open.

## Frozen Comparison And Human Review

The `visible-bounds-human-v1` comparison plan is computed from the saved object
masks before submission. It requires at least five samples covering the complete
path, a measurable unclipped target, and two measurable neighboring landmarks
throughout. Unknown mask pixels must not exceed 1%. Neighbors are selected
deterministically by their minimum visible mask fraction across the samples.
They must belong to the saved world definition; road patches are excluded because
their visual boundaries can merge with adjoining ground.
The reference needs detectable endpoint position or scale movement. An incomplete
reference cannot reserve spend or submit generation; it needs reframing first.

The local capture runs this same comparison evaluator before a study upload and
shows readiness, selected objects and reference issues immediately. This is a
diagnostic preview, not a trusted client verdict: saving still recomputes the
measurements from uploaded masks and generation still computes its own plan.
Incomplete references remain saveable as failure evidence, but cannot generate.

Initial, not yet empirically calibrated, tolerances are frozen with the plan:
- Bounding-box center: at most 3% of image width/height on either axis.
- Bounding-box width/height: at most 20% relative error.
- Direction cosine: at least 0.7 when reference sample displacement is at least
  1.5% in normalized image coordinates; observed displacement must reach 0.5%.
- Sample time: within 0.1 seconds; duration within 0.25 seconds.
- Aspect ratio: within 1% relative error. Frame-clipped or absent landmarks fail.

The exact plan/hash accompanies the generation request, job and immutable video
asset. Workers must advertise `motion_review_v1` and revalidate the frozen plan
before submission. Old scheduled jobs without a contract cancel/refund before
any paid POST. Known historical provider receipts can still be recovered.

**Compare with geometry** shows saved reference pixels beside the actual silent
video. Reviewers select a sample and landmark, drag visible video bounds or enter
four percentages, and explicitly assess architecture/identity, occlusion order
and continuous motion. Full-clip playback is available within the dialog; bounds
measurement is disabled during playback, seeking or a mismatched timestamp.
Return to sample pauses and seeks. The last sample uses a frame just before the
video endpoint, recording its actual time rather than pretending it is exact.
Unmeasured landmarks are never populated from reference bounds automatically.

Each save creates an immutable review, including failed/incomplete reviews, bound
to the asset, silent video hash and pre-submission comparison hash. Lost-response
retries retain the same review identity and frozen payload. The action route
authenticates before buffering its 64 KiB maximum body. Up to 20 reviews per clip
are retained. No model is called by comparison or review actions.

Acceptance requires a matching passing saved review, re-evaluated server-side;
a stored outcome label alone is insufficient. It records a separate selection
with stale-source and concurrent-selection checks, never mutating geometry or
the immutable study. Historical clips remain privately replayable. Pre-contract
clips are replay-only for new acceptance, not retroactively quality-certified.

These are human measurements of visible bounding boxes against client-rendered
geometry masks, not automatic surface-feature tracks, server-attested rendering
or independently verified geometric reconstruction. Human flags remain subjective,
and sample agreement does not prove unseen geometry or between-frame accuracy.
Real provider calibration, visual inspection of generated output and the full
connected-world acceptance recording remain required.

## Owner Forks

An owner fork copies private camera studies, completed video assets, all saved
reviews (including failures) and the existing clip selection in the same snapshot
transaction as the world. Public-world viewers do not receive these private
captures or review notes. Stable scene/object/view/study/asset identities and
immutable file keys remain unchanged within the new session namespace.

The study's session-scoped record hash changes in the fork. Each copied clip is
rebound to that new hash, while `forked_from` retains the original session and
study hash; provider request IDs, parameters, source pixels and video hashes stay
unchanged. Repeated forks apply the same rule. The selection is inherited state,
not a fresh quality assessment. Later acceptance still runs the normal current
source and saved-review checks.

Missing cameras, inconsistent clip/study hashes, mismatched review/video bindings
or broken selected references abort the entire fork. No model calls or object
copies occur. Runnable motion jobs, reservations, leases and unfinished provider
work are deliberately not copied; they remain in the source world. Independent
validation of generated video remains open.

## World Archives

Owner exports include motion studies, their original source image and all four
passes at every sample, completed original/silent video bytes, failed and passing
reviews, and the selected clip. They share the world's database snapshot; missing
or corrupted bytes abort the export. Shared exports omit private motion content.
Archives with motion use world-content version 2 so older importers reject them
instead of silently dropping evidence. Version-1 worlds remain supported.

Import validates the saved scene/view/asset bindings, rebuilds the supported
camera preparation, recomputes landmark measurements from bundled object masks,
and verifies review plans, outcomes and selections. Historical geometry and
missing preflight evidence stay historical or missing. Unknown adapter versions
require explicit migration rather than automatic reinterpretation.

Original and silent video files retain their exact bytes. Local ffprobe/ffmpeg
checks enforce dimensions, duration, H.264 encoding, silent playback and equal
encoded video streams, with full derivative decoding and no network protocols.
Both tools are included in the self-hosted web image; non-Docker web installs
need them on PATH to import clips. Imports do not remux or regenerate videos.

New session/storage bindings are explicit under `restored_from`. Imported clips
are labeled user-supplied evidence: checksums and human review records are not
provider authenticity or independent geometric attestation. The original ZIP
remains in the private import receipt. Import copies no runnable jobs, provider
leases, reservations or generation consent, and publishes the world atomically.
