# 34. Keyframes at any camera (Phase 2)

Date: 2026-09-17. Spend: about $1.30 (probe calls below, plus 19 sam-3 mask
calls). World: Lantern Quay, The Copper Kettle, scene revision 4.
Evidence: `~/Desktop/OpenFlipbook-route-2026-09-17/p1-keyframes/`.

The question: can we make a picture of one place from any camera on a route,
so that two keyframes 30 degrees apart show the same building in the right
place? Camera A is the accepted close-up (azimuth 111.8, elevation 29.1,
distance 20.1). Camera B is the same but azimuth 141.8, saved through the
editor's camera path panel.

## How each attempt is scored

The saved camera's object pass gives the exact pixels of the inn. Each
output is segmented with fal sam-3 ("house") and compared to that mask:
overlap (IoU), centre offset in image widths, and area ratio. The gate from
the plan is centre within 3% and size within 20%. Scoring the plain render
against its own mask gives IoU 0.99, so the measurement itself is sound.

## Results

| Attempt | Model | IoU | Centre | Area | Verdict |
|---|---|---|---|---|---|
| Existing pipeline on camera B, seed 1 | flux-control-lora-depth i2i, strength 0.7 | - | - | - | almost the raw render; windows lost |
| Existing pipeline on camera B, seed 2 | same | - | - | - | raw render plus two invented windows |
| Style pass A | nano-banana-pro/edit | 0.61 | +5.1%, -6.0% | 1.54 | re-framed |
| Style pass A | flux-pro/kontext/max/multi | 0.59 | +6.9%, -9.7% | 1.23 | copied the reference's composition |
| Style pass A | seedream v5 lite edit | 0.61 | +5.7%, -0.6% | 1.53 | re-framed |
| Style pass A | flux-2-pro/edit | 0.60 | +3.4%, -7.1% | 1.56 | copied the reference |
| **Style pass A** | **qwen-image-edit-2511** | **0.944** | **+0.3%, -0.5%** | **1.00** | **passes, painted** |
| A registered (2D fit) then depth lock 0.35 | flux-control-lora-depth | 0.95 | -0.4%, -0.1% | 0.98 | geometry fine, details drift, invents text |
| B from style reference only | qwen-image-edit-2511 | 0.52 / 0.02 | huge | 1.48 / 0.22 | copied the reference |
| B from previous keyframe | qwen-image-edit-2511 | 0.94 / 0.53 | - | - | one seed left the render unpainted, one copied the reference |
| **B from warped keyframe A** | **qwen-image-edit-2511** | **0.931 / 0.938** | **within 1%** | **1.06 / 1.01** | **passes; unseen wall stays plain** |
| B warp then masked depth inpaint | flux-general/inpainting | 0.934 | +0.2%, +0.4% | 0.96 | invents a city panorama and new openings |
| B warp then second qwen pass | qwen-image-edit-2511 | 0.920 | -0.5%, -1.2% | 1.07 | plain side wall, sky drifts |

## What holds

1. **Qwen Image Edit 2511 keeps the camera.** Given the 3D render as image 1
   and the world's art as image 2, it repaints the render and leaves the
   geometry alone (IoU 0.944, size 1.00). Every other edit model tested
   re-framed the shot or copied the reference picture's composition. About
   $0.035 and 9 seconds.
2. **A keyframe carries to the next camera by warping, not by reference.**
   Passing keyframe A as a reference image does not work: the model either
   ignores it or copies it. Warping keyframe A into camera B with the saved
   depth, then asking the model to finish the result, keeps the same building
   (stone, tiles, sign, windows) and the camera (IoU 0.938).
3. **The 3D scene's depth is what makes the warp usable.** Camera B's own
   depth marks the surfaces A never saw (38% of the inn's pixels at 30
   degrees), so those are the only areas the model has to invent.

## What does not hold yet

- **Newly revealed surfaces are plain.** The side wall A never saw comes back
  as blank stone; a masked depth inpaint fills it, but invents openings and a
  whole background city. Neither is wrong geometry; both are new content the
  route did not ask for.
- **Backgrounds drift.** Sky and ground change between keyframes (white paper,
  clouds, lawn). For a route this must be pinned, probably from the map's own
  palette or a fixed sky.
- **Seeds are not equal.** The same prompt and inputs gave a usable keyframe
  and an unpainted render on two seeds. A keyframe pipeline needs the sam-3
  gate in the loop, with a retry, not a single shot.
- **The depth lock invents text.** flux-control-lora-depth at strength 0.3-0.5
  writes shop signs with words, adds plants and steps. It is a geometry fixer
  of last resort, not the main path.

## The keyframe recipe this supports

1. Capture render, depth and object passes at the route pose (already built).
2. First keyframe: qwen-image-edit-2511 with the render plus the world's art.
3. Each later keyframe: warp the previous keyframe with both cameras' depth,
   mark the unseen surfaces, and let qwen finish only those.
4. Gate every keyframe with sam-3 against the object pass (centre 3%, size
   20%); retry on a new seed when it fails.
5. Keep the checkpoint step at 30 degrees or less, which F2 and this probe
   both support.

## Receipts

Probe request ids are in `results_*.jsonl` next to the images; the two
pipeline jobs are illustration jobs `a25da3d3` and `50ec5bee` on view
`354fd219` (the saved camera B).
