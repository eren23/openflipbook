"""Offline geometry and measured-route guards; importing this suite never imports bpy."""
from __future__ import annotations

from contextlib import redirect_stdout, redirect_stderr
from copy import deepcopy
import io
import json
import math
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_connected_world as adapter


class ConnectedWorldImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.world = {
            "format": "openflipbook-connected-glb", "version": 1,
            "units": "authored_metres", "coordinate_system": "right_handed_y_up",
            "root_place_id": "root", "bounds": {"width": 80, "depth": 80},
            "places": [
                {"place_id": "root", "scene_id": "root-scene", "revision": 5,
                 "definition_sha256": "a" * 64, "normalized_origin": {"x": 16, "z": 40}},
                {"place_id": "north", "scene_id": "north-scene", "revision": 2,
                 "definition_sha256": "b" * 64, "normalized_origin": {"x": 16, "z": 0}},
            ],
        }
        self.document = {"asset": {"version": "2.0"}, "scene": 0,
                         "scenes": [{"extras": {"openflipbook_world": self.world}}]}
        self.glb = self.directory / "world.glb"
        self.write_world()
        _, self.digest = adapter.read_world(self.glb)
        self.route = {
            "version": 1, "coordinate_system": "right_handed_y_up", "units": "authored_metres",
            "glb_sha256": self.digest, "source": {"places": deepcopy(self.world["places"])},
            "camera": {"pitch": 0.15, "pitch_provenance": "constant_authoritative_pose_verified"},
            "samples": [
                {"seconds": 4, "position": [26, 1.65, 42], "yaw": 0, "place_id": "root"},
                {"seconds": 5, "position": [26, 1.65, 39], "yaw": 0.2, "place_id": "north"},
            ],
        }
        self.route_path = self.directory / "route.json"

    def write_world(self):
        metadata = json.dumps(self.document).encode()
        metadata += b" " * (-len(metadata) % 4)
        self.glb.write_bytes(struct.pack("<5I", 0x46546C67, 2, 20 + len(metadata),
                                         len(metadata), 0x4E4F534A) + metadata)

    def read_route(self):
        self.route_path.write_text(json.dumps(self.route))
        return adapter.read_route(self.route_path, self.world, self.digest)

    def test_complete_export_preserves_normalized_metres_and_binary_hash(self):
        manifest, digest = adapter.read_world(self.glb)
        self.assertEqual(manifest, self.world)
        self.assertEqual(digest, adapter.file_sha256(self.glb))
        self.assertEqual(adapter.to_blender_position([16, 1.65, 40]), (16, -40, 1.65))

    def test_irregular_actual_network_fits_landscape_and_portrait_without_cropping(self):
        # Extrema from the actual 385-mesh export: world AABB centring placed
        # the leftmost corner outside the image despite the correct span.
        projected = [(-56, -31.64785), (36.8, 21.66585), (-20, 17)]
        for aspect in (1.6, 0.625):
            centre, scale = adapter.orthographic_fit(projected, aspect)
            self.assertAlmostEqual(centre[0], -9.6)
            self.assertAlmostEqual(centre[1], -4.991)
            for x, y in projected:
                self.assertGreaterEqual(0.5 + (x - centre[0]) / scale, 0.05)
                self.assertLessEqual(0.5 + (x - centre[0]) / scale, 0.95)
                self.assertGreaterEqual(0.5 + (y - centre[1]) / (scale / aspect), 0.05)
                self.assertLessEqual(0.5 + (y - centre[1]) / (scale / aspect), 0.95)

    def test_overview_refuses_missing_nonfinite_or_degenerate_bounds(self):
        for points, aspect in (([], 1.6), ([(0, 0)], 1.6), ([(0, 0), (1, 1)], 0),
                               ([(0, 0), (1, float("nan"))], 1.6)):
            with self.assertRaises(ValueError):
                adapter.orthographic_fit(points, aspect)

    def test_world_refuses_external_images_and_buffers(self):
        for group in ("buffers", "images"):
            with self.subTest(group=group):
                self.document[group] = [{"uri": "https://example.invalid/private-file"}]
                self.write_world()
                with self.assertRaisesRegex(ValueError, "External GLB"):
                    adapter.read_world(self.glb)
                self.document.pop(group)

    def test_world_refuses_truncated_header_and_nonfinite_bounds(self):
        data = self.glb.read_bytes()
        self.glb.write_bytes(data[:-4])
        with self.assertRaisesRegex(ValueError, "complete binary"):
            adapter.read_world(self.glb)
        self.world["bounds"]["depth"] = float("nan")
        self.write_world()
        with self.assertRaisesRegex(ValueError, "positive finite"):
            adapter.read_world(self.glb)

    def test_route_binds_exact_glb_and_each_saved_place_revision(self):
        for mutate in (
            lambda: self.route.update(glb_sha256=None),
            lambda: self.route["source"]["places"][1].update(revision=3),
            lambda: self.route["source"]["places"][0]["normalized_origin"].update(x=0),
            lambda: self.route["source"]["places"].append(deepcopy(self.world["places"][0])),
        ):
            original = deepcopy(self.route)
            mutate()
            with self.assertRaises(ValueError):
                self.read_route()
            self.route = original

    def test_authoritative_constant_pitch_and_equal_time_equal_pose_are_retained(self):
        duplicate = deepcopy(self.route["samples"][0])
        duplicate["place_id"] = "north"
        self.route["samples"].insert(1, duplicate)
        actual = self.read_route()
        self.assertEqual(len(actual["samples"]), 3)
        self.assertEqual([sample["pitch"] for sample in actual["samples"]], [0.15] * 3)
        self.assertNotIn("pitch", self.route["samples"][0])

    def test_per_sample_actual_pitch_needs_no_constant_inference(self):
        self.route.pop("camera")
        for sample in self.route["samples"]:
            sample["pitch"] = -0.2
        self.assertEqual(self.read_route()["samples"][1]["pitch"], -0.2)

    def test_measured_camera_projection_pins_source_fov_and_canvas_aspect(self):
        height = 720
        width = 1280
        fy = 1 / math.tan(math.radians(30))
        matrix = [fy / (width / height), 0, 0, 0, 0, fy, 0, 0, 0, 0, -1.00025, -1, 0, 0, -.1000125, 0]
        self.route["camera"].update(viewport={"width": width, "height": height}, projection_matrix=matrix,
                                    projection_provenance="actual_walk_data_projection", observed_at="2026-10-04T12:00:00Z")
        self.read_route()
        camera = adapter.walk_camera_format(self.route, 1600, 1000)
        self.assertEqual((camera["width"], camera["height"]), (1280, 720))
        self.assertEqual(camera["source"], "actual_walk_data_projection")
        self.assertEqual(camera["projection_matrix"], matrix)
        self.route["camera"]["projection_matrix"][5] = 2
        with self.assertRaisesRegex(ValueError, "vertical field of view"):
            self.read_route()

    def test_camera_metadata_cannot_claim_wrong_aspect_or_missing_source(self):
        self.route["camera"].update(viewport={"width": 1280, "height": 720}, aspect=1.6)
        with self.assertRaisesRegex(ValueError, "aspect"):
            self.read_route()
        self.route["camera"].pop("aspect")
        self.route["camera"]["projection_matrix"] = [0] * 16
        with self.assertRaisesRegex(ValueError, "provenance"):
            self.read_route()
        self.route["camera"].pop("projection_matrix")
        self.assertEqual(adapter.walk_camera_format(self.route, 1600, 1000)["source"], "recorded_viewport_dimensions")
        self.route["camera"].pop("viewport")
        self.assertEqual(adapter.walk_camera_format(self.route, 1600, 1000)["source"], "requested_output_only")

    def test_yaw_only_route_cannot_invent_pitch(self):
        self.route.pop("camera")
        with self.assertRaisesRegex(ValueError, "Actual pitch"):
            self.read_route()

    def test_equal_time_conflicting_observations_are_rejected(self):
        duplicate = deepcopy(self.route["samples"][0])
        duplicate["position"][0] += 0.1
        self.route["samples"].insert(1, duplicate)
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            self.read_route()

    def test_time_pose_and_place_guards(self):
        for mutate in (
            lambda: self.route["samples"][1].update(seconds=3),
            lambda: self.route["samples"][1].update(seconds=4, position=[26, 1.65, 42], yaw=0),
            lambda: self.route["samples"][1].update(yaw=float("inf")),
            lambda: self.route["samples"][1].update(place_id="unloaded"),
            lambda: self.route["camera"].update(pitch=1.2),
        ):
            original = deepcopy(self.route)
            mutate()
            with self.assertRaises(ValueError):
                self.read_route()
            self.route = original

    def test_slotted_and_legacy_animation_keys_use_linear_interpolation(self):
        for slotted in (False, True):
            points = [SimpleNamespace(interpolation="BEZIER") for _ in range(3)]
            curve = SimpleNamespace(keyframe_points=points)
            action = (SimpleNamespace(layers=[SimpleNamespace(strips=[SimpleNamespace(
                channelbags=[SimpleNamespace(fcurves=[curve])])])])
                if slotted else SimpleNamespace(fcurves=[curve]))
            adapter.set_linear_camera_keys(SimpleNamespace(animation_data=SimpleNamespace(action=action)))
            self.assertEqual([point.interpolation for point in points], ["LINEAR"] * 3)

    def test_validate_only_does_not_invoke_blender_and_refuses_output_overwrite(self):
        with patch.object(adapter, "import_world") as runtime, redirect_stdout(io.StringIO()) as output:
            adapter.main(["--world", str(self.glb), "--validate-only"])
            self.assertTrue(json.loads(output.getvalue())["valid"])
            runtime.assert_not_called()
        blend = self.directory / "existing.blend"
        blend.write_bytes(b"preserved")
        with patch.object(adapter, "import_world") as runtime, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                adapter.main(["--world", str(self.glb), "--out", str(blend)])
            runtime.assert_not_called()
        self.assertEqual(blend.read_bytes(), b"preserved")


if __name__ == "__main__":
    unittest.main()
