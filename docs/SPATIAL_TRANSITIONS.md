# Spatial Transitions

The transition contract preserves evidence about a saved parent/child edge.
It is not a reconstructed camera path or a guarantee that the generated child
depicts the correct place.

`transition_context` is optional on node reads. Version 1 binds the source node
and immutable image key to a normalized target point, optional source-image
bounding box and geo identity, target provenance, and source/destination camera
snapshots. The server derives the source image key from the authorized parent;
clients cannot choose another image. A direct tap remains the motion target
even when the available entity box has a different center.

Context is frozen when the child is saved. Later extraction and camera edits
do not rewrite that historical evidence. Fresh page state and reloads carry
the same context. Forks remap node references without copying images; world
exports include the context. Older nodes remain readable without backfills
or additional provider calls.

Source-pixel playback and its opt-in navigation integration are separate from
this data contract. The existing generated-video route and defaults are not
changed by recording context.

## Shared Player And Study

`lib/spatial-transition.ts` plans direct descents and their reverse. It uses one
uniform affine transform, clipped to the image's actual contain rectangle.
Map views use a 0.42 crop (800 ms); scene/unknown views cap at 1.35x (450 ms).
Both hold for 100 ms before an explicit cut. Edge crops clamp inside the source,
so no pixels, borders, rotations, or hidden geometry are invented. Existing
camera snapshots remain informational, not a promise of physical travel.

`useSpatialNavigation` decodes the destination first. Failed loads retain the
source and retry decoding only. Cancellation invalidates old decodes and RAF
callbacks. Direct back cuts to the real cropped parent before reversing the
same transform. Unrelated, edit/expand/ascend, missing-target, stale-image, and
reduced-motion transitions cut. Legacy direct edges can use their saved tap;
a present but mismatched immutable context never falls back to that heuristic.

Run the local comparison at `/dev/spatial-transitions` with `SPATIAL_STUDY=1`.
The page and allowlisted fixture endpoint are unavailable in production.
Three map failures compare source pixels with the six already-saved H3/LTX
clips. Scene controls use left/center/right crops of existing scene images.
The control destinations are real source crops, not newly generated places.

Offline MP4s, audit stills and a hash-bearing receipt use the same planner:

```sh
cd scripts/record-demo
pnpm exec tsx spatial-study.ts /path/to/output
```

Requires the existing demo-tool dependencies and FFmpeg. No model calls or
network access. Exports add a 500 ms initial inspection hold; production motion
timings are unchanged. CPU exports use nearest-neighbor resampling; the browser
uses native image resampling, with identical transforms. Comparison order is
source pixels, saved H3, saved LTX. Destination identity failures remain failures;
motion correctness is separate from identity and human-rated continuity.

## Opt-In Navigation

Build with `NEXT_PUBLIC_SPATIAL_TRANSITIONS=1` to use this player for fresh
arrivals, saved revisits, history/breadcrumb navigation, arrival replay, embeds
and tours. It remains OFF by default. Docker/Compose forward the build argument.
No environment file or production setting is changed by the implementation.

The source stays still throughout generation and persistence. Existing strict
world acceptance policy still applies; this flag does not promote an unverified
destination. After destination decode, the shared controller commits the image,
title, URL and trail at the cut. Decode failure exposes an image-only retry,
not a new generation request. Direct back cuts to cropped parent pixels first,
then pulls out. Taps are withheld during reframing because the normal click
resolver operates on the untransformed image. History navigation can cancel
the animation; the latest navigation wins.

The opt-in flag suppresses `NEXT_PUBLIC_DESCENT_AUTO`, even if both are set.
Arrival replay uses no video API. Already-saved generated clips remain under
the separate Generated clip control. Ambient animation remains a separate,
explicit user action. Flag-off retains the previous player and video behavior.

CI runs the mocked browser suite in both modes. The opt-in build also sets
DESCENT_AUTO=1 and asserts no animation requests during generation, navigation,
reload/continue and replay. Geometry tests, image-load lifecycle tests, viewer
commit tests, and desktop/mobile/landscape browser screenshots cover the new
surface. This does not reconstruct geometry or repair a wrong destination.

## Persistent Local-Scene Study

The [lighthouse v2 study](research/20-persistent-lighthouse.md) is a separate
offline route at `/dev/spatial-transitions/lighthouse-v2`, gated by
`SPATIAL_STUDY=1` and unavailable in production. Its versioned authored geometry
and fixed materials support real camera translation and return, with source
evidence and assumptions visible in the reference dialog. It retains a paused
camera state in its own versioned browser-storage key, not in a user's world.

This is not an extension of the source-pixel player, an automatically recovered
place, or a new navigation default. The camera follows a tested exterior path
and never enters an unknown interior. Desktop/mobile browser checks verify
nonblank rendering, return/reload and no generation requests. Fidelity to the
original artwork remains a separate review gate before any app integration.

The [fixed-surface comparison](research/21-fixed-lighthouse-surfaces.md) at
`/dev/spatial-transitions/lighthouse-surfaces` reuses that unchanged geometry and
camera route, adding object-space materials plus baseline/clay switches. It has
its own versioned study state, no generation endpoints, and the same production
gate. Its baseline mode is tested against the original v2 page's pixels. The
surface treatment is authored and not a reconstruction or structural correction.
