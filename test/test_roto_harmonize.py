"""Raccord (harmonize) et plaque propre (cleanplate) — les deux briques qui rendent la zone
effacée indiscernable de son voisinage. Toutes deux sont PURES : ni GPU, ni poids, ni ffmpeg.

Ce qui est vérifié : que la correction annule bien l'écart de couleur mesuré, qu'elle ne déborde
JAMAIS hors de la zone reconstruite, que la plaque rapatrie des pixels RÉELLEMENT observés (pas
une interpolation), et que les cas dégénérés rendent la main sans lever.
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from nrroto import cleanplate, harmonize  # noqa: E402

HOLE = (slice(40, 88), slice(40, 88))


def gradient_frame(w=160, h=128, seed=0, blobs=40):
    """Fond dégradé + taches contrastées + grain fin.

    Les taches ne sont pas décoratives : le suivi de la plaque propre repose sur des coins de
    Shi-Tomasi, et un dégradé pur n'en contient AUCUN — la plaque déclarerait forfait comme elle le
    fait (correctement) sur un mur uni."""
    ys, xs = np.mgrid[0:h, 0:w]
    frame = np.stack([xs * 200.0 / w, ys * 200.0 / h, np.full((h, w), 110.0)], axis=-1)
    rng = np.random.default_rng(seed)
    for _ in range(blobs):
        bx, by = int(rng.integers(4, w - 12)), int(rng.integers(4, h - 12))
        size = int(rng.integers(4, 10))
        frame[by:by + size, bx:bx + size] = rng.integers(0, 255, 3).astype(np.float32)
    return np.clip(frame + rng.normal(0.0, 4.0, (h, w, 3)), 0, 255).astype(np.uint8)


def hole_mask(shape):
    mask = np.zeros(shape[:2], dtype=bool)
    mask[HOLE] = True
    return mask


def drift(image, truth, region):
    """Écart moyen à la vérité sur `region`. Comparer le trou à sa couronne ne dirait rien : sur un
    fond dégradé leurs moyennes diffèrent de toute façon. Ce qui compte est l'écart au VRAI fond."""
    return float(np.abs(image[region].astype(np.float32) - truth[region].astype(np.float32)).mean())


@unittest.skipUnless(harmonize.available(), "opencv absent : le raccord est neutre par conception")
class HarmonizeTests(unittest.TestCase):
    def test_colour_gap_collapses(self):
        """Sortie de moteur décalée de +12 en luma et -6 en bleu : l'écart doit s'effondrer.

        La dérive porte sur TOUTE la sortie du moteur — c'est le cas réel : l'aller-retour VAE
        décale aussi ce qu'il reconstruit autour du trou. C'est justement là qu'elle se mesure."""
        source = gradient_frame()
        hole = hole_mask(source.shape)
        offset = np.array([12.0, 12.0, -6.0], dtype=np.float32)
        drifted = np.clip(source.astype(np.float32) + offset, 0, 255).astype(np.uint8)

        self.assertTrue(harmonize.ring_mask(hole).any(),
                        "la couronne doit exister sur un trou au centre du cadre")
        before = drift(drifted, source, hole)   # sans raccord : le décalage entier subsiste
        fixed, _ = harmonize.harmonize(source, drifted, hole, strength=1.0, grain=0.0, detail=False)
        after = drift(fixed, source, hole)
        self.assertLess(after, before * 0.2,
                        "l'écart au vrai fond doit chuter d'au moins 80 %% (%.2f → %.2f)" % (before, after))

    def test_never_touches_pixels_outside_the_hole(self):
        """Hors du trou, la sortie est la RÉFÉRENCE au pixel près : le raccord compose lui-même."""
        source = gradient_frame(seed=1)
        hole = hole_mask(source.shape)
        generated = np.clip(source.astype(np.int16) + 20, 0, 255).astype(np.uint8)
        fixed, _ = harmonize.harmonize(source, generated, hole, strength=1.0, grain=1.0)
        np.testing.assert_array_equal(fixed[~hole], source[~hole])

    def test_grain_is_measured_not_invented(self):
        """Source lisse → aucun grain ajouté ; source bruitée → du grain, et il change par image."""
        flat = np.full((128, 128, 3), 90, dtype=np.uint8)
        hole = hole_mask(flat.shape)
        quiet, _ = harmonize.harmonize(flat, flat, hole, strength=0.0, grain=1.0, detail=False)
        np.testing.assert_array_equal(quiet, flat)

        noisy = gradient_frame(w=128, h=128, seed=2)
        first, state = harmonize.harmonize(noisy, noisy, hole, strength=0.0, grain=1.0, detail=False, seed=0)
        second, _ = harmonize.harmonize(noisy, noisy, hole, strength=0.0, grain=1.0, detail=False,
                                        state=state, seed=1)
        self.assertGreater(int(np.abs(first[hole].astype(np.int16) - noisy[hole].astype(np.int16)).max()), 0,
                           "un grain doit être ajouté")
        self.assertFalse(np.array_equal(first[hole], second[hole]),
                         "le grain doit être décorrélé d'une image à l'autre")

    def test_degenerate_cases_compose_without_correcting(self):
        """Trou vide, trou couvrant tout le cadre : composition nue, sans lever ni inventer."""
        source = gradient_frame(w=64, h=64, seed=3)
        generated = np.clip(source.astype(np.int16) + 15, 0, 255).astype(np.uint8)

        empty = np.zeros(source.shape[:2], dtype=bool)
        # Rien à remplacer : la sortie est la source, à l'arrondi près.
        np.testing.assert_allclose(harmonize.harmonize(source, generated, empty)[0], source, atol=1)

        everywhere = np.ones(source.shape[:2], dtype=bool)
        # Aucune couronne mesurable → aucune correction, mais surtout aucune exception.
        np.testing.assert_allclose(harmonize.harmonize(source, generated, everywhere)[0], generated, atol=1)


@unittest.skipUnless(cleanplate.available(), "opencv absent : la plaque est neutre par conception")
class CleanPlateTests(unittest.TestCase):
    def test_static_camera_recovers_the_exact_background(self):
        """Caméra fixe, objet mobile : le fond revient à l'IDENTIQUE, pas interpolé."""
        background = gradient_frame(seed=4)
        hidden = np.zeros(background.shape[:2], dtype=bool)
        hidden[HOLE] = True

        current = background.copy()
        current[hidden] = 0                       # l'objet masque le fond sur l'image courante
        # Voisin : le même fond, l'objet a bougé ailleurs → le trou courant y est visible.
        neighbour_hole = np.zeros_like(hidden)
        neighbour_hole[10:30, 120:150] = True
        neighbour = background.copy()
        neighbour[neighbour_hole] = 0

        plate, filled, coverage = cleanplate.build_plate(
            current, hidden, [(neighbour, neighbour_hole, cleanplate.IDENTITY)])
        self.assertGreater(coverage, 0.9)
        # Pixels RÉELS : la médiane basse choisit une valeur observée, elle n'en fabrique pas.
        np.testing.assert_array_equal(plate[filled], background[filled])
        np.testing.assert_array_equal(plate[~hidden], current[~hidden])

    def test_translated_neighbour_is_realigned(self):
        """Panoramique : le mouvement global est estimé et le voisin recalé avant d'être lu."""
        background = gradient_frame(w=200, h=160, seed=5)
        shift = 12
        hidden = np.zeros(background.shape[:2], dtype=bool)
        hidden[60:100, 60:100] = True
        current = background.copy()
        current[hidden] = 0

        # Le voisin voit la même scène décalée de `shift` px, objet ailleurs.
        shifted = np.roll(background, shift, axis=1)
        neighbour_hole = np.zeros_like(hidden)
        neighbour_hole[20:40, 150:180] = True
        neighbour = shifted.copy()
        neighbour[neighbour_hole] = 0

        matrix = cleanplate.global_motion(neighbour, current, neighbour_hole, hidden)
        self.assertIsNotNone(matrix, "le mouvement global doit être estimé sur une scène texturée")
        self.assertAlmostEqual(float(matrix[0, 2]), -shift, delta=1.5)

        plate, filled, coverage = cleanplate.build_plate(current, hidden, [(neighbour, neighbour_hole, matrix)])
        self.assertGreater(coverage, 0.9)
        self.assertLess(float(np.abs(plate[filled].astype(np.float32)
                                     - background[filled].astype(np.float32)).mean()), 6.0)

    def test_nothing_revealed_is_not_an_error(self):
        """Caméra ET objet fixes : le fond n'est jamais révélé — couverture nulle, aucune casse."""
        frame = gradient_frame(seed=6)
        hidden = hole_mask(frame.shape)
        current = frame.copy()
        current[hidden] = 0
        plate, filled, coverage = cleanplate.build_plate(current, hidden,
                                                         [(current, hidden, cleanplate.IDENTITY)])
        self.assertEqual(coverage, 0.0)
        self.assertFalse(filled.any())
        np.testing.assert_array_equal(plate, current)

    def test_moving_parasite_is_outvoted_by_the_median(self):
        """Un intrus présent sur UN seul voisin ne doit pas s'imprimer dans la plaque."""
        background = gradient_frame(seed=7)
        hidden = hole_mask(background.shape)
        current = background.copy()
        current[hidden] = 0

        clean_hole = np.zeros_like(hidden)
        good = [(background.copy(), clean_hole, cleanplate.IDENTITY) for _ in range(2)]
        parasite = background.copy()
        parasite[HOLE] = 255                       # passant / reflet, sur un seul voisin
        candidates = [good[0], (parasite, clean_hole, cleanplate.IDENTITY), good[1]]

        plate, filled, _ = cleanplate.build_plate(current, hidden, candidates)
        np.testing.assert_array_equal(plate[filled], background[filled])


if __name__ == "__main__":
    unittest.main()
