"""Égalité du décodage groupé et du chemin historique sur un vrai clip.

Usage : python python/test_shot_decode.py <clip> [--model-dir <dossier SigLIP>]
"""
import argparse
import pathlib
import sys
import unittest

import numpy as np
from PIL import Image, ImageChops

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from nrsearch import media, model  # noqa: E402
from nrsearch.config import GRAB_MAX_EDGE  # noqa: E402


class ShotDecodeTests(unittest.TestCase):
    clip = None

    def setUp(self):
        if not self.clip:
            self.skipTest("clip réel non fourni")

    def timestamps(self):
        _fps, _frames, scenes = media.get_scenes(self.clip)
        scene = next((value for value in scenes if value["end"] - value["start"] >= 1.0), None)
        self.assertIsNotNone(scene, "aucun plan vidéo assez long")
        start = float(scene["start"])
        span = float(scene["end"]) - start
        return [start + span * ratio for ratio in (0.25, 0.5, 0.75)]

    def decoded_frames(self):
        timestamps = self.timestamps()
        legacy = [media.grab_ffmpeg(self.clip, sec, max_edge=GRAB_MAX_EDGE)
                  for sec in timestamps]
        grouped = media.grab_shot(self.clip, timestamps, max_edge=GRAB_MAX_EDGE)
        self.assertTrue(all(isinstance(frame, Image.Image) for frame in legacy))
        self.assertEqual(len(grouped), len(legacy))
        return legacy, grouped

    def test_grouped_decode_preserves_pixels(self):
        legacy, grouped = self.decoded_frames()
        for old, new in zip(legacy, grouped):
            self.assertIsNone(ImageChops.difference(old, new).getbbox())

    def test_grouped_decode_preserves_embeddings(self):
        if not model.MODEL_SRC or not pathlib.Path(model.MODEL_SRC).exists():
            self.skipTest("poids SigLIP locaux non fournis")
        legacy, grouped = self.decoded_frames()
        model.load()
        old_embeddings = model.embed_images(legacy)
        new_embeddings = model.embed_images(grouped)
        np.testing.assert_allclose(old_embeddings, new_embeddings, rtol=0.0, atol=0.0)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("clip", nargs="?")
    parser.add_argument("--model-dir")
    return parser.parse_known_args()


if __name__ == "__main__":
    args, unittest_args = parse_args()
    ShotDecodeTests.clip = args.clip
    if args.model_dir:
        model.MODEL_SRC = args.model_dir
    unittest.main(argv=[sys.argv[0], *unittest_args])
