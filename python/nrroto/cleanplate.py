"""Plaque propre : reconstituer le fond avec les VRAIS pixels des images voisines.

POURQUOI. Un moteur d'inpainting invente le fond ; ce fond inventé n'a ni la colorimétrie, ni le
grain, ni la netteté de la source, d'où la trace visible. Or dans un plan réel le fond caché par
l'objet est le plus souvent FILMÉ quelques images plus tôt ou plus tard — l'objet bouge, ou la
caméra bouge. C'est le principe du « clean plate » : les outils pro (After Effects Content-Aware
Fill, Mocha Pro Remove, Nuke) vont chercher ces pixels au lieu de les deviner, et ne synthétisent
que ce qui n'a jamais été filmé.

Bénéfice : tout ce que la plaque remplit est exact PAR CONSTRUCTION (même capteur, même
compression, même grain), et le moteur ne traite plus que le RÉSIDU — donc il hallucine moins et
la zone à raccorder rétrécit d'autant.

Méthode : mouvement GLOBAL entre images CONSÉCUTIVES (points de Shi-Tomasi hors masque suivis en
Lucas-Kanade, similarité robuste RANSAC),
composé pour atteindre un voisin lointain. Estimer directement chacun des K couples coûterait N·K
suivis ; la chaîne n'en coûte que N. Puis warp du voisin dans la géométrie courante et MÉDIANE des
candidats : un passant, une ombre ou un objet mobile parasite reste minoritaire et disparaît.

Caméra ET objet immobiles = cas dégénéré normal : le fond n'est jamais révélé, la couverture vaut
0, l'appelant retombe exactement sur son comportement d'origine et la plaque se DÉSACTIVE d'
elle-même après quelques images pour ne pas payer un suivi inutile. Sans cv2, le module est neutre.
"""
import os
from collections import deque

import numpy as np

try:
    import cv2
except Exception:  # noqa: BLE001 — venv sans opencv : la plaque se désactive, cf. en-tête
    cv2 = None

# Réglages du suivi de points. Sous-échantillonnage de l'analyse : le suivi n'a pas besoin de la
# pleine résolution, et un rush 4K coûterait 10× plus cher pour un gain nul — les décalages sont
# remis à l'échelle. `LK_PARAMS` dépend de cv2 : sans opencv la plaque est inerte (`available()` est
# faux, rien ne lit ces valeurs) mais le module doit rester importable.
ANALYSIS_MAX_WIDTH = 960
FEATURE_PARAMS = dict(maxCorners=600, qualityLevel=0.01, minDistance=16, blockSize=7)
LK_PARAMS = dict(winSize=(21, 21), maxLevel=3,
                 criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)) if cv2 else None
MIN_TRACKED_POINTS = 12

# Fiabilité de la similarité estimée : un plancher absolu ET une proportion des points suivis. Un
# fond peu texturé (ciel, mur, aplat d'anime) ne donne qu'une poignée de coins ; exiger un COMPTE
# élevé y rejetterait une estimation pourtant juste. C'est la cohérence qui décide, pas le volume.
MIN_INLIERS = 8
MIN_INLIER_RATIO = 0.4
LK_MAX_ERROR = 40.0          # erreur de suivi Lucas-Kanade au-delà de laquelle le point est jeté
VALID_ERODE = 2              # on retire un liseré du fond warpé : le rééchantillonnage y a mélangé
                             # les pixels de l'objet, les reprendre réimprimerait son contour
DEFAULT_RADIUS = 24          # portée temporelle de recherche, en images
DEFAULT_STEP = 3             # une image sur N : deux voisins consécutifs sont redondants
DEFAULT_LIMIT = 8            # plafond de voisins réellement warpés (coût)
ENOUGH_COVERAGE = 0.995      # trou comblé : inutile de continuer à chercher
CACHE_FRAMES = 64            # images voisines décodées gardées sous la main (elles se recoupent)

# Auto-extinction : si les premières images ne rapportent rien, le fond n'est jamais révélé
# (caméra et objet fixes). Inutile de payer le suivi sur tout le plan.
PROBE_FRAMES = 6
MIN_USEFUL_COVERAGE = 0.02

IDENTITY = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float32)


def available():
    return cv2 is not None


def _gray(rgb, scale):
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if scale != 1.0:
        g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return g


def _compose(outer, inner):
    """`outer ∘ inner` : appliquer `inner` puis `outer` (matrices affines 2×3)."""
    a = np.vstack([outer, (0.0, 0.0, 1.0)])
    b = np.vstack([inner, (0.0, 0.0, 1.0)])
    return (a @ b)[:2].astype(np.float32)


def global_motion(src_rgb, dst_rgb, src_exclude, dst_exclude):
    """Similarité 2×3 amenant les pixels de `src_rgb` dans la géométrie de `dst_rgb`, ou None.

    Les points sont cherchés HORS du masque source (sinon on suivrait l'objet à effacer) et ceux
    qui atterrissent DANS le masque destination sont jetés (ils y seraient occultés)."""
    if cv2 is None:
        return None
    scale = min(1.0, ANALYSIS_MAX_WIDTH / float(src_rgb.shape[1])) if src_rgb.shape[1] else 1.0
    src_gray, dst_gray = _gray(src_rgb, scale), _gray(dst_rgb, scale)
    keep_mask = (~src_exclude).astype(np.uint8) * 255
    if scale != 1.0:
        keep_mask = cv2.resize(keep_mask, (src_gray.shape[1], src_gray.shape[0]),
                               interpolation=cv2.INTER_NEAREST)
    points = cv2.goodFeaturesToTrack(src_gray, mask=keep_mask, **FEATURE_PARAMS)
    if points is None or len(points) < MIN_TRACKED_POINTS:
        return None

    moved, status, error = cv2.calcOpticalFlowPyrLK(src_gray, dst_gray, points, None, **LK_PARAMS)
    if moved is None or status is None:
        return None
    keep = (status.reshape(-1) == 1) & (error.reshape(-1) < LK_MAX_ERROR)
    if keep.sum() < MIN_TRACKED_POINTS:
        return None

    # Rejeter les arrivées masquées côté destination : elles ne décrivent pas le mouvement du fond.
    landed = moved[keep].reshape(-1, 2) / (scale or 1.0)
    h, w = dst_exclude.shape
    xs = np.clip(landed[:, 0].astype(np.int32), 0, w - 1)
    ys = np.clip(landed[:, 1].astype(np.int32), 0, h - 1)
    visible = ~dst_exclude[ys, xs]
    if visible.sum() < MIN_TRACKED_POINTS:
        return None

    matrix, inliers = cv2.estimateAffinePartial2D(points[keep][visible], moved[keep][visible],
                                                  method=cv2.RANSAC)
    if matrix is None or inliers is None:
        return None
    agreed = int(inliers.sum())
    if agreed < MIN_INLIERS or agreed < MIN_INLIER_RATIO * int(visible.sum()):
        return None
    matrix = matrix.astype(np.float32)
    if scale != 1.0:
        # Seule la translation dépend de la résolution d'analyse ; rotation et échelle sont sans unité.
        matrix[:, 2] /= scale
    return matrix


def _lower_median(stack, valid, count):
    """Médiane basse par pixel sur les candidats valides, sans NaN et sans interpolation.

    Les invalides sont poussés à +inf, on trie, on lit l'élément du milieu de CHAQUE pixel. Le
    résultat est donc une valeur RÉELLEMENT observée dans une image source — pas une moyenne :
    le grain et la texture d'origine sont conservés tels quels."""
    ranked = np.where(valid[..., None], stack, np.inf)
    ranked.sort(axis=0)
    middle = (np.maximum(count, 1) - 1) // 2
    index = np.repeat(middle[None, :, :, None], stack.shape[-1], axis=-1)
    return np.take_along_axis(ranked, index, axis=0)[0]


def build_plate(cur_rgb, cur_hole, neighbours):
    """Comble le trou de `cur_rgb` avec le fond réel des voisins déjà positionnés.

    cur_rgb    : uint8 RGB HxWx3 · cur_hole : bool HxW (True = à combler)
    neighbours : itérable de (rgb uint8, hole bool, matrice 2×3 voisin→courant). ITÉRÉE
                 PARESSEUSEMENT : dès que le trou est comblé, les voisins restants ne sont jamais
                 chargés.
    Renvoie (plaque uint8, comblé bool, couverture 0..1)."""
    nothing = np.zeros(cur_hole.shape, dtype=bool)
    if cv2 is None or not cur_hole.any():
        return cur_rgb, nothing, 0.0
    size = (cur_rgb.shape[1], cur_rgb.shape[0])
    target = float(cur_hole.sum())
    erode = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * VALID_ERODE + 1, 2 * VALID_ERODE + 1))

    layers, masks, covered = [], [], nothing
    for rgb, hole, matrix in neighbours:
        if matrix is None:
            continue
        warped = cv2.warpAffine(rgb, matrix, size, flags=cv2.INTER_LANCZOS4,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        background = cv2.warpAffine((~hole).astype(np.uint8) * 255, matrix, size,
                                    flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT,
                                    borderValue=0)
        usable = (cv2.erode(background, erode) > 127) & cur_hole
        if not usable.any():
            continue
        layers.append(warped.astype(np.float32))
        masks.append(usable)
        covered = covered | usable
        if float(covered.sum()) / target >= ENOUGH_COVERAGE:
            break

    if not layers:
        return cur_rgb, nothing, 0.0
    valid = np.stack(masks)
    count = valid.sum(axis=0).astype(np.int32)
    filled = count > 0
    plate = cur_rgb.copy()
    plate[filled] = _lower_median(np.stack(layers), valid, count)[filled].astype(np.uint8)
    return plate, filled, float(filled.sum()) / target


def neighbour_order(index, total, radius=DEFAULT_RADIUS, step=DEFAULT_STEP, limit=DEFAULT_LIMIT):
    """Indices voisins, du plus proche au plus lointain, alternés avant/après.

    Le plus proche d'abord : la chaîne de mouvements y est la plus courte donc la moins dérivée,
    et l'arrêt anticipé de `build_plate` évite de warper les lointains pour rien."""
    out = []
    for offset in range(step, radius + 1, step):
        for other in (index - offset, index + offset):
            if 0 <= other < total and len(out) < limit:
                out.append(other)
    return out


class CleanPlate:
    """Fabrique de plaques propres pour UNE séquence d'images extraites.

    `hole_of(nom, taille) -> bool HxW` est fourni par l'appelant, seul à connaître la dilatation
    appliquée au masque : le voisin doit être écarté avec la MÊME marge, sinon on rapatrierait le
    bord de l'objet. `crop` = rect ROI (x0, y0, x1, y1) ou None."""

    def __init__(self, frames_dir, names, hole_of, crop=None,
                 radius=DEFAULT_RADIUS, step=DEFAULT_STEP, limit=DEFAULT_LIMIT):
        self.frames_dir, self.names, self.hole_of, self.crop = frames_dir, names, hole_of, crop
        self.order = {"radius": radius, "step": step, "limit": limit}
        self.off = not available()
        self._frames, self._recent, self._links = {}, deque(), {}
        self._tries = self._wins = 0

    def _frame(self, index):
        """(rgb, hole) recadrés à la ROI, avec un petit cache : les voisins se recoupent beaucoup."""
        hit = self._frames.get(index)
        if hit is not None:
            return hit
        from PIL import Image
        path = os.path.join(self.frames_dir, self.names[index])
        if not os.path.isfile(path):
            return None, None
        image = Image.open(path).convert("RGB")
        hole = self.hole_of(self.names[index], image.size)
        if self.crop is not None:
            image = image.crop(self.crop)
            hole = hole[self.crop[1]:self.crop[3], self.crop[0]:self.crop[2]]
        entry = (np.asarray(image, dtype=np.uint8), hole)
        self._frames[index] = entry
        self._recent.append(index)
        while len(self._recent) > CACHE_FRAMES:
            self._frames.pop(self._recent.popleft(), None)
        return entry

    def _link(self, index):
        """Mouvement de l'image `index` vers `index + 1`, mémorisé (chaque maillon est estimé une fois)."""
        if index in self._links:
            return self._links[index]
        a, hole_a = self._frame(index)
        b, hole_b = self._frame(index + 1)
        link = None if a is None or b is None else global_motion(a, b, hole_a, hole_b)
        self._links[index] = link
        return link

    def _between(self, src, dst):
        """Matrice amenant les pixels de `src` dans la géométrie de `dst`, ou None si un maillon manque."""
        matrix = IDENTITY
        if dst > src:
            steps = range(src, dst)
        else:
            steps = range(src - 1, dst - 1, -1)
        for i in steps:
            link = self._link(i)
            if link is None:
                return None
            matrix = _compose(link if dst > src else cv2.invertAffineTransform(link), matrix)
        return matrix

    def _neighbours(self, index, cur_rgb, cur_hole):
        for other in neighbour_order(index, len(self.names), **self.order):
            matrix = self._between(other, index)
            if matrix is None:
                continue
            rgb, hole = self._frame(other)
            if rgb is None or rgb.shape != cur_rgb.shape or hole.shape != cur_hole.shape:
                continue
            yield rgb, hole, matrix

    def for_frame(self, index, cur_rgb, cur_hole):
        """(plaque, comblé, couverture) pour l'image `index`, déjà recadrée à la ROI par l'appelant."""
        if self.off or not cur_hole.any():
            return cur_rgb, np.zeros(cur_hole.shape, dtype=bool), 0.0
        plate, filled, coverage = build_plate(cur_rgb, cur_hole,
                                              self._neighbours(index, cur_rgb, cur_hole))
        self._tries += 1
        if coverage >= MIN_USEFUL_COVERAGE:
            self._wins += 1
        elif self._wins == 0 and self._tries >= PROBE_FRAMES:
            self.off = True   # fond jamais révélé sur ce plan : on arrête de payer le suivi
        return plate, filled, coverage
