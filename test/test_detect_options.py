import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / "python"
sys.path.insert(0, str(PYTHON_DIR))
SPEC = importlib.util.spec_from_file_location("netsurush_detect", PYTHON_DIR / "detect.py")
DETECT = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(DETECT)


class DetectOptionsTests(unittest.TestCase):
    def test_omnishot_options_are_normalized_and_part_of_cache_identity(self):
        base, base_key = DETECT._canonical_options("omnishotcut", 0.0, {
            "minSceneFrames": 1,
            "omnishotcut": {
                "mode": "default",
                "overlapWindowLength": 20,
                "intraLabels": ["Dissolve", "General", "invalid"],
                "interLabels": ["Hard_Cut", "Transition", "invalid"],
            },
        })
        changed, changed_key = DETECT._canonical_options("omnishotcut", 0.0, {
            "minSceneFrames": 1,
            "omnishotcut": {
                "mode": "default",
                "overlapWindowLength": 60,
                "intraLabels": ["General", "Dissolve"],
                "interLabels": ["Transition", "Hard_Cut"],
            },
        })
        self.assertEqual(base["omnishotcut"]["intraLabels"], ["Dissolve", "General"])
        self.assertEqual(base["omnishotcut"]["interLabels"], ["Hard_Cut", "Transition"])
        self.assertEqual(changed["omnishotcut"]["overlapWindowLength"], 60)
        self.assertNotEqual(base_key, changed_key)

    def test_model_specific_options_are_clamped(self):
        auto, _ = DETECT._canonical_options("autoshot", 0.296, {
            "autoshot": {"threshold": 2.0},
        })
        self.assertEqual(auto["autoshot"]["threshold"], 0.99)

    def test_postprocess_preserves_omni_labels(self):
        scenes = DETECT._postprocess_scenes([
            {"startFrame": 0, "endFrame": 9, "intraLabel": "General", "interLabel": "New_Start"},
            {"startFrame": 10, "endFrame": 19, "intraLabel": "Dissolve", "interLabel": "Transition"},
        ], 10.0, 1)
        self.assertEqual(scenes[1]["intraLabel"], "Dissolve")
        self.assertEqual(scenes[1]["interLabel"], "Transition")


if __name__ == "__main__":
    unittest.main()
