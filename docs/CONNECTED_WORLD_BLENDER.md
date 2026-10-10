# Connected worlds in Blender

The world editor's **World map → Export full world (.glb)** action exports the saved connected network in authored metres. It uses the same geometry, material binding and generated-mesh fitting code as the interactive view. Ground, structured walls, openings, roofs, stairs and placed props are actual rendered meshes. Embedded metadata records saved place/object identities, revisions, definition hashes, source and normalized origins, connections, collision solids and successfully loaded generated assets. The GLB embeds textures and mesh bytes; it needs no provider connection to open.

`scripts/blender/import_connected_world.py` imports that GLB through Blender's [official glTF operator](https://docs.blender.org/api/current/bpy.ops.import_scene.html). It preserves geometry and packed images, sets metre units and writes a `.blend`, an optional overview PNG and a SHA256 receipt. Blender uses Z up; the adapter converts measured app camera positions with `(x,y,z) → (x,-z,y)`, consistently with the imported glTF scene. The overview camera checks that every imported mesh bound fits the frame. The sky colour and intensity supply a documented ambient-light adaptation; an independent render can differ from the browser's lighting.

First validate an export with ordinary Python. This path uses only the standard library and never imports Blender:

```sh
python3 scripts/blender/import_connected_world.py \
  --world /absolute/path/full-connected-world.glb --validate-only
python3 -m unittest discover -s scripts/blender -p 'test_*.py'
```

For a portable macOS runtime, download the Apple Silicon DMG and checksum file from the [official Blender 5.2 release directory](https://download.blender.org/release/Blender5.2/). Compare its SHA256 with the exact filename in the official checksum file before mounting read only and copying `Blender.app` into a private directory. Keep the extracted runtime **outside the repository** so source watchers do not index its thousands of files. Detach only that mount. There is no need to copy into `/Applications` or connect an app/MCP tool.

The verified demo runtime is Blender **5.2.2 LTS**, build `d13f752e3b9c`, official [`blender-5.2.2-macos-arm64.dmg`](https://download.blender.org/release/Blender5.2/blender-5.2.2-macos-arm64.dmg). Its SHA256 is `dc4125399b8bfefe283cc1624d6cfc7809d1cac20ace51072127eb371f31f210`, checked against the [official checksum file](https://download.blender.org/release/Blender5.2/blender-5.2.2.sha256). The ignored demo's `tools/runtime-receipt.json` records the local executable, executable hash and signature/version checks; the temporary runtime path is machine specific.

Use private user directories and background mode. The executable is normally `Blender.app/Contents/MacOS/Blender`. Create the three private directories first, then run from the repository root with new output filenames:

```sh
export BLENDER_USER_CONFIG=/private/runtime/user-config
export BLENDER_USER_SCRIPTS=/private/runtime/user-scripts
export BLENDER_USER_DATAFILES=/private/runtime/user-datafiles
/private/runtime/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python scripts/blender/import_connected_world.py -- \
  --world /absolute/path/full-connected-world.glb \
  --out /absolute/path/connected-world.blend \
  --overview /absolute/path/connected-world-overview.png
```

The [official command-line reference](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html) documents background mode, Python scripts, exception exit codes, disabled automatic scripts and `BLENDER_USER_*` directories. `--engine cycles` selects a bounded 16-sample Cycles render; the default uses Eevee. Output files are preserved: existing `.blend`, PNG or receipt filenames cause the adapter to stop. No product data or provider jobs are changed.

An optional `--route /absolute/path/walk-route-blender.json` adds a camera from actual walk observations. The route must bind the exact GLB SHA256 and every saved source place's scene ID, revision, definition hash and normalized origin. Its samples contain elapsed seconds, `[x,y,z]`, yaw, place ID and actual pitch. If pitch is constant, a separate enriched receipt can provide `camera.pitch` and `camera.pitch_provenance: "constant_authoritative_pose_verified"` after checking all authoritative saved poses and pointer inputs. Yaw alone cannot establish pitch. Duplicate timestamps are accepted only for the same physical pose. The adapter keys actual positions and quaternions with linear interpolation through Blender's [Action layers](https://docs.blender.org/api/current/bpy.types.Action.html) and [keyframe channel bags](https://docs.blender.org/api/current/bpy.types.ActionKeyframeStrip.html). This preserves sampled poses; interpolation between samples is a reconstruction. The imported camera uses the product's 60° vertical field of view, checked against Blender's actual `view_frame` rays.

For the recorded aspect, enrich a separate route with `camera.viewport: {width,height}` from the actual rendered canvas, `camera.projection_matrix` from the viewport's `data-projection` array and `camera.projection_provenance: "actual_walk_data_projection"`. The adapter checks that `fY/fX` matches those dimensions and `2*atan(1/fY)` matches 60°. Browser-window dimensions alone do not establish the canvas aspect. The camera and receipt retain the supplied projection and observation time. Without this metadata the receipt explicitly labels the aspect `requested_output_only`. When both a route and `--overview` are present, the `.blend` retains the measured camera as active with its recorded resolution; the overview PNG uses the requested overview resolution separately.

Inside the isolated Blender runtime, `--python scripts/blender/smoke_overview.py` performs a lightweight regression using the same overview-camera helper on an irregular four-part fixture. It checks landscape and portrait corner framing and the 60° vertical walk lens at 1280×900. It renders and saves no frames. The fixture is an interoperability test; it is not evidence of generated-world quality.

The current full-network export proves four saved places, eight generated buildings and an 80×80 m bounding rectangle, with 4,608 m² of occupied place area. Its two generated GLB props and bound textures are embedded. These observations describe this actual saved network; they do not certify a separate full-size style repeat or a generated video's architecture.

ComfyUI remains optional and unrun. Its [official local-server API](https://docs.comfy.org/development/comfyui-server/comms_routes) supports submitted workflows and queued history/output retrieval. Existing saved colour, depth, normal and mask captures can be inputs to a locally configured look workflow, with any generated image retained as a derived asset. This requires an available local runtime and suitable model files; the Blender export/render itself does not depend on it.
