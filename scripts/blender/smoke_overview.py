"""Run inside Blender to verify landscape/portrait framing without rendering.

This isolated fixture is a regression check, not a generated-world quality claim.
"""
from pathlib import Path
import json
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_connected_world import configure_walk_lens, create_overview_camera

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for x, y, width, depth in ((36, -60, 40, 40), (8, -60, 16, 40), (36, -20, 40, 40), (68, -60, 24, 32)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, 2))
    bpy.context.object.scale = (width, depth, 4)
bpy.context.view_layer.update()
results = []
for width, height in ((1600, 1000), (1000, 1600)):
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    camera = create_overview_camera(scene, {"bounds": {"width": 80, "depth": 80}})
    bounds = json.loads(camera["openflipbook_framing"])
    assert all(0.05 <= bound <= 0.95 for bound in bounds["screen_min"][:2] + bounds["screen_max"][:2]), bounds
    results.append({"width": width, "height": height, **bounds})
scene.render.resolution_x = 1280
scene.render.resolution_y = 900
lens = configure_walk_lens(scene, bpy.data.cameras.new("Measured walk lens regression"))
assert abs(lens["vertical_fov_degrees"] - 60) < 1e-4
assert abs(lens["frame_aspect"] - 1280 / 900) < 1e-6
print(json.dumps({"blender_version": bpy.app.version_string, "framing": results, "walk_lens": lens,
                  "rendered_frames": 0, "provider_submissions": 0}))
