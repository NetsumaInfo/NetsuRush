import sys
import types
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from upscaler.imgout import (image_encode_args, image_ext, image_spec,  # noqa: E402
                             jpeg_qscale, sequence_first)


def req(**kwargs):
    """Requête worker minimale (le sidecar accède aux réglages par attribut)."""
    return types.SimpleNamespace(**kwargs)


class ImageArgsTests(unittest.TestCase):
    def test_png_depth_and_alpha_drive_the_pixel_format(self):
        self.assertEqual(image_encode_args("png", 8, 6)[-2:], ["-pix_fmt", "rgb24"])
        self.assertEqual(image_encode_args("png", 8, 6, alpha=True)[-2:], ["-pix_fmt", "rgba"])
        self.assertEqual(image_encode_args("png", 16, 6)[-2:], ["-pix_fmt", "rgb48be"])
        self.assertEqual(image_encode_args("png", 16, 6, alpha=True)[-2:], ["-pix_fmt", "rgba64be"])

    def test_png_compression_is_bounded(self):
        self.assertIn("9", image_encode_args("png", 8, 42))
        self.assertIn("0", image_encode_args("png", 8, -3))

    def test_jpeg_quality_maps_to_the_inverted_mjpeg_scale(self):
        self.assertEqual(jpeg_qscale(100), 2)
        self.assertEqual(jpeg_qscale(1), 31)
        self.assertLess(jpeg_qscale(92), jpeg_qscale(60))
        args = image_encode_args("jpeg", quality=92)
        self.assertEqual(args[:2], ["-c:v", "mjpeg"])
        self.assertIn("yuvj444p", args)

    def test_extension_follows_the_format(self):
        self.assertEqual(image_ext("png"), "png")
        self.assertEqual(image_ext("jpeg"), "jpg")
        self.assertEqual(image_ext(None), "png")


class ImageSpecTests(unittest.TestCase):
    def test_a_request_without_output_settings_stays_on_video(self):
        spec = image_spec(req())
        self.assertEqual(spec["kind"], "video")

    def test_an_unknown_kind_falls_back_to_video(self):
        self.assertEqual(image_spec(req(out_kind="nawak"))["kind"], "video")

    def test_the_core_arguments_win_over_the_local_fallback(self):
        spec = image_spec(req(out_kind="sequence", image_args=["-c:v", "png", "-pix_fmt", "rgba"]))
        self.assertEqual(spec["args"], ["-c:v", "png", "-pix_fmt", "rgba"])

    def test_the_fallback_rebuilds_the_same_arguments_for_a_direct_cli_call(self):
        spec = image_spec(req(out_kind="sequence", img_format="png", png_bits=16), alpha=True)
        self.assertEqual(spec["args"], image_encode_args("png", 16, 6, alpha=True))

    def test_the_first_frame_of_a_sequence_uses_the_requested_start_number(self):
        spec = image_spec(req(out_kind="sequence", seq_start=1001))
        self.assertEqual(sequence_first("out/clip_%04d.png", spec), "out/clip_1001.png")
        single = image_spec(req(out_kind="image"))
        self.assertEqual(sequence_first("out/clip.png", single), "out/clip.png")


if __name__ == "__main__":
    unittest.main()
