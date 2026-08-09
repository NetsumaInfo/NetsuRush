"""Résolution du modèle CHARGÉ par les sidecars.

Deux régressions réelles sont gardées ici :
  - NETSURUSH_WHISPER_DIR s'appliquait à TOUTE variante : demander « small » chargeait en silence
    le modèle provisionné à l'installation (turbo) ;
  - les modèles de profondeur installés par Paramètres › Modèles n'étaient jamais lus, transformers
    retéléchargeait le dépôt dans son propre cache.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python"))

from nrproc.runner import local_model_dir  # noqa: E402
from nrvoice.asr_whisper import _resolve  # noqa: E402


class WhisperResolveTest(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        os.environ.pop("NETSURUSH_WHISPER_DIR", None)
        os.environ.pop("NETSURUSH_WHISPER_ID", None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_job_directory_wins(self):
        self.assertEqual(_resolve("whisper-small", "C:/models/voice-asr/whisper-small"),
                         "C:/models/voice-asr/whisper-small")

    def test_setup_directory_serves_the_provisioned_variant(self):
        os.environ["NETSURUSH_WHISPER_DIR"] = "C:/nr/weights/whisper-large-v3-turbo"
        self.assertEqual(_resolve("whisper-turbo", None), "C:/nr/weights/whisper-large-v3-turbo")

    def test_setup_directory_never_serves_another_variant(self):
        os.environ["NETSURUSH_WHISPER_DIR"] = "C:/nr/weights/whisper-large-v3-turbo"
        self.assertEqual(_resolve("whisper-small", None), "small")
        self.assertEqual(_resolve("whisper-large-v3", None), "large-v3")

    def test_unknown_variant_falls_back_to_turbo(self):
        self.assertEqual(_resolve("whisper-zzz", None), "large-v3-turbo")


class LocalModelDirTest(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_existing_directory(self):
        here = os.path.dirname(os.path.abspath(__file__))
        os.environ["NETSURUSH_MODEL_DIRS"] = '{"depth-anything-v2-base": %s}' % repr(here).replace("'", '"')
        self.assertEqual(local_model_dir("depth-anything-v2-base"), here)

    def test_missing_directory_is_ignored(self):
        os.environ["NETSURUSH_MODEL_DIRS"] = '{"depth-anything-v2-base": "C:/absent-du-disque"}'
        self.assertIsNone(local_model_dir("depth-anything-v2-base"))

    def test_absent_or_broken_table(self):
        os.environ.pop("NETSURUSH_MODEL_DIRS", None)
        self.assertIsNone(local_model_dir("depth-anything-v2-base"))
        os.environ["NETSURUSH_MODEL_DIRS"] = "pas du json"
        self.assertIsNone(local_model_dir("depth-anything-v2-base"))


if __name__ == "__main__":
    unittest.main()
