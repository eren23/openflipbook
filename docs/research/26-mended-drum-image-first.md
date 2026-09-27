# Mended Drum: Image-First Demo

Date: 2026-09-10

## Outcome

The primary experience is now the illustrated environment, not the primitive
3D blockout. Open `/sketch/world/ankh`: focus the real map pixels, enter
Filigree Street with an explicit cut, inspect the landmark anchors, compare
the original and saved teal-roof version, and open either image in native Sketch.

The film is `~/Desktop/openflipbook-mended-drum-image-first-2026-09-10.mp4`
(18.4 seconds). It uses the actual browser run, with generation/save/load waits
removed, plus a five-second closing hold of the saved candidate. It is silent.
It does not demonstrate continuous 3D traversal.

## Assets and Provenance

- Map: `apps/web/public/demos/ankh-morpork/map.png`, existing illustrated source.
- Camera guide: `street-geometry-guide.png`, a fixed 1600x900 Three.js render of
  `ankhStreetScene()`. Position (27, 2.2, 9.4), target (13, 2.8, 15.7), FOV 60.
- Street: `street-environment.png`, 1672x941, one built-in image-generation call
  using the camera guide as composition reference and map as identity reference.
  The tool did not provide a billable model ID; do not invent one.
- Edit: `street-edit.png`, downloaded from the real native Sketch candidate,
  generated through `fal-ai/nano-banana-pro/edit`.
- The two named versions in the viewer are saved assets. Clicking them does not
  generate, bill, or pretend to perform a new edit. Edit in Sketch imports the
  currently selected asset as a fresh editable source; it does not borrow another
  visitor's private draft.

## Geometry: What Is and Is Not Established

The authored scene and fixed reference camera remain intact. The generated street
roughly retains the passable street, near-corner barrels, foreground well, tavern
facade and doorway arrangement. The manual screen-space landmark buttons identify
image locations; they are NOT raycast or automatically calibrated 3D correspondences.

The model changed the roof silhouette substantially, added background architecture,
and invented surface details. The illustration is NOT an exact textured rendering
of the authored mesh. The map-to-street relationship is an authored demo association,
not a recovered metric reconstruction. Native Sketch creates a saved image/world
version; this does NOT automatically update the original place-scene mesh or UVs.

No high-quality multi-view textures or mesh reconstruction were shipped in this
pass. The cube button deliberately opens the existing authored geometry reference.
Before promoting it as continuous 3D, fit/validate camera and silhouettes, register
the image to stable object IDs, and test appearance from another camera. Do not
project this image onto the old blockout and call the unobserved surfaces solved.

## Real Edit Receipt

Source evidence: `assets/ankh-image-first-take3/receipt.json`.

- Draft: `c4337c8c-af1f-4714-a972-c14610f0e91c`.
- Model: `fal-ai/nano-banana-pro/edit`; candidate status ready; mock false.
- App reservation: $0.30. This is a reservation, not an audited provider invoice.
- Recorded generation roundtrip: 37.027 seconds.
- A rectangle was drawn through Excalidraw over the roof, then exported and checked
  before submitting the generation.
- `outside_changed: 0`. This is the application's protected-region compositing
  guarantee, not evidence that the raw model independently obeyed every boundary.
- Keep Version completed. Reload and Compare retained the saved candidate and
  Open in World link. Page errors: none.
- Visually: the roof changes to weathered teal, including some teal tint on the
  gable inside the selected rectangle. The edit preserves the surrounding street
  pixels. A rectangle is not an exact roof segmentation mask.

The uncut 73.16-second browser recording, drawing bundle, exported mask, prompt,
before/after screenshots and persistence screenshot are in the same evidence folder.
The real model run must not be repeated merely to replay or recut the film.

## Failure Found and Fixed

The first two submissions failed before any generation run was created. Detailed
multi-megabyte raster exports overflowed V8's regex stack in `rasterDataUrl`.
The validator now checks the bounded MIME header, scans for invalid payload
characters and validates only the short trailing padding. The accepted MIME types,
size cap and original base64 grammar remain unchanged. Regression tests include an
8 MiB payload, a late invalid character, malformed padding and an oversize value.

The failed receipts remain under `assets/ankh-image-first/` and
`assets/ankh-image-first-take2/`. They are not successful generation receipts.
Server-side preparation errors are logged, while the client retains generic errors.

The viewer also now remounts its artwork when changing map/street views, preventing
the map's 4x transform from leaking into the illustrated arrival.

## Verification

- Full web coverage suite passed. Statements/lines 79.18%, functions 82.84%,
  branches 88.05%; existing thresholds passed.
- TypeScript passed after correcting the new test's Testing Library matcher options.
- Browser checks passed at 1440x1000 and 390x844: map focus, clean street cut,
  landmark selection, saved versions, correct Sketch source/model and no automatic
  generation requests. Geometry guide recapture was intentionally skipped to
  preserve the exact input used for generation.
- The actual paid browser run independently exercised drawing, generation,
  comparison, keeping and reloading.
- Desktop/mobile screenshots and film contact sheets were visually audited.
- Production build passed with existing OpenTelemetry/Sentry bundling warnings.

## Reproduce Without Billing

From `apps/web`:

```sh
E2E_DRUM_ENVIRONMENT=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/drum-environment.spec.ts
node scripts/compose-drum-image-film.mjs ../../docs/research/assets/ankh-image-first-take3 ~/Desktop/openflipbook-mended-drum-image-first-2026-09-10.mp4
```

`record-drum-image-demo.mjs` is a separate explicit paid runner gated by
`DRUM_LIVE_EDIT=1`, a local URL check and refusal to overwrite an existing receipt.
Do not use it for free replay. The composer cuts the audited take; other takes
require a fresh frame audit because decoding times differ.

## Exact Street Generation Prompt

```text
Image 1 is the STRICT CAMERA AND GEOMETRY guide to transform. Image 2 is ONLY the world identity reference: the antique Ankh-Morpork map. Produce ONE beautiful highly detailed 16:9 full-bleed street-level environment image, as if we have entered the Mended Drum block from that map. This is NOT a map and NOT a low-poly screenshot. Preserve image 1's camera position, perspective, vanishing point, building silhouettes and footprints, street width, the central tavern's doorway location, exactly three upper windows on its front, the two barrels at its near corner, the round well clipped at lower left, and opposing buildings at right. DO NOT relocate the tavern entrance onto the broad blank side wall. Keep it on the narrow visible facade facing the street, under the three windows. Keep the street completely passable. Enrich surfaces radically: weathered lime plaster, beautiful crooked dark oak framing with real wood grain, chipped grey limestone foundations, old patched oxblood terracotta roof tiles, aged brass and wrought iron fittings, muddy uneven cobbles with small puddles, old paper notices and restrained street clutter at wall edges. The center-left red-roof building is THE MENDED DRUM, with a projecting carved wooden tankard sign in the same position as the guide, legibly reading THE MENDED DRUM. The street should feel like a richly authored fantasy adventure game environment with the illustrated charm and specificity of Discworld: detailed hand-painted realism, fine ink-influenced edges, varied dusty teal/grey stone/oxblood colors, soft clear afternoon daylight, warm amber window interiors. Add a few tiny weeds at foundations, wear and repairs, copper drainpipes, a small lantern near the actual tavern door. No people blocking landmarks. Preserve every major visible object and its screen position, do not add new buildings or change the camera. No modern objects, no HUD, no UI, no circular N badge, no watermark, no title overlay, no border. The whole image is the environment. High-end finished artwork, not flat material colors or primitive 3D. Keep the image aspect ratio 16:9.
```

## Exact Native Edit Prompt

```text
Change ONLY the central Mended Drum tavern's red terracotta roof tiles to weathered dark teal glazed tiles. Preserve the exact roof outline, ridge, tile layout, chimney positions, perspective, timber structure, and all other buildings. This is a material-only correction, not new architecture. Remove annotation marks. Do not change the sky, walls, signs, street, barrels or well.
```
