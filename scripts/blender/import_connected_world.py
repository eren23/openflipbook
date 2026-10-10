"""Import the actual connected GLB and optional measured camera route into Blender.

The --validate-only path uses Python's standard library and never starts Blender.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys


def read_world(path: Path) -> tuple[dict, str]:
    if not 20 <= path.stat().st_size <= 384 * 1024 * 1024:
        raise ValueError("Connected GLB exceeds its size bounds")
    data = path.read_bytes()
    if len(data) < 20 or len(data) > 384 * 1024 * 1024:
        raise ValueError("Connected GLB exceeds its size bounds")
    magic, version, size, json_size, kind = struct.unpack_from("<5I", data)
    if (magic, version, size, kind) != (0x46546C67, 2, len(data), 0x4E4F534A):
        raise ValueError("Expected a complete binary glTF2 file")
    if 20 + json_size > len(data):
        raise ValueError("GLB metadata is truncated")
    document = json.loads(data[20:20 + json_size].rstrip(b" \x00"))
    manifest = document["scenes"][document.get("scene", 0)]["extras"]["openflipbook_world"]
    if manifest.get("format") != "openflipbook-connected-glb" or manifest.get("version") != 1:
        raise ValueError("Expected an OpenFlipbook connected-world export")
    if manifest.get("units") != "authored_metres" or manifest.get("coordinate_system") != "right_handed_y_up":
        raise ValueError("Unknown authored world coordinate frame")
    places = manifest.get("places", [])
    if not places or len({place["place_id"] for place in places}) != len(places):
        raise ValueError("Saved place identities are missing or ambiguous")
    if manifest.get("root_place_id") not in {place["place_id"] for place in places}:
        raise ValueError("Saved starting place is missing")
    bounds = manifest.get("bounds", {})
    if any(type(bounds.get(key)) not in (int, float) or not math.isfinite(bounds[key]) or bounds[key] <= 0
           for key in ("width", "depth")):
        raise ValueError("Saved world bounds must be positive finite metres")
    # The product emits self-contained GLB. Import never fetches external assets.
    if any("uri" in entry for group in ("buffers", "images") for entry in document.get(group, [])):
        raise ValueError("External GLB resources are not allowed")
    return manifest, hashlib.sha256(data).hexdigest()


def read_route(path: Path, world: dict, glb_sha256: str) -> dict:
    route = json.loads(path.read_text())
    if route.get("version") != 1 or route.get("units") != "authored_metres" or route.get("coordinate_system") != "right_handed_y_up":
        raise ValueError("Unknown measured route coordinate frame")
    if route.get("glb_sha256") != glb_sha256:
        raise ValueError("Root must bind the actual exported GLB hash before camera import")
    fields = ("scene_id", "revision", "definition_sha256", "normalized_origin")
    expected = {place["place_id"]: {key: place[key] for key in fields} for place in world["places"]}
    sources = route.get("source", {}).get("places", [])
    observed = {place["place_id"]: {key: place[key] for key in fields} for place in sources}
    if expected != observed or len(sources) != len(expected):
        raise ValueError("Route source geometry, revisions or normalized origins changed")
    samples = route.get("samples", [])
    if len(samples) < 2:
        raise ValueError("At least two actual timed camera observations are required")
    constant = route.get("camera", {})
    last = -math.inf
    previous_pose = None
    for sample in samples:
        position = sample.get("position", [])
        pitch = sample.get("pitch")
        if pitch is None:
            if constant.get("pitch_provenance") != "constant_authoritative_pose_verified":
                raise ValueError("Actual pitch is required; yaw observations cannot invent vertical look")
            pitch = constant.get("pitch")
        values = [sample.get("seconds"), sample.get("yaw"), pitch, *position]
        if len(position) != 3 or any(type(value) not in (float, int) or not math.isfinite(value) for value in values):
            raise ValueError("Measured camera values must be finite numbers")
        if sample["seconds"] < 0 or sample["seconds"] < last or abs(pitch) > 1.1:
            raise ValueError("Measured camera time or pitch is outside the product contract")
        if sample["place_id"] not in expected:
            raise ValueError("Camera names an unloaded place")
        pose = (tuple(position), sample["yaw"], pitch)
        if sample["seconds"] == last and pose != previous_pose:
            raise ValueError("Conflicting observations at one timestamp")
        sample["pitch"] = pitch
        last = sample["seconds"]
        previous_pose = pose
    if samples[-1]["seconds"] <= samples[0]["seconds"]:
        raise ValueError("Measured route has no elapsed duration")
    walk_camera_format(route, 1600, 1000)
    return route


def to_blender_position(position: list[float]) -> tuple[float, float, float]:
    """The same +90 degree X conversion used for glTF Y-up to Blender Z-up."""
    return position[0], -position[2], position[1]


def orthographic_fit(projected: list[tuple[float, float]], aspect: float) -> tuple[tuple[float, float], float]:
    """Fit actual projected mesh bounds, including irregular network footprints."""
    if not projected or not math.isfinite(aspect) or aspect <= 0:
        raise ValueError("An overview needs actual projected bounds and positive aspect")
    if any(not math.isfinite(value) for point in projected for value in point):
        raise ValueError("Projected overview geometry is not finite")
    minimum = [min(point[axis] for point in projected) for axis in range(2)]
    maximum = [max(point[axis] for point in projected) for axis in range(2)]
    centre = tuple((low + high) / 2 for low, high in zip(minimum, maximum))
    scale = max(maximum[0] - minimum[0], (maximum[1] - minimum[1]) * aspect) * 1.12
    if scale <= 0:
        raise ValueError("Projected overview geometry has no extent")
    return centre, scale


def file_sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def set_linear_camera_keys(camera) -> None:
    """Keep interpolation between measured observations free of Bezier overshoot."""
    action = camera.animation_data.action
    # Blender 4.4+ uses slotted Actions; the legacy collection is retained only
    # by older runtimes. Both paths refer to the keys we inserted ourselves.
    if hasattr(action, "layers"):
        curves = [curve for layer in action.layers for strip in layer.strips
                  for bag in strip.channelbags for curve in bag.fcurves]
    else:
        curves = list(action.fcurves)
    if not curves:
        raise ValueError("The measured camera has no saved animation channels")
    for curve in curves:
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"


def create_overview_camera(scene, manifest: dict):
    """Fit the full imported geometry using Blender's actual projection."""
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not corners:
        raise ValueError("The actual GLB contains no rendered meshes")
    minimum = Vector(tuple(min(point[i] for point in corners) for i in range(3)))
    maximum = Vector(tuple(max(point[i] for point in corners) for i in range(3)))
    target = (minimum + maximum) / 2
    extent = max(manifest["bounds"]["width"], manifest["bounds"]["depth"])
    data = bpy.data.cameras.new("Connected world overview")
    camera = bpy.data.objects.new("Connected world overview", data)
    scene.collection.objects.link(camera)
    camera.location = target + Vector((extent * .9, -extent * 1.2, extent * .95))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    data.type = "ORTHO"
    projected = [camera.rotation_euler.to_matrix().transposed() @ (point - target) for point in corners]
    data.sensor_fit = "HORIZONTAL"
    centre, data.ortho_scale = orthographic_fit([(point.x, point.y) for point in projected],
                                               scene.render.resolution_x / scene.render.resolution_y)
    # Irregular connected footprints need their projected extrema centred;
    # the world-axis AABB centre can leave one corner outside the image.
    camera.location += camera.rotation_euler.to_matrix() @ Vector((*centre, 0))
    data.clip_end = extent * 10
    scene.camera = camera
    bpy.context.view_layer.update()
    screen = [world_to_camera_view(scene, camera, corner) for corner in corners]
    if any(point.z <= 0 or not 0 <= point.x <= 1 or not 0 <= point.y <= 1 for point in screen):
        raise ValueError("Overview camera does not frame the complete imported geometry")
    camera["openflipbook_framing"] = json.dumps({
        "mesh_bounds_checked": len(meshes),
        "screen_min": [min(point[i] for point in screen) for i in range(3)],
        "screen_max": [max(point[i] for point in screen) for i in range(3)],
    })
    return camera


def configure_walk_lens(scene, camera_data) -> dict:
    """Verify the product's vertical FOV against Blender's actual camera rays."""
    camera_data.type = "PERSP"
    camera_data.sensor_fit = "VERTICAL"
    camera_data.lens_unit = "FOV"
    camera_data.angle_y = math.radians(60)
    rays = camera_data.view_frame(scene=scene)
    vertical = max(math.atan2(point.y, -point.z) for point in rays) - min(math.atan2(point.y, -point.z) for point in rays)
    if not math.isclose(vertical, math.radians(60), abs_tol=1e-6):
        raise ValueError("Blender walk camera does not preserve the product's 60 degree vertical field of view")
    horizontal = max(point.x for point in rays) - min(point.x for point in rays)
    height = max(point.y for point in rays) - min(point.y for point in rays)
    aspect = scene.render.resolution_x * scene.render.pixel_aspect_x / (scene.render.resolution_y * scene.render.pixel_aspect_y)
    if not math.isclose(horizontal / height, aspect, abs_tol=1e-6):
        raise ValueError("Blender walk camera does not preserve the requested image aspect")
    return {"vertical_fov_degrees": math.degrees(vertical), "frame_aspect": aspect}


def walk_camera_format(route: dict, width: int, height: int) -> dict:
    """Retain supplied measured viewport/projection without inventing a source aspect."""
    metadata = route.get("camera", {})
    viewport = metadata.get("viewport")
    matrix = metadata.get("projection_matrix")
    source = "requested_output_only"
    if viewport:
        width, height = viewport.get("width"), viewport.get("height")
        if any(type(value) is not int or not 64 <= value <= 16384 for value in (width, height)):
            raise ValueError("Measured camera viewport must contain bounded actual pixel dimensions")
        source = "recorded_viewport_dimensions"
    aspect = width / height
    if "aspect" in metadata and (type(metadata["aspect"]) not in (int, float)
                                  or not math.isclose(metadata["aspect"], aspect, abs_tol=1e-6)):
        raise ValueError("Measured camera aspect disagrees with its viewport")
    if matrix is not None:
        if not viewport or metadata.get("projection_provenance") != "actual_walk_data_projection":
            raise ValueError("Measured projection requires its actual viewport and provenance")
        if not isinstance(matrix, list) or len(matrix) != 16 or any(type(value) not in (int, float)
                                                                   or not math.isfinite(value) for value in matrix):
            raise ValueError("Measured camera projection must contain sixteen finite coefficients")
        if matrix[0] <= 0 or matrix[5] <= 0 or not math.isclose(matrix[11], -1, abs_tol=1e-7) or abs(matrix[15]) > 1e-7:
            raise ValueError("Measured camera projection is not a perspective camera")
        if any(abs(matrix[index]) > 1e-7 for index in (1, 2, 3, 4, 6, 7, 8, 9, 12, 13)):
            raise ValueError("Measured camera projection uses unsupported shifted or rotated rays")
        vertical = 2 * math.atan(1 / matrix[5])
        if not math.isclose(vertical, math.radians(60), abs_tol=1e-6):
            raise ValueError("Measured source does not use the product's 60 degree vertical field of view")
        if not math.isclose(matrix[5] / matrix[0], aspect, abs_tol=1e-6):
            raise ValueError("Measured source projection and viewport aspects disagree")
        source = "actual_walk_data_projection"
    return {"width": width, "height": height, "source_aspect": aspect, "source": source,
            "projection_matrix": matrix, "observed_at": metadata.get("observed_at")}


def import_world(args: argparse.Namespace, manifest: dict, glb_sha256: str, route: dict | None) -> dict:
    # Available only inside the verified Blender runtime; no arbitrary scripts
    # or world-provided Python are executed by this adapter.
    import bpy
    from mathutils import Quaternion

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    bpy.ops.import_scene.gltf(filepath=str(args.world.resolve()), import_pack_images=True)
    scene["openflipbook_world_receipt"] = json.dumps(manifest, sort_keys=True)
    scene["openflipbook_glb_sha256"] = glb_sha256
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.fps = args.fps
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    walk_camera = None
    walk_format = None
    overview_camera = None
    if route:
        walk_format = walk_camera_format(route, args.width, args.height)
        scene.render.resolution_x = walk_format["width"]
        scene.render.resolution_y = walk_format["height"]
        data = bpy.data.cameras.new("Actual measured walk")
        camera = bpy.data.objects.new("Actual measured walk", data)
        scene.collection.objects.link(camera)
        camera["openflipbook_lens"] = json.dumps({**configure_walk_lens(scene, data), **walk_format})
        walk_camera = camera
        data.clip_start = .05
        data.clip_end = max(400, max(manifest["bounds"]["width"], manifest["bounds"]["depth"]) * 6)
        camera.rotation_mode = "QUATERNION"
        basis = Quaternion((1, 0, 0), math.pi / 2)
        first = route["samples"][0]["seconds"]
        previous = None
        for sample in route["samples"]:
            frame = 1 + (sample["seconds"] - first) * args.fps
            camera.location = to_blender_position(sample["position"])
            rotation = basis @ Quaternion((0, 1, 0), sample["yaw"]) @ Quaternion((1, 0, 0), sample["pitch"])
            if previous is not None and rotation.dot(previous) < 0:
                rotation.negate()
            camera.rotation_quaternion = rotation
            camera.keyframe_insert(data_path="location", frame=frame)
            camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            previous = rotation.copy()
        scene.frame_start = 1
        scene.frame_end = math.ceil(1 + (route["samples"][-1]["seconds"] - first) * args.fps)
        set_linear_camera_keys(camera)
        scene.camera = camera
        scene["openflipbook_route_sha256"] = hashlib.sha256(args.route.read_bytes()).hexdigest()
    if args.overview:
        scene.render.resolution_x = args.width
        scene.render.resolution_y = args.height
        overview_camera = create_overview_camera(scene, manifest)
    world = bpy.data.worlds.new("Exported daylight")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    lighting = manifest.get("lighting") or {"sky": "#dce8e7", "intensity": 1}
    rgb = [int(lighting["sky"][i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in rgb]
    background.inputs["Color"].default_value = (*linear, 1)
    background.inputs["Strength"].default_value = lighting["intensity"]
    scene.world = world
    if args.engine == "cycles":
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 16
    else:
        for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                scene.render.engine = engine
                break
            except (TypeError, ValueError):
                continue
        else:
            raise ValueError("This Blender runtime has no supported Eevee engine")
    scene.frame_set(1)
    if walk_camera:
        scene.camera = walk_camera
        scene.render.resolution_x = walk_format["width"]
        scene.render.resolution_y = walk_format["height"]
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out.resolve()))
    if args.overview:
        scene.camera = overview_camera
        scene.render.resolution_x = args.width
        scene.render.resolution_y = args.height
        scene.render.filepath = str(args.overview.resolve())
        bpy.ops.render.render(write_still=True)
    receipt = {"version": 1, "blender_version": bpy.app.version_string, "glb_sha256": glb_sha256,
               "place_count": len(manifest["places"]), "mesh_objects": sum(obj.type == "MESH" for obj in scene.objects),
               "embedded_images": sum(image.source == "FILE" and bool(image.packed_file) for image in bpy.data.images),
               "measured_route_samples": len(route["samples"]) if route else 0,
               "walk_camera": json.loads(walk_camera["openflipbook_lens"]) if walk_camera else None,
               "blend_sha256": file_sha256(args.out),
               "overview_sha256": file_sha256(args.overview) if args.overview else None,
               "overview_framing": json.loads(overview_camera["openflipbook_framing"]) if args.overview else None,
               "lighting": "exported_sky_ambient_adaptation", "provider_submissions": 0}
    args.out.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--world", type=Path, required=True)
    parser.add_argument("--route", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--overview", type=Path)
    parser.add_argument("--engine", choices=("eevee", "cycles"), default="eevee")
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv)
    manifest, digest = read_world(args.world)
    route = read_route(args.route, manifest, digest) if args.route else None
    if args.validate_only:
        print(json.dumps({"valid": True, "glb_sha256": digest, "places": len(manifest["places"]),
                          "route_samples": len(route["samples"]) if route else 0}))
        return
    if not args.out or args.out.suffix != ".blend" or not (1 <= args.fps <= 120 and 64 <= args.width <= 4096 and 64 <= args.height <= 4096):
        parser.error("Choose a new .blend output and bounded frame settings")
    if args.overview and args.overview.suffix != ".png":
        parser.error("Choose a new .png overview")
    for path in [args.out, args.out.with_suffix(".receipt.json"), args.overview]:
        if path and path.exists():
            parser.error("Output already exists; preserve it and choose a new filename")
        if path and not path.parent.is_dir():
            parser.error("Output parent directory must already exist")
    print(json.dumps(import_world(args, manifest, digest, route)))


if __name__ == "__main__":
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    main(arguments)
