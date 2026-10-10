# 40. Walk video legs: the prompt matters more than the length

Date: 2026-10-10. World: the fantasy-town artwork from the October 8 image-led
walk. Spend: $6.61 for 21 H3 legs and 3 stills (cap $15). Receipts and judge reports:
`~/Videos/openflipbook/consistency-2026-10-10/` (not in the repo).

The question: the six reviewed street stills P1 to P6 keep the buildings of the
source artwork. Every H3 video leg between them changed the architecture in the
middle of the clip. Is the leg too long, or is something else the cause?

## Setup

- Endpoints: the six stills that passed both visual judges on October 8, at
  their exact recorded SHA-256 hashes (1672x941).
- Model: `minimax/h3-max/image-to-video`, first and last frame, 768P, prompt
  expansion off. One leg per adjacent pair, so 5 legs per arm.
- Judges: two independent Sonnet agents per clip. One judged source identity
  (roofs, wings, bays, door and window order). One judged route context and
  temporal stability (start and end frames, cuts, morphs). Each judge saw frames
  at 4 per second and the reference images. Clip names were random, so the
  judges did not know the arm. Each verdict records the SHA-256 of the clip. A
  leg passes only if both judges pass it.

## Results

| Arm | Prompt | Length | Leg 1 | Leg 2 | Leg 3 | Leg 4 | Leg 5 | Pass |
|---|---|---|---|---|---|---|---|---|
| A | product v3 (landmark list + route JSON) | 5 s | pass | fail | fail | fail | fail | 1/5 |
| B | product v3 | 3 s | pass | fail | fail | fail | fail | 1/5 |
| E | short walking prompt, no landmarks | 3 s | pass | pass | pass | fail | fail | 3/5 |

- A and B fail in the same way. On legs 3 to 5 the camera swings toward the
  Bookshop, the Forge and the Inn, then comes back to the end still. These are
  the buildings that the v3 prompt names, and on those legs they are behind or
  beside the walker. On leg 2 the Forge front changes from a timber gable to a
  stone wall in both arms.
- Leg length had no effect: 3 s and 5 s gave the same result. 3 s costs 40% less.
- With no landmark names (arm E), legs 2 and 3 pass. Legs 4 and 5 each show
  one abrupt jump near 1 s (both judges point to the same frames). The rest of
  each clip is stable.
- The Wan VACE masked repair of the October 8 leg 1 (recovered by GET only)
  passed both judges. It was not needed: leg 1 passes without a repair.

## A free pre-screen

The mean absolute difference between consecutive frames (8 frames per second,
64x36 grey) separates the classes. Passing legs stay at 3 to 9. The A and B
detours stay at 12 to 26 for most of the clip. The arm E leg 5 jump shows as
one spike of 29. The arm E leg 4 jump peaks at only 11, so the pre-screen does
not replace the judges.

## What changed in the product

The image-led video profile is now `image-led-walk-video-v4`: the short prompt
from arm E, 3-second legs, $0.24 per leg at $0.08 per second. The image-led
walk stays off by default.

## Legs 4 and 5: the stills disagree

More tries on legs 4 and 5 all failed (0 of 8):

| Try | Leg 4 | Leg 5 |
|---|---|---|
| Short prompt, 3 s, second roll | fail: jump, chimney on the glass roof | fail: fountain doubles |
| Short prompt, 5 s | fail: cross-fade, fountain doubles | fail: camera swings to the fountain |
| Chained H3 from P4, no end still | route uncertain: drifts to the conservatory | not run |
| Chained H3, second roll | identity fail: a new roof with two chimneys | not run |

A direct comparison of the stills explains it. Adjacent stills disagree about
features that a small step cannot change:

- P4 to P5: the Inn's butterfly sign is gone in P5 (a flower basket hangs
  there). The fountain moves sideways.
- P5 to P6: the butterfly sign comes back, an arched window appears left of the
  Inn door, and the fountain moves right and gets smaller while the walker
  approaches it.
- P3 to P4 is a large change of framing, but nothing appears or disappears.
  Leg 3 passes.

A first/last-frame model must invent a change between such endpoints. The
October 8 still review compared each still with the source artwork, not with
its neighbour.

New stills from P4 did not fix this:

- The product still prompt (landmark list, route JSON, "the well's street
  adjacency") added a second Inn with its own sign and moved the well into
  view. This is the same failure as the v3 video prompt.
- A short prompt with only the previous still ("one small step forward, add
  nothing") kept every feature, but nano-banana-pro did not move the camera
  (mean difference from P4: 2.8, against 24.7 for the October 8 P5). A more
  explicit step prompt gave the same result.

## Open

- The still review must compare the door, window, sign and lantern inventory
  with the previous still, not only with the source artwork.
- The still prompt probably has the same problem as the v3 video prompt. One
  sample is not enough to change it.
- A still generator must move the camera and keep the inventory. With one
  previous image, nano-banana-pro does one or the other.
- Five legs on one walk is a go/no-go signal, not a statistic. Agent judges do
  not replace the owner's identity, route and temporal reviews.
