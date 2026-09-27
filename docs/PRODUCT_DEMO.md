# Full-product demo production

## Approved direction

A silent-first complete walkthrough of Openflipbook, not a fictional story or a
slideshow. Target 6-8 minutes with separately exported chapters. Start with one
20-second visual-quality pilot; obtain the user's review before scaling up.

Coverage is tracked in `product-demo-coverage.json`. Status describes available
evidence and capture readiness, not a blanket assertion of production readiness.
Developer/admin test screens and deployment operations are not product chapters.
Experimental user-facing capabilities stay in the inventory with honest limits.

## Tooling and access

Arcade was the first editor attempted. The user signed in through the connected Brave
browser. Onboarding now blocks on a public brand website; the public GitHub project
URL is explicitly rejected because it would import GitHub's branding. No unrelated
domain, subscription, public deployment, or publication has been supplied. The user
explicitly requested another route rather than waiting on that onboarding.
ngram also requires a new sign-in, and iMovie stalled opening its import dialog.
The active editing route is now local Remotion, using the same real UI footage.
`scripts/product-demo/` contains an isolated editable timeline and renderer.
This is not a still-image slideshow or generated imitation of the application.

Use video-only capture or real uploaded recordings, not HTML screen cloning.
Do not have a generative model redraw the application interface. Editorial polish
must preserve visible cause/effect, pointer order, and real result identities.
Growth currently gates MP4/GIF export; no paid plan purchase is authorized.

## Pilot

`apps/web/scripts/record-product-pilot.mjs` creates an isolated owned fork through
the normal public fork UI. It records native 1920x1080 browser interactions:
draw a 3x3 m house footprint, raise it to 5.5 m, orbit, change roof material, review,
apply, and reload. A small noninteractive pointer marker makes pointer actions
visible in the recording; it does not replace UI or alter product behavior.

Model-generation and animation endpoints are blocked. Assertions require one new
object, changed orbit camera, unchanged map before Apply, matching saved map and
scene geometry, preserved old objects and parent placement, unchanged reference
image, and persisted height/material after reload. The original world is not edited.

The first capture passed persistence checks but its generic color edit was visually
overridden by the street material pack. It is not accepted as a material-change
demo. Take 2 uses the explicit teal roof swatch, which changes the actual texture.
The generic-color affordance remains a separately tracked product issue.

### Current source result

Take 2: `docs/research/assets/product-pilot-take2-2026-09-11/receipt.json` is complete,
with zero generation submissions. The actual roof turns teal in both views and
persists after reload; visual inspection includes height, orbit and saved frames.
The raw capture is 1920x1080, 25 fps, without audio. Do not call it native 30 fps.

`~/Desktop/openflipbook-product-pilot-SOURCE-2026-09-11.mp4` is a 28.2-second
source trim starting at 19.24 seconds of the raw recording. Only setup and post-proof
tail are removed; the in-sequence save/reload waits remain. FFmpeg full decode passes.
This is upload-ready material, NOT the 20-second Arcade-polished/approved pilot.
No media has been uploaded to Arcade yet. Thirty-seven focused scene, scene-server,
and fork-route tests pass; syntax and whitespace checks pass. Full application suite
has not been rerun for these recording-only changes.

### Edited pilot, ready for review

Current revision: `~/Desktop/openflipbook-product-pilot-v2-2026-09-11.mp4`.
This retains the same footage and timing but explicitly labels the segment as
procedural 3D editing and identifies the House preset as not AI-generated geometry.
This clarification follows the user's questions about choosing and AI-generating
objects; those questions are not treated as approval of the full film's style.
The new export passed full decode, frame-count, dimensions and silence checks.
The changed first-frame labels were inspected at full resolution and fit without
overlapping the footage or each other. Original export and source remain intact.
Current SHA-256:
`ff86fc6c7d798369edb3956f0101ffcd628af7a1923cbc1b7cfe220585710c3c`.

`~/Desktop/openflipbook-product-pilot-EDITED-2026-09-11.mp4`
is the original local Remotion export: 20.68 seconds, 517 frames at 25 fps, 1920x1080,
H.264, one video stream and no audio. Full FFmpeg decoding passes. The timeline
played in Brave; rendered contact-sheet and full-size frames were inspected.
Height, orbit, actual roof change and the saved-state ending remain visible.
The source UI is fitted without cropping; editorial headings live outside it.
The final shot starts after the reload and explicitly labels the omitted wait.
This is an edited pilot, not the full master and not yet user-approved.

The editable timeline is `scripts/product-demo/src/index.tsx`; launch commands
and license link are in that directory's README. Studio runs locally at
http://localhost:3107. Automated media verification is reproducible with
`npm run verify --prefix scripts/product-demo`. It does not substitute for
human visual acceptance. Raw footage and the original proof receipt remain intact.

Export SHA-256:
`c2576763168f7ce2f51fd759ba1380ebdf464a9942cd64a48c1cd7c90664a425`.

```sh
node apps/web/scripts/record-product-pilot.mjs docs/research/assets/product-pilot-NEW-TAKE
```

Use a new directory for each attempt. A failure retains raw footage and its failed
receipt. Successful captures are source material, not accepted finished videos.
Review their actual resolution/frame rate before configuring Arcade export.

## Edit brief

- 20 seconds, silent, 16:9; no voice, music, fake application screens or stock shots.
- Start immediately with linked Plan + 3D. Show the complete footprint drag.
- Follow the selected object as its height changes, then preserve the orbit motion.
- Keep the material edit and its visual result connected.
- End with saved state after real Apply/reload. Short label: "Saved after reload".
- Trim setup and waits only. Label the save/reload time omission; do not imply
  network latency or rendering took 20 seconds end to end.
- No decorative device frames, giant subtitle boxes or full-screen intro cards.
- Keep controls readable and the resulting object in view. Reject automatic zooms
  that conceal which field changed or crop off the building.
- If the complete causal sequence cannot fit 20 seconds without losing clarity,
  report the timing conflict rather than accelerating or deleting an essential step.

## Gates and deliverables

Current capture preflight findings: `research/32-product-demo-preflight.md`.
The old minimap/scrubber overlap did not reproduce in the desktop browser check;
generic material color remains overridden on street-textured surfaces.

1. Source proof: passing receipt, nonblank/moving canvas and legible screenshots.
2. Working editor: local timeline and export, without hosted upload or paid signup.
3. Editorial pilot: verify downloaded playback and actual absence of audio.
4. Human visual review: user accepts/revises pilot before full production.
5. Full chapters: every coverage item is demonstrated or explicitly blocked/lab.

Deliver the approved pilot, master, chapter clips, editable project, raw recordings,
source timing manifest and coverage report. New paid model outputs need a separate
budget. Missing visual proof cannot be replaced by mocked results or prior claims.

Sources checked September 11, 2026:
- https://docs.arcade.software/kb/build/record
- https://www.arcade.software/pricing
- https://www.arcade.software/agents
