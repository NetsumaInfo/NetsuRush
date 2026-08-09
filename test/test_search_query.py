"""Compréhension de la requête + tri d'un « @perso » — la partie PURE de la recherche.

Aucun torch, aucun modèle : on vérifie ce qui décidait du classement sans qu'on puisse le voir
(cadrage du prompt, langue, fusion identité/action, recouvrement multi-personnages).
"""
import pathlib
import sys
import unittest

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from nrsearch import qtext                      # noqa: E402
from nrsearch import query, store               # noqa: E402


class NormalizeTests(unittest.TestCase):
    def test_unresolved_mention_is_dropped_not_searched(self):
        # « @Vilot » (faute de frappe) cherché comme un mot ordinaire ramenait n'importe quoi.
        self.assertEqual(qtext.normalize("@Vilot court sous la pluie"), "court sous la pluie")

    def test_edges_are_trimmed_but_accents_kept(self):
        self.assertEqual(qtext.normalize("  « épée levée ! »  "), "épée levée")


class LanguageTests(unittest.TestCase):
    def test_script_wins_over_interface_language(self):
        self.assertEqual(qtext.detect_lang("雨の中を走る", "fr"), "ja")
        self.assertEqual(qtext.detect_lang("在雨中奔跑", "fr"), "zh")

    def test_stopwords_identify_latin_languages(self):
        self.assertEqual(qtext.detect_lang("une fille dans la rue", "en"), "fr")
        self.assertEqual(qtext.detect_lang("a girl in the street", "fr"), "en")

    def test_short_query_falls_back_to_interface_language(self):
        self.assertEqual(qtext.detect_lang("cerisier", "fr"), "fr")
        self.assertEqual(qtext.detect_lang("", "ja"), "ja")
        self.assertEqual(qtext.detect_lang("cerisier", None), qtext.DEFAULT_LANG)


class SubjectTests(unittest.TestCase):
    def test_redundant_subject_is_removed_when_a_character_is_cited(self):
        self.assertEqual(qtext.strip_subject("elle est en train de courir", "fr"), "courir")
        self.assertEqual(qtext.strip_subject("she is running", "en"), "running")
        self.assertEqual(qtext.strip_subject("キャラクターが走る", "ja"), "走る")

    def test_never_empties_the_query(self):
        self.assertEqual(qtext.strip_subject("elle", "fr"), "elle")


class ViewTests(unittest.TestCase):
    def test_bare_query_leads_and_weighs_most(self):
        views = qtext.build_views("court sous la pluie", "fr")
        self.assertEqual(views[0], ("court sous la pluie", qtext.BARE_WEIGHT))
        self.assertTrue(all(w <= qtext.BARE_WEIGHT for _v, w in views[1:]))

    def test_framing_is_written_in_the_query_language(self):
        # Un cadrage français collé à une requête japonaise mélangeait deux langues dans un vecteur.
        for view, _weight in qtext.build_views("走る", "ja"):
            self.assertNotIn("photo de", view)
        self.assertTrue(any("una foto" in v for v, _w in qtext.build_views("un perro", "es")))

    def test_character_framing_covers_more_than_actions(self):
        # « décor », « tenue », « émotion » doivent passer aussi bien qu'un verbe : le cadrage parle
        # d'un personnage, il ne préjuge pas d'une action.
        views = [v for v, _w in qtext.build_views("dans une forêt", "fr", character=True)]
        self.assertTrue(any("personnage" in v for v in views))
        self.assertNotIn("action", " ".join(views))

    def test_scene_query_is_not_framed_as_a_character(self):
        views = [v for v, _w in qtext.build_views("coucher de soleil", "fr")]
        self.assertFalse(any("personnage" in v for v in views))

    def test_empty_query_has_no_view(self):
        self.assertEqual(qtext.build_views("   ", "fr"), [])


class CoOccurrenceTests(unittest.TestCase):
    def test_strict_intersection_wins_when_it_exists(self):
        pools = [{("a.mp4", 0): 0.9, ("a.mp4", 1): 0.8}, {("a.mp4", 1): 0.7}]
        allowed, covered = query._co_occurrence(pools, None)
        self.assertEqual(allowed, {("a.mp4", 1)})
        self.assertEqual(covered, 2)

    def test_falls_back_to_the_widest_overlap_instead_of_nothing(self):
        pools = [{("a.mp4", 0): 0.9}, {("a.mp4", 0): 0.8}, {("b.mp4", 3): 0.9}]
        allowed, covered = query._co_occurrence(pools, None)
        self.assertEqual(allowed, {("a.mp4", 0)})
        self.assertEqual(covered, 2)   # 2 persos sur 3 → l'appelant le signale

    def test_project_scope_is_applied_before_counting(self):
        pools = [{("a.mp4", 0): 0.9, ("b.mp4", 0): 0.9}, {("b.mp4", 0): 0.9}]
        allowed, covered = query._co_occurrence(pools, ["a.mp4"])
        self.assertEqual(allowed, {("a.mp4", 0)})
        self.assertEqual(covered, 1)

    def test_joint_confidence_is_the_weakest_recognition(self):
        pools = [{("a.mp4", 0): 0.98}, {("a.mp4", 0): 0.61}]
        self.assertAlmostEqual(query._joint_confidence({("a.mp4", 0)}, pools)[("a.mp4", 0)], 0.61)


class RankingFusionTests(unittest.TestCase):
    def test_identity_breaks_ties_when_the_action_barely_separates(self):
        action = np.array([0.200, 0.201, 0.199], np.float32)   # trois plans quasi équivalents
        identity = np.array([0.62, 0.99, 0.70], np.float32)
        fused = store._zscore(action) + 0.25 * store._zscore(identity)
        self.assertEqual(int(np.argmax(fused)), 1)             # le perso y est reconnu avec certitude

    def test_a_clear_action_still_wins_over_identity(self):
        action = np.array([0.05, 0.40, 0.06], np.float32)
        identity = np.array([0.99, 0.62, 0.99], np.float32)
        fused = store._zscore(action) + 0.25 * store._zscore(identity)
        self.assertEqual(int(np.argmax(fused)), 1)

    def test_a_flat_signal_does_not_order_anything(self):
        flat = np.full(4, 0.7, np.float32)
        self.assertTrue(np.all(store._zscore(flat) == 0))


class ScopedSearchTests(unittest.TestCase):
    """Chemin complet d'un « @perso + texte » : pool → classement fusionné → scores affichés."""

    SHOTS = [   # (fichier, plan, embedding) — le plan 1 matche le mieux le texte, de justesse
        ("a.mp4", 0, [0.99, 0.14]),
        ("a.mp4", 1, [1.00, 0.05]),
        ("a.mp4", 2, [0.98, 0.20]),
    ]

    def _run(self, identity, weight):
        import os
        import sqlite3
        import tempfile
        from unittest.mock import patch
        from nrsearch.config import MODEL_TAG

        fd, db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(db_path)
        try:
            con.execute(
                "CREATE TABLE frame_embeddings_v1("
                "file_path TEXT, model TEXT, scene_index INTEGER, start_frame INTEGER, "
                "end_frame INTEGER, mid_frame INTEGER, start_sec REAL, end_sec REAL, fps REAL, "
                "src_frames INTEGER, thumb BLOB, embedding BLOB, dim INTEGER)"
            )
            for path, index, vec in self.SHOTS:
                unit = np.asarray(vec, np.float32)
                unit /= np.linalg.norm(unit)
                con.execute("INSERT INTO frame_embeddings_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (path, MODEL_TAG, index, 0, 9, 4, 0.0, 1.0, 24.0, 10, None,
                             unit.tobytes(), 2))
            con.commit()
        finally:
            con.close()
        try:
            with patch.object(store, "db_emb", lambda: sqlite3.connect(db_path)), \
                    patch.object(store, "purge_malformed_embeddings", lambda _con: 0), \
                    patch.object(store.model, "calibrate", lambda score: float(score)):
                return store.SearchStore().search_scoped(
                    np.array([1.0, 0.0], np.float32),
                    {(p, i) for p, i, _v in self.SHOTS}, 10,
                    identity=identity, identity_weight=weight)["hits"]
        finally:
            os.unlink(db_path)

    def test_identity_reorders_shots_the_text_barely_separates(self):
        confident = {("a.mp4", 0): 0.97, ("a.mp4", 1): 0.62, ("a.mp4", 2): 0.63}
        without = self._run(None, 0.0)
        self.assertEqual(without[0]["scene_index"], 1)          # texte seul : écart minuscule
        with_identity = self._run(confident, 1.0)
        self.assertEqual(with_identity[0]["scene_index"], 0)    # le perso y est vraiment reconnu

    def test_displayed_score_never_contradicts_the_order(self):
        hits = self._run({("a.mp4", 0): 0.97, ("a.mp4", 1): 0.62, ("a.mp4", 2): 0.63}, 0.25)
        scores = [hit["score"] for hit in hits]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertAlmostEqual(scores[0], 1.0)
        self.assertAlmostEqual(scores[-1], 0.0)


if __name__ == "__main__":
    unittest.main()
