# 42. Copy-first stills and the gate re-judge

Date: 2026-10-10. World: the fantasy-town artwork from research 40 and 41.
Spend: $0.62 for generation (the start-still tries) and judge tokens. Research 40
to 42 together: $8.67 of a $15 cap. Receipts, judge reports, gate files and tools:
`~/Videos/openflipbook/consistency-2026-10-10/` (not in the repo).

Research 41 stopped at P3'' of a new route from P1. The judges said that the
Forge roof at the right frame edge changed colour. This note finds the cause,
tests stills that contain only copied pixels, and runs the preview gate on the
full walk.

## The Forge doubt was not a repaint

- In candidate R3k, the repaint covered 0.9% of the frame. In the repainted
  blobs on the Forge, the mean colour of the composite and the warp differs by
  2 levels or less. The repaint did not change the roof.
- The step moves edge content out of the frame. A depth projection shows that
  80% of the hearth and the right 29% of the roof leave the frame. A local SIFT
  fit agrees: the hearth moves to x 1649 to 1763 in a 1672 px frame.
- The crop tool for judges had a bug. Near a frame edge it moved the window
  into the image, so the two crops did not show the same window. It now pads
  the outside area with flat grey and fits the similarity near the landmark.

## Method changes

1. Background-copy fill. A gap that a near object uncovers gets the
   predecessor pixels at the farthest depth within 15 px, not an inpaint. A gap
   outside the predecessor frame stays a gap.
2. Provenance check. The check runs the warp again from the recorded
   predecessor, depth settings, step and turn, and compares the bytes. "COPY"
   means no gap, no inpaint and no model pixel in the box.
3. Owner rule: a provenance result of COPY can settle a colour claim on a still
   that is only a warp. Claims about shape, inventory, position, route or
   missing features still block.
4. Copy-first step. Warp the approved predecessor with background-copy fill.
   If there is no gap, the warp is the candidate and costs nothing. If a turn
   makes a new edge strip, a model paints only that strip.

## Results

| Candidate | Change | Judges |
|---|---|---|
| P3'' R3w | pure warp, inpaint in 39 gap pixels | route PASS. Identity FAIL: "roof deep red to orange-brown" |
| P3'' R3x | pure warp, background-copy fill | PASS both. Provenance COPY over the full frame |
| P4'' | pure warp, tz 0.15, 2.6 degree left turn, 0 gaps | route PASS. Identity UNCERTAIN: "Forge and well smeared at the right edge" |

The R3w colour claim is not in the pixels. Each roof pixel that stays in the
frame has the colour of its predecessor pixel: median difference 1 of 255 per
channel, the same hue and saturation. The 39 inpaint pixels made R3w fail the
provenance check, so the rule could not settle the claim. R3x then passed
without the rule.

At tz 0.15, 2% of the P4'' frame stretches more than 1.6x. At tz 0.12 (P3''),
the judges found no smear.

## Gate re-judge of the walk P1 to P6'

The preview gate needs a binding that research 40 and 41 did not record:
route intent, building source rectangles and a review index. A template match
found each building crop in the source map with a pixel difference of 0. Two
blind judges per still then wrote reports with the gate binding.

| Still | Source identity | Route context |
|---|---|---|
| P1 | FAIL | FAIL |
| P2, P3, P4, P5', P6' | PASS | PASS |

The gate result is REJECTED at position 1 only.

- Identity: the Forge chimney and roof wings, the Bookshop upper windows and
  the Inn roof wings differ from the source map.
- Route: the view faces the harbour and the Bookshop, not the start heading.

P1 is the start of both walks. R-P2 and R-P3 are warps of P1 pixels, so they
keep the P1 architecture. The October 8 review passed P1. The gate task, with
an explicit heading and the roof-wing and window rules, did not. The same Forge
passes in P2 to P4, so the judges also vary.

A new video gate for 3 s legs (`video-gate.mjs`, local) binds each leg to its
start and end stills through the spend ledger. All 5 legs bind. The gate
rejects the walk because the stills are not cleared.

## Findings

- A still that only copies pixels cannot add, remove or recolour a feature.
  With background-copy fill, a forward step with a small turn needs no model.
- The judge is the weak part for such stills: a judge saw a colour change that
  the bytes do not contain. Give judges same-window crops, and measure the
  pixels before a model repaints anything.
- Copy-first stills keep a bad start. The start still is now the limit for the
  walk.

## Follow-up: a new start still

The walk needs a start still that passes. Four tries, $0.62 in ledger
reservations:

| Try | Change | Judges |
|---|---|---|
| New P1, 2 seeds | nano-banana-pro with no prior still: map, 4 crops, route heading | route FAIL 2 of 2: a view from above, like the map |
| Walk from P2 | no P1. Gate over P2 to P6' (5 positions) | route PASS 5 of 5. Identity UNCERTAIN at P2 and P4, so REJECTED |
| P2, Forge repair, 2 images | qwen-image-edit-2511 in the Forge box only, source crop as image 2 | identity FAIL 2 of 2. One image copies the map crop with its label text |
| P2, two-building repair, 2 images | Forge box and left box, labels removed from the crops, well kept | route PASS 2 of 2. Identity UNCERTAIN and FAIL |

Outside the repair boxes, each repair is byte-identical to P2.

The two-building repair changed the wrong building. The large teal building at
the left of P2 is the Inn. The Bookshop is the green lean-to at the left edge.
The agent that measured the boxes had only the Bookshop and Forge crops. It
matched the Inn to the Bookshop. A judge before it made the same mistake.

- Identify each building against all source crops before a repair. An agent
  that gets only the target crop finds that target in the image.
- A model can copy a reference crop with its map label. Remove the labels from
  reference crops.
- Judges give different verdicts on the same pixels: the conservatory and the
  Inn roof in P2 passed in one run and were doubtful in the next.

No walk is presented.

## Open

- A start still that passes strict identity and the start heading. Four tries
  failed (see the follow-up).
- Larger steps without smear: a sharpening pass, or more steps of tz 0.12.
- The product does not use copy-first stills yet.
