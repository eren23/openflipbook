# Fixed Lighthouse Surfaces

September 10, 2026. **Offline material experiment. $0 model spend.** No world
writes, production defaults, merges or deployments. Geometry fidelity is still
unaccepted.

Live local comparison:
`http://127.0.0.1:3002/dev/spatial-transitions/lighthouse-surfaces`.
The Desktop folder `openflipbook-lighthouse-surfaces-2026-09-10` contains an
offline comparison, ten paired full-size images, the original reference,
camera/input hashes and a new uncut browser recording. The recording includes
page startup and the full 24-second exterior route, not generated video.

## Structural Review

Assistant inspection compared the original crop with the v2 oblique render.
The major parts are present, but the crown profile, base recesses, annex
proportions and crystal facets remain approximate. The source camera is not
calibrated, so apparent size differences cannot all be assigned to geometry.
Terrain, entrances and hidden surfaces remain unknown. This is not user sign-off.

Those failures are recorded in `appearance.json` and the source-review dialog.
**No structural corrections are claimed in this step.** The shape was held
constant deliberately to isolate the appearance experiment; a nicer material
does not resolve a geometry mismatch or authorize the next paid test.

## Implementation

The new route reuses the existing v2 mesh factory, camera contract, original crop
and layout styles without editing them. The surface wrapper adds fixed material
treatment and a separate versioned local camera-state key. The bound v2 geometry
and source hashes are checked in tests. Geometry arrays, indices, positions,
rotations and scales remain equal to v2 in every material mode.

- Object-space masonry with staggered joints, incomplete courses and subtle
  deterministic block variation. No screen-space or time-dependent pattern.
- Warmer lit stone and cooler side/recess colors, terracotta roof, dark outlines
  and unlit cyan/violet crystal facets. Colors are authored approximations.
- Existing roof linework remains; the old continuous shaft course overlay is
  hidden only in the surface mode to avoid two overlapping masonry grids.
- Three.js toon shading and a shared four-step gradient texture; crystal facets
  use an unlit material so their color is not lost under the scene lighting.
- Baseline and clay modes reuse the original materials. Switching back restores
  baseline lights, line visibility, colors and background as well as meshes.

The first local appearance draft was too brown and dulled the crystal. It was
revised before the final exports. This was code-only iteration with no image
generation. The final capture hashes identify the delivered configuration.

## Result

The surface pass adds inspectable detail and clearer recess/facet contrast while
retaining the same place through movement and reload. The gain is modest: the
finish is still regular, low-poly and much plainer than the illustrated source.
There is no recovered texture, artist-quality material atlas or faithful
illustration transfer. Hidden faces receive an authored material treatment,
not purported source evidence.

The important controlled result is that the same camera can switch between v2
and the surface pass without changing geometry. In the browser tests, baseline
mode reproduced the actual original v2 page's canvas pixels at both desktop and
mobile sizes. Returning to surface mode restored its exact previous pixels;
return and paused-side-view reload also matched in that browser configuration.

This proves a fixed appearance mechanism, **not automatic consistency for arbitrary
generated worlds**. There is no map-click integration, multi-place asset registry,
interior navigation or AI-generated 3D in this step. Normal navigation is untouched.

## Verification

- 15 new focused tests: baseline source/geometry hashes, identical mesh data,
  original material/light restoration, mesh-local shader inputs, GPU resource
  cleanup, validated asset-version state and production/flag gates.
- Four Playwright checks: desktop/mobile comparison and reload, nonblank canvas
  pixels in all modes, unchanged camera during material switches, source-image
  decoding, exact baseline-page equivalence, ten paired exports and real-time
  uncut movement/return. No page or shader-console errors and no non-GET requests.
- An additional offline-gallery browser check passed at desktop/mobile sizes:
  all eleven images decoded, video metadata loaded, local links existed and no
  HTTP requests occurred. The paired viewer does not require a running server.
- Full web coverage suite passed. Floors unchanged: lines/statements 80.32%,
  functions 83.48%, branches 88.46%. TypeScript typecheck and diff whitespace
  checks passed. No backend source changed, so its suite was not rerun here.
- Desktop/mobile screenshots and the recording contact sheet were inspected.
  The connected browser also exercised the close approach and comparison controls.

Exact pixel comparisons are same-browser checks, not cross-GPU promises.
Procedural edges use derivative-based antialiasing; edge coverage can vary with
viewpoint/resolution without changing their object-space locations. The MP4 is
a lossy convenience copy and is not used for pixel equality assertions.

## Next Gate

Stop adding generic cosmetic detail for now. Correcting the shape requires a
more explicit source comparison: annotate visible crown/base/annex landmarks,
record an approximate source camera and distinguish projection error from
proportion error. Preserve these material/geometry revisions as baselines.
The tiny oblique crop cannot establish the true dimensions or hidden topology.

Only after structural review should we attempt a more faithful fixed appearance,
such as reviewed surface textures with explicit coverage and assumptions. Do not
project the whole illustration onto every wall or restyle each frame separately.
Accept multiple viewpoints before moving on to automated creation or app-wide
asset integration. Further paid generation remains a separate decision.

## Reproduce

From `apps/web`, with the existing opt-in development server:

```sh
pnpm exec vitest run tests/lighthouse-surfaces.test.ts tests/api/lighthouse-surfaces-page.test.ts
E2E_LIGHTHOUSE_SURFACES=1 E2E_BASE_URL=http://127.0.0.1:3002 pnpm exec playwright test e2e/lighthouse-surfaces.spec.ts
```

Add `E2E_LIGHTHOUSE_SURFACES_EXPORT=1` to write paired 1280 x 720 images and
camera/code hashes in the ignored `lighthouse-surfaces-v1` report directory.
Add `E2E_LIGHTHOUSE_SURFACES_FILM=1` for the browser recording. Neither path
imports a model provider or changes the previous v1/v2 evidence.
