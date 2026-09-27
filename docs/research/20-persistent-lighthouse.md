# Persistent Lighthouse: Offline V2

September 10, 2026. **No model calls or new spend. Local prototype only.**

The new scene is available at
`http://127.0.0.1:3002/dev/spatial-transitions/lighthouse-v2` while the existing
development server is running. It requires `SPATIAL_STUDY=1` and returns 404 in
production. The previous `lighthouse` route, guide exports, paid outputs and
experiment 19 receipts remain unchanged; their offline hash preflight still
passes.

The Desktop folder `openflipbook-persistent-lighthouse-v2-2026-09-10` contains
the raw 27-second browser recording as MP4, a frame contact sheet, six full-size
view exports, camera/source hashes and desktop/mobile screenshots. The recording
includes page startup and a continuous 24-second route. It is a technical
recording of rendered geometry, not AI-generated motion or a polished product
film. There is no reversed video or replacement endpoint still.

## What Changed

The v1 proxy replaced visible architecture with a plain house and simple base.
V2 gives the long annex three arched bays, a pitched terracotta roof, a two-tier
octagonal base, a tapered shaft, an open crown basin, two broader arms and a
faceted crystal. The scene uses fixed mesh materials and geometry-bound linework;
new camera positions do not ask an image model to paint another building.

The immutable source crop is bundled beside the scene and checked against its
original SHA-256. The versioned contract lists source-visible features separately
from assumed dimensions, recess depth, back surfaces and roof pitch. The source
evidence dialog exposes these limitations next to the original artwork.

This is **an authored interpretation**, not a reconstruction or an automated
map-to-3D pipeline. Three bays and eight sides are modeling decisions, not
measurements recovered from the crop. Source camera calibration is unknown; the
oblique inspection view is an approximation, not a solved image alignment.

## Persistence And Movement

The canonical representation for this isolated study is the bundled, versioned
scene recipe plus its mesh-building code. Reload reconstructs the same geometry
and materials from those static inputs. No model/API produces new content.
Independent builds have matching geometry arrays; random Three.js object UUIDs
are not treated as content identity.

The browser stores only the study's versioned camera time, inspection/ground mode
and render mode in a dedicated local-storage key. It resumes paused, validates
all fields and discards incompatible/corrupt state. Storage failure does not
prevent inspecting the scene. There is no new world database schema, account
sync, generated-asset registry or integration into normal map clicks yet.

The 24-second route goes from arrival to a sideways view, approaches the annex,
looks along its facade, and returns. Camera height stays at an assumed 1.65 m;
field of view does not animate. The mobile viewport uses a wider fixed field of
view to fit the initial building. The inspection camera is explicitly elevated
and is not labeled an eye-level arrival.

The route stays outside padded conservative building envelopes. Segment/box
intersections use Three.js; no wall crossing is hidden with a cut. These boxes
are a safety check for this authored route, **not a general navigation mesh**.
There is no unrestricted walking control. Terrain is an assumed flat plane,
not the source's recovered cliff. Arch bays have real openings through the
facade but do not imply a valid entrance or interior. The camera stops outside.

## Verification

- 15 geometry/state tests: source hash, evidence fields, all 1,440 route segments,
  blocked wall crossings, eye height, fixed FOV, exact return matrix, actual arch
  openings/open crown, stable geometry across rebuilds/modes, resource disposal,
  corrupt/version-mismatched storage rejection and valid restore.
- Three page-gating tests: production denied, flag-off denied, local opt-in shown.
- Four Playwright checks: desktop/mobile controls and screenshots; movement
  changes canvas pixels; return reproduces the start pixels; reload reproduces
  a paused side view; playback progresses; all three render modes are nonblank;
  reference image decodes; no horizontal overflow or page errors.
- The full route was played in real time and recorded. The final canvas matched
  the starting canvas in that same browser configuration. All recorded requests
  were GETs; no generation or persistence mutation endpoint was called.
- Full web coverage run passed before the final three gating tests were added;
  the gating tests passed separately. Coverage floors remain unchanged:
  lines/statements 80.32%, functions 83.48%, branches 88.47%.
- TypeScript typecheck passes. No backend source changed in this step.

PNG equality is a same-browser test, not a claim of identical rasterization
across GPUs/browsers. Scene/camera identity is the cross-reload contract. MP4
encoding is lossy and is not the artifact used for exact pixel comparisons.

The connected Brave browser also exercised the side-view control. Its Dark
Reader extension injected SVG attributes and produced a hydration warning; the
clean automated browser had no page errors. No extension settings were changed
and no hydration warnings were suppressed in the app.

## Visual Assessment

The annex is now long and arched, the base is stepped/faceted, and the same
structure survives lateral and forward motion. The source-visible silhouette is
closer than v1. **This is not a fidelity sign-off.** The materials are plain,
the crown/crystal proportions and detailed masonry remain approximate, the base
recess treatment is simplified, and the environment is missing. It does not
match the original illustration's finish or establish unknown architecture.

The foreground/background change during approach is actual projection of one
scene, not a generated image transition. This isolates the engineering mechanism
we need without claiming that the artistic or automatic-generation problem is
solved. The next evaluation must judge those separately.

## Next Gate

1. Review the source and oblique v2 scene together. Record architectural
   corrections before any paid image/3D test; do not declare exact geometry from
   a plausible silhouette.
2. Improve appearance as fixed surfaces on the same geometry, checking at least
   two viewpoints. Independently restyling every frame would reopen the drift
   problem. Do not infer correct hidden walls from a single image projection.
3. Only after one acceptable local place exists, define a versioned app asset
   contract: canonical place ID, evidence/image hashes, geometry/material hashes,
   coordinate frame, safe camera/entry anchors, provenance and acceptance state.
   A structural revision must not silently reuse incompatible cameras or clips.
4. Test creation on other buildings and missing-evidence cases before claiming
   automation. Retain explicit cuts between map/local scenes whose spatial
   relationship has not been established. AI video remains optional and later.

## Reproduce Without Model Spend

From `apps/web`, against the opt-in local server:

```sh
pnpm exec vitest run tests/lighthouse-persistent.test.ts tests/api/lighthouse-persistent-page.test.ts
E2E_LIGHTHOUSE_V2=1 E2E_BASE_URL=http://127.0.0.1:3002 pnpm exec playwright test e2e/lighthouse-persistent.spec.ts
```

Add `E2E_LIGHTHOUSE_V2_EXPORT=1` for six 1280 x 720 frames and source/pose hashes;
add `E2E_LIGHTHOUSE_V2_FILM=1` for the real-time browser recording. These exports
go to the separate ignored `lighthouse-persistent-v2` report directory. They do
not submit a paid pilot or modify saved user worlds.
