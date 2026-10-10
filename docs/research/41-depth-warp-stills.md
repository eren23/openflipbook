# 41. Depth-warp stills: keep the pixels of the previous still

Date: 2026-10-10. World: the fantasy-town artwork from research 40. Spend:
$1.44 (6 qwen calls and 2 H3 legs. Research 40 and 41 together: $8.05 of a
$15 cap). Receipts, judge reports and tools:
`~/Videos/openflipbook/consistency-2026-10-10/` (not in the repo).

Research 40 found that video legs 4 and 5 fail because the stills P4, P5 and
P6 disagree: a sign vanishes and comes back, and the fountain moves sideways.
Each still came from a new nano-banana-pro generation. This note tests a still
step that cannot add or remove a feature, because it moves the pixels of the
approved previous still instead of painting new ones.

## Method

1. Depth: Depth Anything V2 Small on the previous still (local, no cost).
   Relative disparity d becomes depth z = 1 / (0.4 + d), scaled to median 1.
   The offset 0.4 flattens the near/far range.
2. Warp: move the camera forward by tz (in median-depth units) and turn it by
   a yaw and a pitch. The turn comes from a SIFT similarity fit between the
   two older stills of the same route segment. Forward splat of depth, then a
   backward sample of colour.
3. Finish: qwen-image-edit-2511 repaints the warped still with a short prompt
   ("one step forward, repaint stretched areas, add nothing, remove
   nothing"). The prompt names no landmark.
4. Composite: keep the warped pixels everywhere except real gaps and regions
   stretched more than 1.6x. Use the qwen pixels only there, after a SIFT
   alignment of the qwen output to the warp.

Two blind Sonnet judges review each still, as in research 40. One judge checks
source identity and counts doors, windows, signs and lanterns against the
predecessor. The other judge checks route context.

## Results

| Step | Settings | Result |
|---|---|---|
| P4 to P5 | tz 0.19, offset 0.1, full qwen repaint | 0 of 2: near stairs became a wall, chimney added on the glass roof |
| P4 to P5' | tz 0.107, offset 0.4, composite (78% warped pixels) | 2 of 2 pass both judges |
| P5' to P6' | same | 1 of 2 passes both judges. The other is UNCERTAIN |
| H3 legs P4-P5', P5'-P6' | 3 s, short prompt (research 40) | 2 of 2 pass both judges. Frame difference peaks at 6.2 and 3.7 |
| P1 to P2'' | tz 0.108, then 0.15 | fourth candidate passes. Three are UNCERTAIN on fountain size |
| P2'' to P3'' | tz 0.12, four composites | 0 of 4: the Forge at the right edge changes roof colour. Its hearth is not visible |

With arm E legs 1 to 3 from research 40, the walk P1 to P6' has five legs
that all pass. The joined clip is 15.2 s with no cut.

## Findings

- Keep the predecessor's pixels. Every failure came from regions that a model
  repainted: a full repaint added a chimney and changed the fountain finial,
  and a partial repaint changed the Forge roof.
- Make the keep mask from real defects. A 9 px erosion around 468 small depth-
  edge specks gave the repaint 22% of the frame. Ignoring specks under 200 px
  and growing only large regions keeps 97% to 99% of the frame.
- A small step with flat depth stretches less. With offset 0.1 and tz 0.19,
  72% of the lower-left third was stretched more than 1.35x. With offset 0.4
  and tz 0.107, 3% was.
- Judges cannot see an 8% size change in a full frame. SIFT measured the
  fountain at 1.083x, and two judges called it "about the same size". A pair
  of crops of the same window, enlarged by the same factor, resolved it.
- Give judges full paths. One route judge did not find the source map and
  passed the candidate without it. That review was repeated.

## Open

- Near buildings at the frame edge: a step forward stretches them and pushes
  them out of the frame. A repaint there changes colour, and judges cannot
  tell "left the frame" from "vanished". Options to test: a sharpening model
  instead of a generative repaint, or a turn that keeps the building in view.
- The method needs the first still from a generator. Errors in that still
  stay for the full walk.
- The product does not use this method yet. It needs a depth model in the
  backend and a gate on the keep fraction. n is small: 4 of 12 judged
  composites passed both judges, and 3 of them were used.
