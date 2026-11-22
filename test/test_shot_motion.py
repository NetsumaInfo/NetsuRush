"""Shot motion tags (python/nrsearch/motion.py) and the search post-filters built on them.

Synthetic frames only: a textured background slid sideways is a camera pan, a textured block moving
over a still background is a subject. No video, no model.
"""
import pathlib
import sqlite3
import sys
import unittest

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from nrsearch import motion, query  # noqa: E402

W, H, FPS = 320, 180, 24.0


def texture(seed, w, h):
    import cv2
    rng = np.random.default_rng(seed)
    small = rng.integers(0, 255, (h // 4, w // 4), dtype=np.uint8)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def panning_frames(step_px, count=10):
    wide = texture(1, W + abs(step_px) * count + 8, H)
    frames = []
    for i in range(count):
        x = 4 + (i * step_px if step_px > 0 else (count - 1 - i) * -step_px)
        frames.append(np.ascontiguousarray(wide[:, x:x + W]))
    return frames


def subject_frames(dx, count=10):
    background = (texture(2, W, H) // 3).astype(np.uint8)
    block = texture(3, 60, 60)
    frames = []
    for i in range(count):
        frame = background.copy()
        x = 120 + i * dx
        frame[60:120, x:x + 60] = block
        frames.append(frame)
    return frames


def times(count=10):
    return [i / FPS for i in range(count)]


class MeasureTests(unittest.TestCase):
    def test_picture_sliding_left_is_a_pan_right(self):
        raw = motion.measure(panning_frames(4), times())
        self.assertIsNotNone(raw)
        self.assertEqual(motion.camera_tag(raw), "pan-right")

    def test_block_moving_right_is_a_subject_right_on_a_static_camera(self):
        raw = motion.measure(subject_frames(6), times())
        tags = motion.tags(raw)
        self.assertEqual(tags["camera"], "static")
        self.assertEqual(tags["subject"], "right")

    def test_held_drawings_do_not_read_as_still(self):
        # animated on twos: every drawing shown twice
        frames = [f for f in subject_frames(-8, 6) for _ in range(2)]
        self.assertEqual(motion.tags(motion.measure(frames, times(12)))["subject"], "left")

    def test_flat_image_is_unmeasurable(self):
        flat = [np.full((H, W), 40, np.uint8)] * 8
        self.assertIsNone(motion.measure(flat, times(8)))
        self.assertEqual(motion.tags(None), {"subject": "unclear", "camera": "unclear", "speed": None})


class TagTests(unittest.TestCase):
    def test_coarse_request_matches_diagonals(self):
        self.assertTrue(motion.tag_matches("up-left", "left"))
        self.assertTrue(motion.tag_matches("pan-down-right", "pan-right"))
        self.assertFalse(motion.tag_matches("pan-left", "left"))
        self.assertFalse(motion.tag_matches("left", "pan-left"))
        self.assertFalse(motion.tag_matches("unclear", "left"))
        self.assertTrue(motion.tag_matches("zoom-in", "zoom-in"))
        self.assertFalse(motion.tag_matches("zoom-in", "in"))

    def test_edge_ranges_stay_inside_the_shot(self):
        start, end = motion.edge_ranges(100, 103, FPS)
        self.assertEqual(start, (100, 103))
        self.assertEqual(end, (100, 103))
        start, end = motion.edge_ranges(0, 239, FPS)
        self.assertEqual(start, (0, 9))
        self.assertEqual(end, (230, 239))


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        motion.ensure_tables(self.con)
        right = motion.measure(subject_frames(6), times())
        still = motion.measure(subject_frames(0), times())
        motion.store(self.con, "a.mp4", 1.0, "cut", [(0, 0, 47), (1, 48, 95)], {0: (right, still), 1: (still, still)})

    def hit(self, index, start, end, src_frames=10000):
        sf = int(start * FPS)
        return {"file_path": "a.mp4", "scene_index": index, "start_frame": sf if index else 0,
                "end_frame": 47 if index == 0 else 95, "start_sec": start, "end_sec": end,
                "fps": FPS, "src_frames": src_frames, "score": 0.5}

    def test_motion_filter_keeps_only_matching_end(self):
        hits = [self.hit(0, 0.0, 2.0), self.hit(1, 2.0, 4.0)]
        filters = query._search_filters({"motion": {"at": "start", "subject": ["right"]}}, self.con, [])
        out = query._finish(self.con, {"hits": hits}, filters, 10)["hits"]
        self.assertEqual([h["scene_index"] for h in out], [0])
        filters = query._search_filters({"motion": {"at": "end", "subject": ["right"]}}, self.con, [])
        self.assertEqual(query._finish(self.con, {"hits": [self.hit(0, 0.0, 2.0)]}, filters, 10)["hits"], [])

    def test_tags_ride_along_without_filters(self):
        out = query._finish(self.con, {"hits": [self.hit(0, 0.0, 2.0)]}, None, 10)["hits"]
        self.assertEqual(out[0]["motion"]["start"]["subject"], "right")

    def test_stale_boundaries_get_no_tags(self):
        hit = self.hit(0, 0.0, 2.0)
        hit["end_frame"] = 50
        out = query._finish(self.con, {"hits": [hit]}, None, 10)["hits"]
        self.assertNotIn("motion", out[0])

    def test_episode_edges_and_match_cut_source_are_left_out(self):
        hits = [self.hit(0, 10.0, 12.0), self.hit(1, 200.0, 202.0)]
        filters = query._search_filters({"skip_edges_sec": 150}, self.con, [])
        self.assertEqual([h["scene_index"] for h in query._finish(self.con, {"hits": list(hits)}, filters, 10)["hits"]], [1])
        filters = query._search_filters({}, self.con, [{"file_path": "a.mp4", "scene_index": 1, "edge": "end"}])
        self.assertEqual([h["scene_index"] for h in query._finish(self.con, {"hits": list(hits)}, filters, 10)["hits"]], [0])

    def test_short_rush_keeps_its_edges(self):
        filters = query._search_filters({"skip_edges_sec": 150}, self.con, [])
        short = self.hit(0, 10.0, 12.0, src_frames=int(200 * FPS))
        self.assertEqual(len(query._finish(self.con, {"hits": [short]}, filters, 10)["hits"]), 1)


if __name__ == "__main__":
    unittest.main()
