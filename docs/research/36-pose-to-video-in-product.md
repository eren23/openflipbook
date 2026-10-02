# 36. Pose to keyframe to video, measured in the product

Date: 2026-10-02. World: Lantern Quay, The Copper Kettle (local live demo,
`ofb_live_demo_20260914`). Branches: #296 (/play pose), #297 (keyframes),
#298 (path video). Spend: about $8.30, mostly reservations, with fal actuals
lower. Receipts: `~/Videos/openflipbook/consistency-2026-10-02/`.

The question: when the world knows a camera pose (place, height, gaze), does
the product now paint that pose, keep one place the same across poses, and
move between poses in video? Research 33-35 used scripts. This note uses the
product routes, the product gate and product prices.

## Free checks before any spend

| Check | Result |
|---|---|
| Warp of research 34 view A into view B | 37.8% of the inn is holes. The prototype gave 38.0%. The hole masks agree on 99.7% of geometry pixels. |
| `compareMasks` on the research 34 masks | 0.944, 0.931 and 0.938, as in research 34. |
| H3 first/last walk legs (route-video seg0-3) | Motion falls below 0.3 MAD at 4.2-4.5 s of 5.17 s. About 0.83 of a walk leg moves. The 0.58 in research 33 F4 came from the map-to-inn descent clip. |
| Motion end | Single-frame blips follow the end of motion. The end needs a run of at least 3 frames. |
| Land and snap on the same legs | Land 0.11-0.18 (limit 0.35). Snap 2.5-4.7 (limit 8). |

## Keyframes at a saved camera

Model `fal-ai/qwen-image-edit-2511`, 2 candidates per request, SAM-3 gate
against the object pass (centre 3%, area 0.8-1.2, painted check).

| Run | Camera | Result |
|---|---|---|
| Old accepted flux illustration (Sep 16) | A | The render with a few invented window holes. Not painted. |
| V1, first keyframe with art | A | Gate passed. IoU 0.965, centre within 0.4%, area 1.03. Painted. The door and windows sit where the 3D openings are. |
| V2, first keyframe with art | B (+30 degrees) | Gate passed (IoU 0.959). The camera holds, but the building is a different design: a sign, an arched door, other timbering. |
| V3, chain v1 (qwen finishes A's warp) | B | Gate passed (IoU 0.963), but every surface A did not see stayed raw render: a blank gable, a raw neighbour and ground, grey sky blocks. |
| V3, chain v2 (composite) | B | Gate passed (IoU 0.948). A's facade and roof carry over. The gable, neighbour and ground come from B's own paint. |
| Three more first keyframes | new paths | IoU 0.95-0.98, all painted and on camera, but three different-looking inns. |

What this establishes:

1. qwen-2511 with the 3D render as image 1 holds the camera at product
   scale: 7 of 7 first keyframes passed, IoU 0.93-0.98.
2. Independent first keyframes do not keep identity. Each paint invents
   its own facade. The product now defaults a new view to "continue from"
   the nearest accepted view.
3. A qwen pass over A's warp does not finish unseen surfaces (research 34
   saw the same). The fix is a composite: A's warp where B sees what A saw,
   and B's own gated paint in the holes. The seams fall on geometric edges.
4. Warped pixels from a surface A saw at a grazing angle are stretched.
   They show as diagonal stripes, and the stripes compound along a chain.
   Pixels stretched more than 1.6 times are now holes.
5. The sky must be one source for the whole path. Every sky pixel now takes
   the mean colour of the source keyframe's sky in its row.

## Path video

One motion study, azimuth 120 to 240 degrees, elevation 25, distance 22,
10 s, 5 checkpoints, 4 legs. Quote $2.00 (4 keyframes at $0.10, 4 legs of
5 s at $0.08 per second). Each run took 2-6 minutes.

| Run | Build | Result |
|---|---|---|
| 1 | composite chain | Motion and geometry right. Look decays: striped walls, patchwork sky, render-green ground and roof. |
| 2 | + stretch mask, full sky pin, agreement pick | Sky fixed. Roof, ground and back walls still look like the render. |
| 3 | + chain paints get the world art and keyframe 0's prompt | The same inn through 120 degrees. The ground and sky hold, and the neighbours match. |

All three runs: 10.67 s, no frozen frame (no run of 0.3 MAD or less),
largest frame change 1.9 times the median, 4 of 4 legs landed (land
0.07-0.12, snap 1.8-2.9). Run 3: 4 of 4 chain keyframes passed the gate.

Run 2 failed for a reason the gate cannot see. The path video sent chain
keyframes with no art and the prompt "Match the accepted artwork". Without
art, qwen returns a flat cartoon restyle that keeps the render's colours.
That restyle differs from the render by 22-41, and a real paint by 46-54,
so a painted threshold of 12 passes both. The fix is the input, not the
threshold.

Still visible in run 3: a fine cross-hatch shimmer on walls in the middle
legs, and a few dashed outlines on the ground.

## Camera-controls adapter v2

| Shot | Request | Result |
|---|---|---|
| C1, push | el 10, d 44 to 33 (r = 0.75), sent as 0.58 | The inn, tree and bench grow and move as the geometry frames predict. Final framing within about 10% by eye. Clip 6.58 s for a 6 s plan: the duration check passes (ratio 1.097). |
| C2, orbit | az 120 to 140, d 48 | The look holds and the inn stays centred. Near objects move about half as far as a true 20 degree orbit. |

The distance gain from the 2026-09-27 calibration works. The orbit
under-delivers as that calibration said. For orbits, use a path video.
Close shots with only one building cannot pass the existing rule that needs
two landmarks.

## /play enter with the layout image

One live enter (Tideglass Apothecary). The layout image was attached and the
instruction said "facing south-west". The left-to-right order and scale
matched the blocks. Two faults:

1. The instruction listed two in-frame buildings as behind the camera. The
   sight test used parent-local positions with an absolute observer, and
   only the centre point of each building. Fixed in #296 (footprint
   corners, one frame).
2. The painting wrote the legend names into the street. The legend
   sentence now says the names only identify the blocks.

## What this does not establish

One place, one path, one seed per run. The painted threshold cannot tell a
restyle without art from a real paint. No automatic check measures the
cross-hatch shimmer or the drift between independent first keyframes.
