"""Free regression checks for the offline film's framing and return."""

import importlib.util
import unittest
from pathlib import Path

from PIL import Image


spec = importlib.util.spec_from_file_location("lighthouse_film", Path(__file__).with_name("compose-lighthouse-film.py"))
film = importlib.util.module_from_spec(spec)
spec.loader.exec_module(film)


class LighthouseFilmTests(unittest.TestCase):
    def test_landmark_and_tap_stay_in_frame_without_exposed_borders(self):
        film.verify_geometry()

    def test_crop_contains_the_complete_landmark_with_padding(self):
        x, y, fraction = film.crop_for_landmark()
        bx, by, bw, bh = film.LANDMARK
        self.assertLessEqual(x, bx - film.PADDING + 1e-9)
        self.assertLessEqual(y, by - film.PADDING + 1e-9)
        self.assertGreaterEqual(x + fraction, bx + bw + film.PADDING - 1e-9)
        self.assertGreaterEqual(y + fraction, by + bh + film.PADDING - 1e-9)

    def test_return_is_the_exact_same_resampled_source(self):
        with Image.open(film.SOURCE) as image:
            source = image.convert("RGB")
        start = film.source_frame(source, 0)
        end = film.source_frame(source, film.DURATION)
        self.assertEqual(start.tobytes(), end.tobytes())
        last_encoded = film.source_frame(source, (film.FPS * film.DURATION - 1) / film.FPS)
        self.assertEqual(start.tobytes(), last_encoded.tobytes())
        self.assertNotEqual(start.tobytes(), film.source_frame(source, 5).tobytes())

    def test_approach_and_return_are_monotonic(self):
        forward = [film.progress_at(film.APPROACH_START + i * (film.APPROACH_END - film.APPROACH_START) / 100) for i in range(101)]
        backward = [film.progress_at(film.RETURN_START + i * (film.RETURN_END - film.RETURN_START) / 100) for i in range(101)]
        self.assertEqual(forward, sorted(forward))
        self.assertEqual(backward, sorted(backward, reverse=True))
        self.assertEqual(film.progress_at(5), 1)
        self.assertEqual(film.progress_at(12), 0)

    def test_selection_cue_is_local_to_actual_target_before_motion(self):
        frame = Image.new("RGB", film.SIZE, "black")
        self.assertEqual(frame.tobytes(), film.selection_cue(frame, (1376, 768), 0).tobytes())
        self.assertEqual(frame.tobytes(), film.selection_cue(frame, (1376, 768), film.APPROACH_START).tobytes())
        selected = film.selection_cue(frame, (1376, 768), 1.2)
        bounds = selected.getbbox()
        self.assertIsNotNone(bounds)
        x = film.TAP[0] * 1920
        y = 4 + film.TAP[1] * 1072
        self.assertAlmostEqual((bounds[0] + bounds[2]) / 2, x, delta=1)
        self.assertAlmostEqual((bounds[1] + bounds[3]) / 2, y, delta=1)
        self.assertLess(bounds[2] - bounds[0], 95)

    def test_clean_map_hold_is_not_covered_by_a_title(self):
        with Image.open(film.SOURCE) as image:
            source = image.convert("RGB")
        self.assertEqual(film.film_frame(source, 10).tobytes(), film.source_frame(source, 0).tobytes())


if __name__ == "__main__":
    unittest.main()
