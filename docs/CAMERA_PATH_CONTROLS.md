# Local Camera Path Controls

Status: implemented locally, September 13, 2026. Free path authoring, local
geometry preflight, saved-view persistence and projection-preserving reload are
available. September 14 adds a read-only, uncalibrated H3 preparation adapter
bound to saved views and accepted artwork. Provider jobs, calibration and
generation UI remain unfinished; see [camera motion](CAMERA_MOTION.md).

## Product Surface

In the world editor, select **3D** (or the 3D half of **Plan + 3D**) and open
**Camera path**. The panel drives the existing scene camera, not an illustrative
camera widget or a prompt label. Opening starts two stationary endpoint frames.
Select an endpoint and change azimuth, elevation or distance; scrub between
frames to insert another. Interior frames can be removed, endpoints cannot.
There are at most 12 frames and duration choices from 5 to 15 seconds.

The target button starts a new path around the selected object's resolved
world-space bounding centre, including floor elevation, or the scene centre.
During authoring, orbit dragging and zooming update the current keyframe; camera
panning is disabled so the fixed pivot does not drift. A manual gesture stops
playback. A gesture between markers inserts a frame, or updates the nearest
marker when the frame limit/spacing prevents insertion. A focus/pivot change
resets the path rather than reinterpreting an old path around a new target.

Playback, scrubbing and controls are local and cannot submit a paid job.
**Save camera view** freezes the current path sample and stores its keyframes,
duration, pivot, target identity and camera together with the render/depth/normal/
object passes and existing scene/asset bindings. **Load camera path** in the
saved-view library restores that path and its captured pose without starting
playback. Unsaved local changes are a **Path draft**; save another view to retain
an edited version before leaving. Saved records remain immutable.

## Coordinates And Limits

- Three.js world coordinates, Y up. Azimuth zero points from the pivot toward
  +Z; positive azimuth moves toward +X. Elevation is above the horizontal plane.
- Distance is in authored world metres, bounded by the viewport's orbit limits.
- Piecewise linear interpolation in azimuth/elevation/distance preserves signed
  full turns; it does not silently substitute a shortest-angle rotation.
- New paths start with the current viewport framing. A loaded path restores its
  saved projection and fits the canvas with letterboxing across viewport sizes.
  Projection is preserved, not a claim of pixel-identical rasterization at a
  different resolution. Starting a new target path returns to viewport framing.
- Local checks sweep camera clearance against scene solids and visible mesh
  surfaces, and sample selected-target visibility. These are not a guarantee of
  walkable traversal, entire-landmark framing or generated-video consistency.
- A source-relative H3 conversion hypothesis now exists in the read-only motion
  endpoint. No calibrated axis/distance mapping, provider request, end-frame
  matching, animated rig gizmo, route preset, moving pivot, roll or lens changes.

Implementation: `apps/web/lib/camera-path.ts`,
`apps/web/components/sketch/camera-path-controls.tsx`, and the camera bridge in
`place-viewport.tsx`. It uses the existing Three.js/OrbitControls installation;
there are no new dependencies or sibling-repository runtime imports.

## Local Geometry Preflight

Added September 13. Play first checks the current local path. The shield button
checks without starting movement. A failed result disables Play and exposes
clickable problem times; scrubbing remains available for inspection and repair.
Changing a keyframe or pivot discards the old result. Manual movement, closing,
scrubbing and unmounting cancel a pending check's intent to start playback.
Viewport changes that enlarge the camera clearance also invalidate the result.
None of this changes committed world geometry or submits a provider job.

The checker uses the existing Rapier engine with both authored collision solids
and visible mesh triangles transformed into scene coordinates. This includes
roofs omitted by walking colliders. Simplified mesh bounds remain conservative;
transparency/cutout/draw-range details are not an exact physical-material model.
They can produce false-positive collision or visibility warnings.

Camera clearance is at least 0.2m, enlarged for the perspective near-plane
corners. Each curved orbit segment is approximated by chords with an analytic
second-derivative error bound. Rapier sweeps a sphere enlarged by that bound,
including start/end overlap checks. Subdivision limits chord error to 1cm and
path travel per visibility sample to at most 0.25m. Thin obstacles between
sample positions are checked by shape sweeps, not just point samples.

For a selected target, separate accelerated ray queries test whether the first
opaque mesh surface toward its bounding centre belongs to that target. The UI
explicitly calls this sampled visibility. It does not prove continuous
visibility, whole-object framing, a semantic doorway arrival or model adherence.
With no selected target, clearance can pass but visibility is not checked.

Malformed paths and unsupported geometry produce errors, not passes. Work is
bounded at 4,096 segments, 500,000 triangles and 1,500,000 mesh vertices; paths
or scenes exceeding those limits are not validated. The UI retains at most 32
problem intervals. The checker is lazy, cached only for the live scene, and its
WASM world is released when the viewport is replaced. This is local preflight,
not persisted collision evidence or server attestation for a generated video.

## Persistence And Replay

Paths use the existing optional `ViewCapture.path` field, not a second storage
authority or localStorage. Server parsing validates bounded, ordered keyframes,
duration, time, target-relative pivot, and exact agreement between the captured
camera matrix and the path sample. Target placement resolves parent rotation
and floor elevation. Unsupported attestation/provider fields are discarded.
The original saved-view transaction still verifies committed geometry, hashes
asset dependencies and rejects changes racing publication. An identical retry
retains its ID and frozen inputs without regenerating or duplicating the record.

Load refreshes the library's current/historical classification, refuses dirty
or stale scenes, and verifies the loaded scene identity/revision/definition hash
and floor before applying the camera. It restores the original projection; Play
then reruns current local geometry checks. Private owner forks preserve paths,
source dependencies and immutable image bytes. Exports include the path in
`place-views.json`. Non-owner forks do not receive private saved camera views.

Scope: one-place perspective orbit paths, fixed pivot, no roll or off-axis
projection. Legacy static-atlas paths cannot be saved until atlas-byte provenance
is implemented. Old captures without paths require no migration. Full world
import/restore, historical-scene 3D replay and generated-video jobs remain open.

## Verification

The initial seven unit/component tests cover axis and metre conventions, round trips,
full-turn interpolation, endpoint/clamping behavior, insertion bounds, local
rig updates, manual interruption and animation cleanup. The focused camera and
saved-view suite passed 15 tests; TypeScript and focused production lint passed.

The geometry preflight added 14 more tests, including real Rapier collision and
visibility queries and stale-check UI behavior. The full web suite passed 202
files / 1,621 tests with unchanged coverage floors (79.00% statements/lines,
84.47% functions, 88.75% branches). Four camera/walk browser workflows passed;
after final cancellation hardening, all 21 focused camera tests and both
desktop/mobile camera workflows passed again. Initial real-physics tests needed
the same bundled Rapier ESM entry used elsewhere in this repo, not a physics mock.

Two Playwright workflows passed at 1280x900 and 390x900. They check analytic
camera-position deltas, actual changing/nonblank canvas pixels, keyframe edits,
play/pause, stable paused poses, mode-switch cleanup, a single replacement
canvas, mobile touch activation, keyboard scrubbing and no product POSTs.
Desktop/mobile screenshots were inspected. Environment: macOS, Node 26,
bundled Chromium, viewport/touch emulation, not a physical-device test. The
garden is a local structural fixture, not evidence of AI visual quality.

Failures retained: the initial mobile layout collapsed the canvas; added a
minimum canvas height and expanded mobile stage sizing. Next's development
badge intercepted the desktop Play button; the test now uses its session-only
Hide preference, retaining runtime-error checks. Its internal preference POST
is excluded specifically, not product writes. An intermediate run also timed
out during mobile startup; a fresh final run passed both workflows in 26.4s.

Saved-path persistence verification: 203 files / 1,631 web tests passed before
the registered-object-edit increment, with unchanged coverage floors (78.90%
statements/lines, 84.52% functions, 88.81% branches). Three successive complete
desktop/mobile mesh/camera workflows passed, including the final mobile scroll
handoff rerun (`test-results/saved-path-scroll/.last-run.json`). They preserve
paths across reload, cross-viewport projection fitting, owner fork and export;
edited geometry disables loading old paths. Four camera/walk regressions also
passed. These are local fixtures, not provider video or image-quality evidence.

Next: calibrated provider mapping with reference-based visibility/framing
evaluation and separately approved generation. The September 14 amendment in
`WORLD_BUILDING_GOAL.md` prioritizes this as part of one connected product
workflow, not a standalone camera-widget demo. Core creation, registered editing
and release requirements remain incomplete and must connect to that workflow.
