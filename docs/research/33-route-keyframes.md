# 33. Route keyframes: free probes (Phase 1)

Date: 2026-09-17. Spend: $0. World: Lantern Quay (`ofb_live_demo_20260914`).
Plan: geometry-locked routes and keyframe video (Phases 0-6).
Evidence: `~/Desktop/OpenFlipbook-route-2026-09-17/`.

The question: can a route video use keyframes that stay true to the world
geometry, and what must each part do? Four probes use existing data only.

## F1: Zoom-out parity: PASS after a fix

Unit test (`lib/layout-control.test.ts`): reparent the town under a wider
parent, then compute the enter camera and the block render from absolute
positions. The camera position and the visible buildings are identical.

The probe found a real bug. The ascend route gave the wider map the same
100x60 frame as the town map. On the live "Riverward Quarter" image the town
is at 0.43x, so every place on the wider map was 2-3x too large. Fix:
`providers/outward_frame.py` measures where the source sits in the new image
(normalized cross-correlation, score 0.745 on the live pair, 0.42 on an
unrelated image, gate 0.6). The route sizes the new frame from it.

## F2: Depth warp of the approved illustration: CONDITIONAL GO

Input: the accepted 960x960 Copper Kettle illustration and its saved depth
capture (view `1905c464`, orbit pivot, 20.1 units, 60° FOV). The probe
reprojects every pixel with depth into a camera turned about the pivot.
2x2 splats, z-buffer.

| Turn | Filled pixels | Unfilled inside content |
|---|---|---|
| 0° | 62.7% | 0.0% |
| ±15° | 52.8% / 54.4% | 6.4% / 0.5% |
| ±35° | 41.2% / 45.4% | 12.1% / 5.1% |
| ±60° | 26.2% / 30.3% | 24.9% / 20.2% |
| ±90° | 15.5% / 12.6% | 30.3% / 37.8% |

What the images show:
- 0° reproduces the illustration exactly, so the camera maths is right.
- At 35° the front wall, roof and windows stay on the building. The side
  wall that the source never saw opens as a hole, and far ground shows
  through it. The table under-counts this: leaked ground pixels count as
  "filled".
- At 60° and more, most of the visible building is unseen surface.

Decision: a warp is a valid start image only for steps of 35° or less, and
only with a hole mask from the scene depth at the target pose (a surface
nearer than the warped pixel = hole). Source depth alone cannot find
disocclusions. Keyframe checkpoints: at most 30° of yaw apart.

## F3: Do `/play` arrival images match their saved camera? NO, unless layout-controlled

The probe renders the world-map blocks from each arrival's stored observer
pose with the real `renderLayoutControl`, and overlays them on the image.

- Old camera (node `ff92f17d`, 29 units away, inside Bellfounder Hall): the
  pose expects a small, far inn (box width 0.075) behind the plaza well, with
  Lantern Watch on the left and Mapmaker House on the right. The image shows
  the inn at about 0.8 width, close up, with an invented gatehouse. The image
  and its pose describe different views.
- New camera with layout control (node `ebc7c5ca`, plaza): the inn is
  centred (image about 0.55 vs block 0.51), Ropewalk Store is on the left and
  the teal Tideglass Apothecary on the right, as the blocks say. The inn is
  about 0.73x the block width (estimated from the overlay).

Decision: an arrival generated without geometry control cannot be a route
keyframe or a warp source, because its stored pose is not its real pose.
Keyframes come from the scene capture at the exact route pose (Phase 2).
Layout-controlled arrivals are close enough for taps and ordering, not for
metric video endpoints.

## F4: H3 motion timing: first/last-frame clips hold at the end

Mean absolute frame change per frame, from the saved clips:

| Clip | Length | 90% of motion done by | End |
|---|---|---|---|
| H3 first/last travel, map to inn | 5.2 s | 3.00 s | frozen from 3.0 s (42% of the clip) |
| H3 object action, inn sign | 5.2 s | 4.42 s | eases out, no hold |
| H3 camera-controls arc 120-135° | 6.6 s | 5.75 s | even, no hold |
| H3 camera-controls rise | 6.6 s | 5.50 s | eases in and out, no hold |
| H3 camera-controls approach | 6.6 s | 5.46 s | even, no hold |

Decision: the stitcher must cut the frozen tail of first/last-frame segments
(last frame with motion above a threshold) and retime to the planned segment
duration. Camera-controls clips need no trim, but they have no end frame.
The Phase 4 bake-off must score both "arrives on the keyframe" and "no hold".

## Go / no-go for Phase 2

- GO: keyframes from the scene's depth and identity capture at exact route
  poses (`flux-control-lora-depth`, the path accepted on 2026-09-16).
- GO with limits: warp init (variant c) for turns of 35° or less, masked with
  target-pose depth.
- NO-GO: generated `/play` arrivals as keyframes, and warps past 35°.
- Checkpoint rule to start: 30° of yaw or the segment time limit, whichever
  comes first.
