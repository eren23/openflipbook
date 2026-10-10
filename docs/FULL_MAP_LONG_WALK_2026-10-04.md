# Full map and long walk — 4 October 2026

This record documents supporting geometry, traversal and export diagnostics for OpenFlipbook's image-first world experience. The product priority remains a rich fantasy map → image-led exploration → generated walk video that retains place identity → expansion of the same saved world. The [accepted goal](WORLD_BUILDING_GOAL.md) explicitly preserves the original image-first experience. The measured 637 m geometry walk and Blender export establish useful spatial support; rich illustrated exploration and generated-video quality still require their own acceptance.

## Working product path

Open a saved world → **World map** → inspect its connected places, building footprints and real doors → **Continue walking** → move with normal keyboard/pointer controls. The map follows the actual walking position. Opening it pauses controls without rebuilding physics or resetting the saved position. **Edit selection** opens the exact owning place/object.

**Export full world (.glb)** assembles the same renderer geometry, stairs, door openings, saved generated meshes, and materials into a local download. It retains metre units, original and normalized origins, scene revisions, definition hashes, place/object/entity identities, and the real collision solids in glTF extras. It verifies that referenced generated meshes loaded rather than exporting fallback boxes. Exporting and revisiting use saved assets and do not submit generation jobs.

## Actual district

The saved acceptance district occupies four irregularly arranged areas within an **80 × 80 metre bounding box**, with **4,608 m²** of ground, eight structured buildings, and three registered boundary openings. This is the current acceptance district, not a claim that a metropolitan-scale world is already implemented.

The route covers the western lane and its Guild/Lodge, Workshop ground rooms and upstairs Studio, the annex Tea House, and the northern Reading Hall and garden, then returns through real openings to the original entrance. Its planned distance is **580.72 authored metres**, with 69 checkpoints and five visited building interiors. Walking distance exceeds map width because the route explores and returns through the district.

The demonstration runs against a new BSON/object-storage restore of the saved district. Providers and the generation worker are disabled. Original paid-pilot volumes, backup and receipts remain untouched. Only observed normal-app walk autosaves may write to the demonstration clone. Geometry and build-job hashes are compared before and after the walk.

## Actual export

The product button downloaded an **87,889,768-byte GLB**, SHA-256 `95239f363c38549440e732d8e3c1cf010e040bcd97f038e2439f0bc39ae02b40`. It contains 385 glTF meshes, 115 materials, nine textures, all four places and both actual saved generated assets. Khronos glTF Validator reports **zero errors**. Its two warnings concern runtime-generated tangent space on the two normal-mapped generated assets; unused UV attribute notices are informational.

## Product priority next

Reconnect the existing rich 2D world artwork to ordinary exploration and saved views, then demonstrate an image-led generated walk that keeps its named buildings and visual identity. Reuse preserved accepted images and clips before requesting new work. Start with the [Mended Drum image-first artwork and saved edit](research/26-mended-drum-image-first.md) and the [September 17 progress receipts](WORLD_BUILDING_PROGRESS.md): the town walk starting from the real Copper Kettle arrival image, and its `/play` sign-swing/steam action clip. The actual town walk remains at `~/Desktop/OpenFlipbook-route-2026-09-17/town-walk/walk-lantern-quay.mp4`; action evidence remains at `~/Desktop/OpenFlipbook-soul-2026-09-17/`. Their identity/style drift and invented far landmarks remain visible limits. These historical assets do not establish fresh acceptance of the October 4 district.

The October 2 [pose/path-video study](research/36-pose-to-video-in-product.md) and [town-walk study](research/37-walk-video-through-the-town.md) establish a measured geometry/camera subset. Visual review still finds generic painted blockouts; passing silhouette and motion gates does not establish rich fantasy quality. The 637 m recording likewise establishes a geometry walk, not a generated fantasy-image walk video.

After that connected image/video workflow, expand the same saved world while retaining visited buildings, asset IDs and local poses. Prominent map portal markers, building search, nearby rendering/asset/collider caching and appropriate shadow bounds remain concrete engineering work for larger areas. Current eager loading, fixed shadow bounds and the 16-place/1,000-object safety caps do not establish larger-world performance.

The offline placement check for four additional 100 × 100 m areas remains a deferred possibility: east of the annex, west of the western lane, north of the garden, then north again. It would yield eight areas, seven openings, 280 × 310 m bounds and 44,608 m² of ground. These areas have **not been generated or populated**. Any future scale claim needs actual exploration, cross-area reloads, preserved old geometry and measured frame/load budgets.

Blender export and measured camera import support scene inspection and independent rendering. Optional ComfyUI conditioning would also remain a derived appearance workflow bound to the saved scene revision; it has not been run here. These tools support the product's map, artwork, identity and exploration loop.

All geometry receipts below remain preserved. The failed AI illustration/video quality measurements in [the paid pilot record](PAID_QUALITY_PILOT_2026-10-04.md) remain failures. This work does not declare the image-first workflow or the complete release goal achieved.

## Completed action demonstration

The actual continuous take passed: **637.262 horizontal metres in 555.238 seconds (9 minutes 15 seconds)**, 73 acknowledged checkpoints, five interiors, Workshop upstairs, and all three real boundary openings crossed in both directions. It includes an ordinary physical return from a previously stopped west-lane test to the entrance before the entire planned route. The extra recovery and precision movements explain why measured distance exceeds the 580.72 m plan. All 411 normal-app walk autosaves matched observed physics; none were rejected. All eight final traversal checks passed. All four scene definitions/connections and build-job hashes remained unchanged. Browser errors and blocked writes are empty.

The uncut WebM is 66,894,027 bytes, SHA-256 `8815a2e3d18a50e5ebc388a1c0c53409895be00669ec9070c7f830bd2023ae99`. Its total length is 11 minutes 23 seconds: the active walk is 9 minutes 15 seconds, and the original retains loading plus a static ending during trace packaging. Chapter links use trace wall-time observations; representative decoded frames verify Guild, Workshop upstairs and Reading Hall. They do not use total video duration minus active time.

Three earlier free harness takes are preserved. One rejected a real seam observation because the previous guard discarded adjacent-place camera history. Another missed intermediate pointer-yaw frames during host load. The third software-rendered take timed out 9.8 cm short of a precision target without rejecting any save. The fixed recorder observes completed frame attributes passively, retains strict age/yaw/distance/scene/room guards, and on macOS explicitly uses Metal. The passed take records **ANGLE Metal Renderer: Apple M5**. No production movement or physics was changed to obtain the recording.

The actual product GLB was imported and rendered by verified **Blender 5.2.2 LTS**, not merely marked import-ready. The `.blend` has **385 mesh objects, nine packed images and 35,182 measured camera samples**. Its SHA-256 is `5be8dad49a6644c687aa2d3b0a948194198544d311ff35415887eaa7560ad6c2`; the overview PNG SHA-256 is `1ab9f492a08b0459bcc1e045df7f7accb41da68dfd4bde9f3684b16d5d9dbba6`. A native reopen verified 17 actual camera poses and rotations, metre units, packed images and the recorded 990 × 721 outdoor canvas format. The imported lens independently measures 60° vertical field of view. The overview checks every one of the 385 mesh bounds fits the frame. Ambient lighting is adapted to Blender; this is a separate render of the saved geometry.

The original route remains immutable. A separate Blender route independently reconciles sorted-key integrity hashes with the exporter’s raw JSON serialization hashes against the same four recorded definitions. Nine samples shared a millisecond with a different position (at most 2.4 cm apart and identical yaw/pitch); the derivative selects the final actual observation at each of these times and documents every dropped/selected position. It invents neither times nor poses. Full observations, measured distance and autosave evidence remain intact. Future harness sidecars use compatible raw definition hashes and explicitly report same-time sample coalescing. The recorded app canvas can change height when a room breadcrumb appears; Blender uses the first outdoor canvas’s fixed format.

A private local gallery serves only selected images, the uncut recording, the route and scene downloads. It supports real chapter seeks, ranged video/scene downloads, desktop and mobile layout; private configuration/ownership/server files return 404. The interactive app runs from the latest local source against the separate restored clone, with a tool-owned Chromium window available for actual map selection and walking. Providers and the generation worker remain disabled; original paid-pilot services remain stopped.

Verification: **2,795 web tests in 293 files**, **113 offline pilot guards**, TypeScript, focused ESLint, glTF Validator, native Blender framing/lens checks, native `.blend` reopen and gallery Playwright checks passed. All source changes remain local and uncommitted. The original operator backup and paid-generation receipts are retained unchanged.
