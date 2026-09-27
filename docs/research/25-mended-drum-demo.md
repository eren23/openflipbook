# Mended Drum: Map And Authored Street

September 10, 2026. Implemented locally; not merged or deployed.

## Open

`http://127.0.0.1:3003/sketch/world?demo=ankh`

The first screen is the reference map. Focus Mended Drum zooms the same pixels;
Enter street cuts to a collision-aware guided walk. Plan, 3D, Walk, and Reference
remain available. Manual movement interrupts the guide. The rotation-arrow
button restores the entrance. The local demo does not save edits to a world.

## What Is Real

- A single 40 x 24 authored-metre scene with 21 editable components.
- One Mended Drum with a 10 x 5.4 metre footprint, 7 metre ridge, north-facing
  closed door, southwest chimney, and northeast frontage sign.
- Short Street junction, Filigree Street, opposite pale roof, well, paired
  barrels, east service passage, rear yard, and neighboring houses.
- A collision-driven approach and turn-back, using the same meshes throughout.
- Stable source illustration, material pattern, object identity, and plan on
  returning. No movement-triggered image or video generation.
- Tavern, house, well, and barrel components use the existing world scene
  schema, validation, transaction/history, and geo-mirroring services.

The camera follows (34.2,6) -> (34.2,10.4) -> (12.6,10.6) -> (12.6,12),
turning south, west, then south, before looking north and east. Eye height is
1.6 authored metres. The closed door and buildings have solid collision bounds.
No passage through a door or invisible room is claimed.

## What Is Not Established

This is a low-poly spatial prototype, not a finished art-directed environment.
The chart is an unofficial fan layout. The generator moved landmarks and uses
slightly elevated building symbols despite the strict plan-view request. It is
not a surveyed map or an automatically reconstructed 3D source.

The displayed Drum was visually located at approximately (43.4%,61.4%), replacing
the original prompt's target coordinate for the source-pixel zoom. Only local
topology is aligned: tavern south of Filigree, north-facing frontage, junction
to the east, and an opposite building. Roof dimensions, doors, scale, elevations,
and distances are independently authored, not measured from this image. A clear
cut separates illustration and 3D. No continuous map-to-eye-level reconstruction
or complete Brass Bridge-to-tavern world has been demonstrated.

The generated map and authored template are checked-in demo assets. Edited
local previews are not persisted across reloads. Persistence is available through
the existing owned-source Preview/Apply workflow, not the demo URL.

## Image Provenance And Prompts

Final project asset: `apps/web/public/demos/ankh-morpork/map.png`.
Built-in image generation was used, not the CLI or the app's fal/backend APIs.
Two calls: one generation using the copy-ready prompt in
`24-ankh-morpork-demo-prompt.md`, then one targeted edit because the first image
put Filigree south of the tavern. No further image or video model calls were made.

The targeted edit prompt was:

> Edit this antique Ankh-Morpork map. Preserve the overall chart, labels, river,
> furniture, palette and all other districts. Change ONLY the small Mended Drum /
> Filigree Street block south of Brass Bridge. Current red roof Mended Drum is
> wrongly NORTH of Filigree Street. It must be SOUTH of Filigree Street, front
> door on its NORTH face. Put Filigree Street running approximately west-east at
> image y=57%, from x=38% to x=51%, with a junction to Short Street at x=50%,y=57%.
> Put THE MENDED DRUM as one red-roof building centered x=45%, y=60%, wholly SOUTH
> of Filigree, facing NORTH onto it. Move the label with a short leader to its
> west without obscuring the building. Keep the roof ridge north-south and a
> chimney at its southwest corner. Put a pale roof opposite it north of the
> street, and a small circular well in the south-side pocket between the tavern
> and Short Street junction. Keep streets continuous and keep the Shades below
> the tavern, move its district label slightly lower if necessary. No second
> tavern, no second Filigree Street. Retain the rest of this image exactly.
> 16:9 landscape.

The correction improved the intended adjacency, but did not make the entire
image geometrically exact. The earlier prompt-only document records the brief
as it existed before generation; this document records the actual experiment.

## Verification

```sh
pnpm --filter @openflipbook/web test:coverage
pnpm --filter @openflipbook/web typecheck
NEXT_DIST_DIR=.next-world-build pnpm --filter @openflipbook/web build
E2E_WORLD_SCENES=1 E2E_BASE_URL=http://127.0.0.1:3003 \
  pnpm --filter @openflipbook/web e2e ankh-street.spec.ts world-scene.spec.ts
```

The street browser tests record uncut desktop/mobile video and screenshots in
`apps/web/test-results/ankh-{1280,390}`. They check loaded image pixels, real
camera displacement, the destination and look-back, closed-door collision,
nonblank canvases, return-to-entrance, identical plan pixels after orbit, the
same source image on return, overflow, and zero generation requests.

The direct-to-Walk test exposed concurrent Rapier initialization under mount
effects. A shared initialization promise now prevents invalidating live WASM
pointers, with concurrency/failure-retry unit coverage. A floor clamp prevents
physics contact tolerance from slowly reducing eye height on the flat plane.
The separate live-database E2E is opt-in and was not rerun for this street demo;
street persistence/history and entity mirroring have server-level regression
tests. Previously saved user worlds were not mutated.

Final local results: all 156 Vitest files passed; coverage was 79.33% lines and
statements, 82.88% functions, and 88.03% branches, above the existing floors.
The production build passed with existing dependency/lint warnings. The final
browser run passed all four desktop/mobile garden and street cases; the explicit
live-database case was skipped. The corrected direct-to-Walk path is covered in
both street cases. The full browser recording is also delivered as
`~/Desktop/openflipbook-mended-drum-walk-2026-09-10.mp4`.

The recording is functional evidence with the editor visible, not a composited
marketing film. The next visual work is better tavern-specific facade detailing,
less repetitive neighboring architecture, and art direction that relates the
street more closely to the chart. The next spatial work is an explicitly
authored matching interior and a real doorway connection, not another synthetic
camera dive.
