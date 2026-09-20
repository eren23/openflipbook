# 35. What the silhouette gate says about the keyframe recipe

Date: 2026-09-20. Spend: about $0.44 (5 generations, 11 SAM-3 masks).
World: Lantern Quay, the carved lane walk, camera 0, Ropewalk Store.
Gate: `make eval-silhouette` (research 33/34's successor — see PR 272).

The question: the keyframe path feeds the model a LINE DRAWING of the town's
boxes. That choice was made by eye, on 2026-09-19, by looking at two images
and preferring the prettier one. Now there is a number, so ask it again.

## Results

One camera, one building, one prompt per arm, seed 22 unless stated.

| arm | what image 1 is | IoU | width ratio | centre dx | area ratio |
|---|---|---|---|---|---|
| massing | line drawing of the boxes | 0.376 | **1.146** | -0.109 | **1.623** |
| depth | the depth buffer, near-white | **0.816** | 0.932 | +0.012 | 1.086 |
| depth + outline + art (s22) | depth, then outline, then art | 0.805 | 0.932 | +0.010 | 1.043 |
| depth + outline + art (s11) | same, other seed | 0.815 | 0.929 | +0.013 | 1.094 |
| flux-control-lora-depth | depth as a control LoRA | - | - | - | - |

Width ratio is painted ground extent over the stored footprint's; 1.0 is
exact. IoU is whole-silhouette overlap, and a box is a proxy, so a pitched
roof above a flat box top lowers it honestly. Read width first.

## What holds

1. **The line drawing is the least faithful input of the three.** It paints a
   building 15% wider than its plot with 62% more area than the box, and its
   whole-silhouette agreement is less than half the depth arm's. The choice
   made by eye was the drifting one; the prettier picture was the wrong
   picture.
2. **Depth conditioning more than doubles silhouette fidelity** — 0.376 to
   0.816 — with width inside 7% and centre inside 1.2% of frame.
3. **It is seed-stable.** Two seeds of the same arm came back 0.805 and 0.815,
   a spread of 0.01. Research 34 warned that "seeds are not equal" on the
   style-pass path; on the depth path they are.
4. **Adding the art reference beside the depth map does not bring the style
   back.** The three-image arm matches the depth-only arm numerically (0.805
   vs 0.816) and visually: same flat-roofed, sparse street, a few more clouds.
   When a depth map is image 1, depth wins and the art is decoration.
5. **`flux-control-lora-depth` returned its input almost unchanged**, so the
   segmenter found no building to measure. That is the third independent
   sighting of this behaviour (research 34 recorded it twice), and the model
   is still what `illustration_generation.py` ships.

## The trade, stated plainly

There is no arm that is both. Depth conditioning buys geometry and spends the
art; the line drawing buys the art and spends the geometry. The thing that
would buy both is a depth ControlNet stacked on the model that already holds
the camera — and **fal does not host one for the Qwen-Image family**. Six
endpoint ids were probed (`qwen-image-edit-2511`, `qwen-image-edit`, `-plus`,
`qwen-image`, `qwen-image/image-to-image`, and two ControlNet spellings); the
four that exist expose no control or depth parameter at all. The InstantX
ControlNet Union weights are Apache-2.0 on HuggingFace and would need a GPU
this project does not have.

So the choice is a product decision, not a technical one:

- **A route video whose buildings are where the map says** wants the depth
  arm, and will look sparse until the proxy improves.
- **A page a person looks at** wants the line drawing, and will drift.

The third path is to make the proxy worth conditioning on: fit roofs to the
footprints (5-way type classification, then straight-skeleton geometry) so
that "follow the depth exactly" and "looks like a town" stop being opposed.
That is the argument for doing the roof work BEFORE picking a side here.

## What this does not establish

One building, one camera, one prompt per arm. The massing arm's own number
moved from 0.535 to 0.376 between two runs that differed only in prompt
wording, so the measurement is sensitive to phrasing and these are not
tolerances. The gate measures agreement with the stored footprint and has no
opinion about whether a picture is good.

## Receipts

`armB_massing.png`, `armB_depth.png`, `armB_fluxdepth.png`, `armB_both22.png`,
`armB_both11.png` and the two contact sheets, with fal request ids in the
probe output. Masks and per-row measurements from
`tests/world_bench/silhouette_masks.ts` + `silhouette_runner.py`.
