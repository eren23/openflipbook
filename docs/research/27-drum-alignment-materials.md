# Drum Alignment and 3D Materials

Date: 2026-09-10

Follow-up: `28-connected-drum-world.md` adds canonical persistence, connected
image/Sketch navigation and the explicit roof/rear-depth fit. The text below
records the earlier local-only study, not the latest persistence capabilities.

## Delivered

Local route: `/sketch/world/ankh/geometry`, linked from the image-first street's
cube button. The image-first route remains the main demo.

The new scene uses the same authored object identities, footprints and entrance.
It adds an inspectable vertical-profile fit, a rejected free-camera fit for
comparison, fixed mesh-space bitmap materials, a short camera-travel control,
orbit inspection, raycast object selection, and an explicit Drum-only roof
material adjustment. A translucent source-image overlay and reprojection markers
are available only at the matching camera. Moving the camera disables them.

This is a local study. It does not silently modify a persisted world, transfer the
previous image edit onto a mesh, or claim the hidden faces were reconstructed.
Roof material changes are explicit preview changes, not saved world revisions.

## Alignment Receipt

Source: `apps/web/public/demos/ankh-morpork/alignment-observations.json`.
Fit: `alignment-fit.json` in the same folder.
Implementation: `scripts/record-demo/fit_drum_camera.py`.

Eight features were manually annotated on the 1672x941 street image. Six are used
in optimization; the door threshold and estimated well-rim center are check
features excluded from the objective. They were used for model selection, so
these are not independent unseen test data. Partial occlusion makes the well's
center an approximate annotation.

| Candidate | Fit RMS | Check RMS | Decision |
| --- | ---: | ---: | --- |
| Original | 86.79 px | 28.18 px | Baseline |
| Free camera and heights | 11.25 px | 51.40 px | Rejected as default |
| Fixed camera, vertical profile only | 44.81 px | 28.18 px | Provisional preview |

The free fit moves the well away from its image position while improving the roof
corners. That is precisely the kind of misleading success the check catches.
The selected candidate changes the eave/ridge heights to approximately 6.117 and
9.998 authored metres; it does not change camera intrinsics/extrinsics, X/Z,
width/depth, headings, IDs, other objects, or the entrance. The three.js
projections are tested against the independent Python implementation to six
decimal places.

The rear-eave residual is still about 86 px. This is not exact reconstruction,
nor a proof of metric scale. The image changed the building's apparent footprint
and contains perspective/architectural inventions. A single source cannot settle
the dimensions and appearance of unseen surfaces. Further footprint changes must
be explicit proposed geometry revisions, not invisible image-driven mutations.

The runtime camera is tested at its exact reference pose. Initial OrbitControls
polar limits were found to lift that pose; those constraints were corrected and
the camera-position checks now prevent the regression.

## Materials

Asset: `apps/web/public/demos/ankh-morpork/material-atlas.png`.
One built-in image-generation call produced four quadrants: limestone, plaster,
terracotta and oak, using the existing street image as material/style reference.
The exact tool model ID and invoice cost were not supplied.

Each material uses object-space UVs baked into the actual geometry. The viewport
camera is not part of texture lookup, so surfaces do not slide with it. Atlas
quadrants are sampled into separate runtime textures to avoid cross-quadrant
bleeding. Color maps use sRGB. Repeated roof/body parts keep fixed object-space
scale. Luminance-derived bump is an appearance proxy, not a measured displacement
or normal scan. Unseen faces use synthesized reusable material, not recovered
photographic detail.

The teal roof control recolors only meshes tagged as roof surfaces belonging to
the Drum object. It leaves the adjacent house roofs and ground geometry alone.
This is a deterministic mesh-material edit, not a second paid model call and not
an automatic conversion of the native Sketch candidate.

Materials are loaded only in this study. The existing general scene renderer
retains its default appearance and accepts the optional per-object eave heights
for the preview. Shared texture disposal now deduplicates map/bump/normal/roughness
resources.

Repeated parts are batched only within matching object ownership and material.
Unit tests preserve world bounds and keep neighboring object IDs separate, so
batching does not break raycasting or change which roof a material edit affects.

## Verification and Evidence

- Full web coverage suite passed: 78.65% statements/lines, 82.79% functions,
  88.03% branches. Existing floors unchanged.
- Unit tests compare the Python/Three.js projections, preserve source identity and
  footprints, reject the camera fit as default, and verify repeatable non-mutating UVs.
- Desktop/mobile Playwright checks exercise loaded texture counts, nonblank canvas
  pixels, exact calibrated camera position, second-view pixel changes, roof edits,
  overlay gating, reset, profiles, and untextured fallback. Generations are blocked.
- Screenshot evidence: `apps/web/test-results/drum-geometry-{1440,390}/`.
- Recording: `docs/research/assets/drum-geometry/`; all motion is the actual
  interactive Three.js viewport. Recording and replay make no model calls.
- TypeScript and production build passed (existing Sentry/OpenTelemetry warnings).
- Final desktop/mobile browser rerun passed. New proof film:
  `~/Desktop/openflipbook-drum-3d-materials-2026-09-10.mp4`, 15.13 seconds.
  Camera travel is accelerated and UI pauses trimmed; this is not a real-time
  performance benchmark. No generated video or invented camera frames are used.

## Reproduce

```sh
uv run --with scipy==1.17.1 scripts/record-demo/fit_drum_camera.py
```

SciPy runs in an isolated uv environment; no application dependency was added.

From `apps/web`:

```sh
E2E_DRUM_GEOMETRY=1 E2E_BASE_URL=http://127.0.0.1:3003 pnpm exec playwright test e2e/drum-geometry.spec.ts
node scripts/record-drum-geometry-demo.mjs
```

## Remaining Work

The model still has simplified architecture, blank window interiors, repetitive
materials and no recovered distant streets. Accurate silhouette/footprint fitting,
multi-view appearance, detailed object geometry, and canonical persistence of
material/geometry revisions are not solved by this pass. Do not advertise this
study as an automatically reconstructed navigable world.

## Technical References

The bounded robust fitting uses [SciPy least_squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html).
Texture color space and wrapping follow [Three.js textures](https://threejs.org/manual/en/textures.html).

## Exact Material Generation Prompt

```text
Create a production game material atlas for the attached Mended Drum fantasy street. The reference image is STYLE AND MATERIAL REFERENCE ONLY, not a scene to reproduce. Output ONE square bitmap split into EXACTLY FOUR equal square quadrants with NO GUTTERS, NO BORDERS, NO TEXT: top-left = chipped warm-grey limestone blocks with recessed irregular mortar, 8 rows of roughly rectangular stones; top-right = aged off-white lime plaster with fine cracks and mottled staining, no framing or beams; bottom-left = overlapping curved dusty oxblood terracotta roof tiles in regular rows, seen straight perpendicular to the roof surface, detailed chips and weathering; bottom-right = dark weathered oak grain running vertically, irregular grain and knots, narrow timber boards. Each quadrant fills its entire exact quarter and can be sampled as an independent 2D texture. Flat orthographic surface scans under neutral diffuse light. Physically plausible detailed surface color/albedo, minimal baked lighting, no cast shadows, no highlights, no perspective, no scene objects, no fixtures, no windows, no signs, no labels, no people, no decorative outlines. Fine tactile fantasy realism matching the supplied image. Avoid obvious bright seams at quadrant boundaries. Each quadrant's opposite edges should tile as well as possible. High resolution square, 2048x2048 preferred.
```
