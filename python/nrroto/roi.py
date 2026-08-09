"""ROI globale des mattes (réimplémenté) : bbox union de toutes les mattes propagées
+10 % de marge, snappée sur un multiple de 8 — les moteurs lourds (MatAnyone, MiniMax) ne traitent
que la zone utile au lieu du cadre entier, la sortie est ré-expansée plein cadre. Skip (None) si la
ROI couvre >= 90 % de l'image (aucun gain)."""
import os

import numpy as np
from PIL import Image


def compute_roi(union_dir, w, h, margin=0.10, snap=8, skip_ratio=0.90, pad=0):
    """Bbox (x0, y0, x1, y1) englobant tous les pixels masqués de union/*.png, ou None.

    `pad` = marge MINIMALE en pixels, en plus de `margin` (relative). Les moteurs de suppression
    la fixent à la dilatation du masque : sur un petit objet, 10 % du trou vaut moins que la marge
    d'effacement, et la ROI ne contiendrait ni le masque dilaté ni la couronne de référence du
    raccord — le raccord n'aurait alors rien à mesurer."""
    x0, y0, x1, y1 = w, h, 0, 0
    found = False
    try:
        names = [n for n in os.listdir(union_dir) if n.endswith(".png")]
    except OSError:
        return None
    for n in names:
        m = np.array(Image.open(os.path.join(union_dir, n)).convert("L")) > 127
        ys, xs = np.nonzero(m)
        if not len(xs):
            continue
        found = True
        x0 = min(x0, int(xs.min())); x1 = max(x1, int(xs.max()) + 1)
        y0 = min(y0, int(ys.min())); y1 = max(y1, int(ys.max()) + 1)
    if not found:
        return None
    mx = int((x1 - x0) * margin) + int(pad); my = int((y1 - y0) * margin) + int(pad)
    x0 = max(0, x0 - mx); y0 = max(0, y0 - my)
    x1 = min(w, x1 + mx); y1 = min(h, y1 + my)
    # Snap : origine vers le bas, taille vers le haut (multiples de `snap`), borné à l'image.
    x0 = (x0 // snap) * snap; y0 = (y0 // snap) * snap
    x1 = min(w, ((x1 + snap - 1) // snap) * snap); y1 = min(h, ((y1 + snap - 1) // snap) * snap)
    if (x1 - x0) * (y1 - y0) >= skip_ratio * w * h:
        return None
    return (x0, y0, x1, y1)


def crop_image(img, roi):
    """PIL.Image → recadrée à la ROI (no-op si None)."""
    return img if roi is None else img.crop(roi)


def crop_array(arr, roi):
    """Tableau numpy HxW[xC] → recadré à la ROI (no-op si None) — masques et images de travail."""
    return arr if roi is None else arr[roi[1]:roi[3], roi[0]:roi[2]]


def crop_dir(src_dir, dst_dir, roi, names=None):
    """Recadre toutes les images de src_dir vers dst_dir (mêmes noms)."""
    os.makedirs(dst_dir, exist_ok=True)
    for n in (names or sorted(os.listdir(src_dir))):
        p = os.path.join(src_dir, n)
        if not os.path.isfile(p):
            continue
        Image.open(p).crop(roi).save(os.path.join(dst_dir, n))
    return dst_dir


def paste_into(full_img, patch, roi):
    """Recolle un patch traité dans l'image plein cadre (retourne une copie)."""
    out = full_img.copy()
    out.paste(patch, (roi[0], roi[1]))
    return out
