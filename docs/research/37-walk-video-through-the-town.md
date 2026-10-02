# 37. A walk video through the 3D town

Date: 2026-10-02. World: Lantern Quay (local live demo). Branch: #299.
Spend: $4.00 for two paid runs. Receipts:
`~/Videos/openflipbook/consistency-2026-10-02/walk/`.

The question: can a person walk a route at eye height through the 3D town and
get one video that stays on the route, with the same buildings throughout?
Research 36 answered this for an orbit around one building. This note answers
it for a walk.

## The route

The route is a straight 14 m walk north up Quayside Main Street into Lantern
Plaza. It uses the same `route` parameter as the /play "Walk it in 3D"
hand-off. The Copper Kettle is on the left, Bellfounder Hall on the right, and
the Plaza Stone Well is ahead. "Make walk video" saved 5 checkpoint views at
1.6 m, 4 m apart. The renders were checked before any spend: eye height,
facing north, buildings where the scene puts them.

## Results

| Run | Build | Keyframe gates | Legs | Video |
|---|---|---|---|---|
| 1 | backward warp | 0-3 passed (IoU 0.86-0.95). 4 failed (IoU 0.61, area 1.56) and was kept. | 4 of 4 landed (land 0.09-0.14) | 11.1 s. Believable for 8.6 s. The last leg morphs into a stone wall and rails that the scene does not have. Glassy halos around trees. |
| 2 | + keyframe retry, drop of a failed last keyframe, no blend across silhouettes | 0-2 passed. 3 failed after its retry and was kept. 4 failed after its retry and was dropped with its leg. | 3 of 3 landed (land 0.10-0.11) | 8.6 s. No invented geometry. The same houses, trees and benches throughout. Fainter outlines around trees. |

Both runs had no frozen frame.

## What holds

1. The walk geometry is right. Checkpoints at eye height along the route,
   keyframes at those exact poses, and H3 legs between them give a walk that
   reads as walking up that street. This is the result that map-derived box
   walks could not give (2026-09-24).
2. The gate catches the failures that matter. Both bad keyframes in run 1 and
   run 2 failed the gate. The product now retries once and drops a failed
   last keyframe, so a walk ends early rather than ends on invented geometry.

## What does not hold yet

- **Large near objects stay unpainted.** As the camera nears the well, the
  well fills the frame. Those pixels are holes, and qwen often leaves them
  in the render's grey. Keyframe 3 in run 2 failed for this reason, and a
  failed middle keyframe is kept as the best candidate, so the grey well shows.
- **Tree outlines.** Fainter after the silhouette fix, but still visible. They
  look like two trees slightly apart: the warped earlier tree and the new
  paint's tree.
- **Legs are sped up.** H3 moves for the whole 5 s clip, and the planned legs
  are about 2.9 s, so each leg plays about 1.8 times as fast. A shorter
  request would cost less.
