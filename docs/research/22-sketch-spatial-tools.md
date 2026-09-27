# Sketch And Spatial Tools

September 10, 2026. Follow-up to the native [Sketch implementation](../SKETCH.md).
This is the compatibility design and verified model shortlist, not a claim that
these additional integrations are implemented or that reconstruction is solved.
No new paid 3D/model experiment was started for this follow-up.

## Product Target

Select a lighthouse in the existing world, draw a correction, inspect a saved
3D representation, rotate or move it with real controls, adjust its appearance,
and revisit the same accepted asset. Sketch remains the frontend, not a detached
model playground. Camera movement and object transformation are distinct tools.

## Reference Video: Now Inspected

The user supplied the 33.5-second OpenAI Sketch MP4 from Downloads. Inspected
the full sequence at one-second intervals and the garden sequence at four frames
per second. This supersedes the earlier uncertainty about the intended demo.

| Approximate time | Visible transformation |
| --- | --- |
| 0-7 s | Minimal drawing UI; colored character doodle becomes a dimensional-looking character, then appears in a furnished scene |
| 10-13 s | A crab-shaped outline becomes an upholstered chair in a room |
| 14-18 s | Garden sketch becomes a detailed overhead design, then a ground-level garden image |
| 19-23 s | Winged-horse drawing appears in different artwork/material contexts |
| 24-28 s | Jacket outline becomes garments with different materials and presentation |
| 29-32 s | Handwritten lettering becomes embroidered/beaded physical-looking lettering |

The video demonstrates sketch-conditioned images, material/style variants,
contextual placement and a plan-to-perspective transformation. It does not show
interactive camera controls, a downloadable mesh, collision, continuous travel,
or a return through persistent geometry. The displayed images do not identify
the exact model configuration, hidden prompts, number of attempts or latency.

**Priority correction:** matching these visible transformations does not require
finishing the mesh pipeline first. The immediate product gap is a guided creative
workflow and stronger varied demonstrations, not simply more model names.

## Immediate Native Sketch Track

1. Add explicit output intentions for a finished object, environment, artwork,
   and product/material study. Keep the drawing and requested spatial layout as
   shared inputs rather than letting an intent preset replace the user's prompt.
2. Create material/style variations from the same saved drawing or accepted
   candidate. Preserve the outline and object identity where requested; display
   all attempts with the existing preview/Keep/version flow.
3. Add reference-driven placement into an existing scene. A selected insertion
   region protects the surrounding source pixels; shadows and contact need an
   adequate editable area. Do not paste an unrelated object into canonical lore.
4. Make plan-to-perspective an explicit proposed view linked to the same world
   and entity IDs. Use existing geometry/camera evidence when available and
   reject landmark displacement, missing paths and architectural drift. A pretty
   eye-level image is not a verified arrival.
5. Demonstrate three complete native workflows: object/material variation,
   drawn layout to environment, and a protected correction followed by reload.
   Compare the already-integrated Flare, Sunburst and Nano routes on matched
   inputs before adding a specialist for a measured failure.

This track uses the existing image pipeline. Persistent 3D below remains a
separate, additive capability, not a prerequisite or an explanation of what the
reference video necessarily does internally.

### Implementation Checkpoint

The native workflow controls and renderer contracts for steps 1-3 are now in the
working tree, with saved settings and separate object/style inputs. Step 4 has
only the explicit raster proposal path: whole-image consent, source-parent
lineage, and an unverified-geometry label. It does not yet condition on persistent
camera evidence, validate landmark positions, or establish entity correspondence.
No existing canonical geometry is overwritten. These workflows are covered by
mocked tests, not a new live quality comparison. Step 5's varied model demos and
matched-input evaluation remain next; mesh generation remains deferred.

## Three Different Operations

1. Image transformation: produce another raster view or edit. GPT Image 2.5,
   Nano, and Qwen fit here. A plausible new angle is not retained geometry.
2. Asset creation: produce a mesh or splat once, inspect it, and save it. Subsequent
   orbit/translation uses the same asset in Three.js without a model call.
3. Geometry-bound appearance: apply materials/textures to the accepted shape.
   This is the closest fit to the existing fixed-surface lighthouse work.

The [Flare API model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
documents image outputs, not meshes or a persistent scene API. We already use
Flare/Sunburst through fal; that does not supply a geometry layer by itself.

## Verified Shortlist

| Capability | Endpoint | Role and qualification |
| --- | --- | --- |
| Explicit raster-view angle controls | `fal-ai/qwen-image-edit-2511-multiple-angles` | Horizontal angle, elevation and zoom. Existing pilot failed its camera gate; no automatic promotion to canonical geometry. |
| Mask-selected object reconstruction | `fal-ai/sam-3/3d-objects` | Accepts masks, optional pointmap/depth; emits splats, optional GLB and transform metadata. Start with one segmented landmark, not the whole map. |
| Image to textured mesh | `fal-ai/trellis-2` | GLB output; compare source silhouette, architecture and unseen surfaces before acceptance. |
| Drawing directly to mesh | `fal-ai/hunyuan3d-v3/sketch-to-3d` | Sketch image plus prompt. Direct fit for new objects; not evidence of faithful existing-place reconstruction. |
| Existing mesh plus image to retextured mesh | `fal-ai/trellis-2/retexture` | The strongest next appearance hypothesis for our persistent lighthouse. Validate returned geometry; the word 'retexture' is not an exact topology guarantee. |

Primary API references: [Qwen](https://fal.ai/models/fal-ai/qwen-image-edit-2511-multiple-angles/api),
[SAM 3D](https://fal.ai/models/fal-ai/sam-3/3d-objects/api),
[TRELLIS.2](https://fal.ai/models/fal-ai/trellis-2/api),
[Hunyuan sketch-to-3D](https://fal.ai/models/fal-ai/hunyuan3d-v3/sketch-to-3d/api),
[TRELLIS.2 retexture](https://fal.ai/models/fal-ai/trellis-2/retexture/api).
Availability in public documentation is not a quality result or confirmed account
quota. Recheck selected endpoint cost and reserve a separate batch before running.

Ray/Seedance motion and Marble environments remain the separate tracks in
[report 15](15-controllable-model-landscape.md). They should not be put into the
image-model dropdown as though they share an input/output contract.

## Compatibility Requirements

- Retain `session_id`, source node, canonical entity ID and parent frame for each
  accepted asset. Existing place-identity locks remain authoritative.
- Store immutable asset versions with source image/mask hashes, provider request,
  effective arguments and explicit observed/inferred/authored provenance.
- Keep shape revision, material revision, object transform and render camera
  separate. Changing paint must not silently modify geometry or collision.
- Use the existing world-frame conversions. The map uses east/south coordinates
  in relative world units; Three.js scenes use a vertical axis. Explicitly store
  asset-to-world transforms, orientation and scale. Never assume a model's units
  are metres or its camera angle matches our view convention.
- A 2D image edit stays a 2D candidate. It does not secretly rewrite a mesh. Painting
  a 3D surface requires a renderer-provided triangle/material/UV correspondence,
  plus the camera and asset revision under which the stroke was made.
- Retexture candidates must pass shape/alignment checks before appearing on the
  canonical scene. Reject changed geometry or retain it as a separate unaccepted
  shape proposal; never silently swap collision or landmark placement.
- Preserve source images and artwork as fallbacks. Browser navigation, replay,
  orbit, pan, reset and reload must submit zero generation calls.
- Extend the saved-asset contract separately from Sketch v1. Image-only clients
  retain their preview and can ignore optional spatial assets. A GLB must never
  enter the PNG candidate acceptance/upload path.
- Generated back faces and interiors remain inferred. Their persistence proves
  reuse, not that they match an unseen real or imagined source.

## Persistent 3D Extension

1. Add a native 3D inspection mode using the existing Three.js dependency and
   actual GLB import, orbit, camera reset, transform gizmos and export. Start with
   an existing asset; verify axes, scale, reload and cleanup without generation.
2. Introduce owner-scoped, immutable spatial-asset versions linked to world nodes
   and canonical entities. Add durable queued jobs with GET-only resume before
   wiring long-running generation into the product.
3. Compare SAM 3D and TRELLIS.2 on one correctly segmented lighthouse. Show both
   complete outputs and mismatches. Neither a VLM nor a pretty screenshot can
   override source-landmark and camera failures.
4. Test TRELLIS.2 retexturing on the current fixed lighthouse geometry, while
   explicitly retaining its unresolved shape mismatches. Compare shape and
   appearance separately against the existing deterministic materials.
5. Add Hunyuan sketch-to-3D for new objects; add Qwen viewpoint proposals only
   as an experimental raster operation with the prior failure cases in its eval.
6. Connect an accepted asset to the existing spatial path and capture an uncut
   side-step, orbit and return. Gate on actual parallax, stable landmarks, no wall
   crossings, acceptable mobile rendering and zero-submission replay.

The first convincing demo should be one selected object that becomes an
inspectable, editable, saved 3D asset. Whole-world automatic consistency and
continuous exterior-to-interior travel are explicitly not the initial claim.
