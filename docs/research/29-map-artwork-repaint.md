# Geometry-driven map artwork repaint

2026-09-11. Implemented locally; not committed, merged or deployed.

## Working path

Saved world geometry -> Repaint map artwork -> review manual plan placement ->
native Sketch drawing and masks -> close-up provider edit -> full-resolution
protected composite -> compare -> Keep Version -> active parent-map artwork.

The original map remains immutable and selectable. Accepted artwork records bind
the image to its geometry revision, baseline revision and registration. Geometry
and map-head changes invalidate pending work before generation/acceptance. Keeping
an image does not modify scene dimensions, objects or the world-map entity records.
Forks remap artwork node references; world ZIPs include `map-artwork.json`.

## Actual result

World `4cd0928d-d390-43a8-8a4c-06bafc0230f2`, geometry revision 3:

- Mended Drum roof changed to muted verdigris.
- Added a separate oxblood-roof workshop at the registered authored footprint.
- Full output remains 1672 x 941. 3,366 changed pixels, confined to reviewed masks.
- Backend exact RGBA check: zero changed pixels outside its raster mask.
- Independent full-image check: zero changes outside reviewed rectangular mask
  bounds, including their Excalidraw border stroke.
- Saved scene definition equals its immutable pre-repaint revision.
- Browser reload selects accepted artwork; the original is still available.

Two real Nano Banana Pro renders. The first kept cyan guide borders and was not
accepted. A stronger removal instruction produced the accepted second result.
One earlier submission failed at the disabled local backend flag before reaching
the provider. Full receipts and unmodified before/after PNGs are in
`assets/map-artwork-2026-09-11/`.

## Boundaries

Registration is manual and approximate, not recovered camera geometry. After
acceptance it is locked: moving the coordinate frame without separately migrating
old artwork could leave duplicate buildings. Changing place dimensions is refused.
Initial baseline is the first saved authored scene. At most 20 changed objects
per repaint; edits may be limited further by Sketch's prompt-size bound.

The provider receives a context crop around the mask and works at a larger
resolution; only its protected patch is pasted back. This improves tiny roof
details but cannot make geometry inside the mask exact. Close-up comparison and
human acceptance remain required. This is not automatic reconstruction, continuous
3D texture projection, or a guarantee of annotation-free output from one render.

## Verification

Focused geometry, Sketch server, scene server, fork/export and workspace tests;
backend Sketch tests; TypeScript; desktop/mobile Playwright placement and focused
comparison checks. `scripts/audit-map-artwork.mjs` rechecks the accepted local
result without calling a model.

```sh
cd apps/web
node --env-file=.env.local scripts/audit-map-artwork.mjs \
  f622e9d5-de32-4c1a-8921-f8f2cbebf909 \
  ../../docs/research/assets/map-artwork-2026-09-11
```
