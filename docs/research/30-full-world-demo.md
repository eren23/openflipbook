# Full world demo: images, geometry, expansion and revisits

2026-09-11. Implemented and tested locally; not committed, merged or deployed.

## Watch

- Desktop `openflipbook-full-world-TOUR-UNCUT-2026-09-11.mp4`: short continuous
  browser replay of saved results. Shows a real fork, map comparison, street,
  textured 3D orbit, tavern interior, four directional expansions, a second
  workshop interior, and the atlas. Zero generation submissions; the recorder
  blocks `/api/generate-page` instead of pretending to generate instantly.
- Desktop `openflipbook-full-world-CREATION-PROOF-UNCUT-2026-09-11.mp4`:
  34:58.80 continuous creation recording, including a long idle review stretch.
  Shows drawing a workshop footprint, changing the tavern, saving geometry,
  native Sketch map repaint, both real interior generations and real BRIA
  expansion. No cuts, crop, retiming, composited shots or substituted imagery.
  The harness timed out during export, so its receipt remains FAILED; do not
  misrepresent it as an uninterrupted successful export test.
- `assets/full-world-demo-take4-2026-09-11/world.zip`: successful separate export
  retry, 10 pages, all four distinct expansions, both interiors, scene revisions,
  map artwork records, entity registry, source reference and material atlas.

The short replay's raw video, screenshots, timings and successful receipt are in
`assets/saved-world-tour-take6-2026-09-11/`. The original creation evidence and
visual decisions are in `assets/full-world-demo-take4-2026-09-11/`.

Original world: `a1ea5283-c4ae-41da-85fb-81f52800b9ac`.
Replay fork: `session_f682f0a9-c1ea-4dcc-a53f-5860c2460ca9`.

## Bugs found and fixed while recording

1. Cold click classification truncated with a 400-token ceiling. Raised to
   1600; live interior requests subsequently ended normally and routed to
   eye-level interior rendering.
2. Imported street images had no view classification and were treated as maps.
   Imports now declare map/street projection without fabricated camera poses.
   Uncalibrated perspective taps cannot use map-coordinate hit testing.
3. Explorer navigation replaced its URL with the read-only `/n/` route. It now
   preserves `/play?continue=...&node=...`; saved back/forward and reload were
   checked in the connected browser. Around selections also stay in the explorer.
4. All expansion saves reused one idempotency key, collapsing four results into
   one persisted node. Keys are now per tile while retaining the common trace.
5. Perspective outpainting discarded the street classification, so subsequent
   entry became another aerial view. The backend now carries the projection
   kind through outpainting, dropping uncalibrated observer/crop/focus data.
6. Forks were left unowned, making creator-only geometry inaccessible until
   another write. The fork route now claims only the new copy for its creator.

Recording harness corrections: fresh output directories prevent stale decisions;
wait for complete images, not only nonzero natural dimensions; use a longer ZIP
timeout; redact cookie headers from saved failure logs; open atlas in the recorded
tab. The short replay uses native keyboard selection for overlapping minimap tiles.

## Verified

- Both real interior images pass visual review: tavern and craftsman workshop.
- The workshop view retains the well as a visible reference outside its doorway.
- Back/forward revisits submit no generation requests.
- Four distinct expansion nodes persist with street classification, confirmed in
  the exported graph. BRIA outpainting was enabled in this environment.
- The map repaint shows both the teal tavern roof and separate oxblood workshop;
  the protected exterior of the mask has zero changed pixels.
- Repaint leaves saved geometry and world-map records unchanged; accepted artwork
  survives reload. The original map remains selectable.
- Saved textured 3D is nonblank and responds to orbit; screenshots were inspected
  and canvas-region RGB variation checked.
- 100 focused web tests, 175 backend classifier/expansion tests, TypeScript and
  `git diff --check` passed. This is not a claim of a full-repository test run.

## Remaining limits

This is image-based world exploration with authored geometry, not a reconstructed
continuous 3D world. Interiors are imagined; exact exterior/interior correspondence
has not been established. Outpainting expands an image plane, not calibrated
movement through space. Map registration is manual and approximate.

Map repaint does not automatically repaint every street/interior image. The
street shown is its original saved exterior version even after the map and 3D
roof change. The newly drawn map workshop and the later workshop interior reached
through an existing doorway are distinct places; do not claim they are one bound
object. Minimap tiles can overlap and block pointer selection; keyboard navigation
works, but the pointer layout still needs repair. The long recording is evidence,
not a polished public-facing film.

## Reproduce

With the configured local web app on port 3003 and backend on 8003:

```sh
cd apps/web
FULL_EXPLORATION=1 node scripts/record-map-roundtrip.mjs /absolute/new/output-dir
node scripts/record-saved-world-tour.mjs /absolute/creation-dir /absolute/new/tour-dir
```

Creation incurs real model charges and pauses for visual decision JSON files.
The saved replay requires no image generation and uses the normal public fork
workflow to obtain its own editable copy, without copying credentials.
