"""Post-traitement NON destructif des masques roto (réimplémenté) : boucher les
trous, retirer les poussières, correction de bord d'image (border), dilater/éroder, lisser le
contour (smooth), adoucir le bord (feather), gamma d'alpha. Appliqué à la volée sur l'overlay ET
« cuit » dans les mattes à l'export — les PNG propagés ne sont JAMAIS modifiés.

Entrée = masque bool HxW ; sortie = uint8 0..255 (soft si feather>0/gamma≠1, sinon binaire 0/255).
cv2 (opencv-contrib-headless, déjà au venv) ; repli PIL/numpy si absent (venv dégradé)."""
import numpy as np

try:
    import cv2
except Exception:  # noqa: BLE001 — venv sans opencv : repli PIL
    cv2 = None


def default_post():
    return {"grow": 0, "feather": 0, "holes": 0, "dots": 0, "border": 0, "smooth": 0, "gamma": 1.0}


def is_default(post):
    p = post or {}
    return not (int(p.get("grow") or 0) or int(p.get("feather") or 0)
                or int(p.get("holes") or 0) or int(p.get("dots") or 0)
                or int(p.get("border") or 0) or int(p.get("smooth") or 0)
                or abs(float(p.get("gamma") or 1.0) - 1.0) > 1e-3)


def _fill_holes(m, max_area):
    """Bouche les trous intérieurs d'aire <= max_area px² (les zones non atteignables du fond)."""
    if cv2 is not None:
        inv = (~m).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
        h, w = m.shape
        out = m.copy()
        for i in range(1, n):
            x, y, bw, bh, area = stats[i]
            touches_border = x == 0 or y == 0 or x + bw >= w or y + bh >= h
            if not touches_border and area <= max_area:
                out[labels == i] = True
        return out
    # Repli sans cv2 : flood fill du fond depuis les bords (scipy absent → BFS numpy simple).
    from PIL import Image, ImageDraw
    im = Image.fromarray((~m).astype(np.uint8) * 255, "L")
    ImageDraw.floodfill(im, (0, 0), 128)
    outside = np.array(im) == 128
    holes = (~m) & (~outside)
    return m | holes


def _remove_dots(m, max_area):
    """Retire les composantes isolées d'aire <= max_area px² (poussières de segmentation)."""
    if cv2 is None:
        return m
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=4)
    out = m.copy()
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] <= max_area:
            out[labels == i] = False
    return out


def _grow(m, px):
    """Dilate (px>0) ou érode (px<0) le masque."""
    k = abs(int(px))
    if not k:
        return m
    if cv2 is not None:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
        fn = cv2.dilate if px > 0 else cv2.erode
        return fn(m.astype(np.uint8), kernel).astype(bool)
    from PIL import Image, ImageFilter
    size = 2 * k + 1
    im = Image.fromarray(m.astype(np.uint8) * 255, "L")
    flt = ImageFilter.MaxFilter(size) if px > 0 else ImageFilter.MinFilter(size)
    return np.array(im.filter(flt)) > 127


def _border_fix(m, px):
    """Corrige les bavures de bord d'IMAGE : les `px` premières lignes/colonnes du cadre sont peu
    fiables (vignettage, bruit d'encodage) → on y réplique la valeur du masque à `px` du bord."""
    k = int(px)
    if k <= 0 or m.shape[0] <= 2 * k or m.shape[1] <= 2 * k:
        return m
    out = m.copy()
    out[:k, :] = out[k:k + 1, :]
    out[-k:, :] = out[-k - 1:-k, :]
    out[:, :k] = out[:, k:k + 1]
    out[:, -k:] = out[:, -k - 1:-k]
    return out


def _smooth(m, px):
    """Lisse le CONTOUR du masque binaire (anti-crénelage géométrique) : blur gaussien puis
    re-seuillage — les marches d'escalier de la segmentation s'arrondissent, le masque reste net."""
    k = int(px)
    if k <= 0:
        return m
    size = 2 * k + 1
    if cv2 is not None:
        blur = cv2.GaussianBlur(m.astype(np.uint8) * 255, (size, size), 0)
        return blur > 127
    from PIL import Image, ImageFilter
    im = Image.fromarray(m.astype(np.uint8) * 255, "L").filter(ImageFilter.GaussianBlur(radius=float(k)))
    return np.array(im) > 127


def _gamma(u8, g):
    """Gamma sur l'alpha (g>1 densifie la matte, g<1 l'allège) — LUT 256 entrées."""
    g = float(g)
    if abs(g - 1.0) <= 1e-3:
        return u8
    lut = (np.power(np.arange(256, dtype=np.float32) / 255.0, 1.0 / max(0.01, g)) * 255.0).astype(np.uint8)
    return lut[u8]


def _feather(u8, px):
    """Adoucit le bord : blur gaussien du masque binaire → alpha progressif."""
    if px <= 0:
        return u8
    if cv2 is not None:
        k = int(px) * 2 + 1
        return cv2.GaussianBlur(u8, (k, k), 0)
    from PIL import Image, ImageFilter
    im = Image.fromarray(u8, "L").filter(ImageFilter.GaussianBlur(radius=float(px)))
    return np.array(im)


def _grow_alpha(u8, px):
    """Dilate (px>0) ou érode (px<0) un ALPHA en niveaux de gris.

    Généralisation exacte du cas binaire : la dilatation morphologique est un filtre max, l'érosion
    un filtre min — appliqués au gris ils déplacent le bord SANS écraser le dégradé, là où seuiller
    pour réutiliser `_grow` rendrait le contour dur."""
    k = abs(int(px))
    if not k:
        return u8
    if cv2 is not None:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
        fn = cv2.dilate if px > 0 else cv2.erode
        return fn(u8, kernel)
    from PIL import Image, ImageFilter
    size = 2 * k + 1
    flt = ImageFilter.MaxFilter(size) if px > 0 else ImageFilter.MinFilter(size)
    return np.array(Image.fromarray(u8, "L").filter(flt))


def _smooth_alpha(u8, px):
    """Lisse le CONTOUR d'un alpha doux : ouverture puis fermeture morphologiques.

    Le lissage binaire (flou puis re-seuillage) ne s'applique pas ici — le re-seuillage détruirait
    le dégradé. Ouvrir puis fermer arrondit les excroissances et comble les échancrures en laissant
    la transition intacte, alors qu'un simple flou l'élargirait (c'est le rôle de `feather`)."""
    k = int(px)
    if k <= 0:
        return u8
    size = 2 * k + 1
    if cv2 is not None:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
        return cv2.morphologyEx(cv2.morphologyEx(u8, cv2.MORPH_OPEN, kernel), cv2.MORPH_CLOSE, kernel)
    from PIL import Image, ImageFilter
    im = Image.fromarray(u8, "L").filter(ImageFilter.MinFilter(size)).filter(ImageFilter.MaxFilter(size))
    return np.array(im.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size)))


def apply_post_alpha(alpha, post):
    """Jumeau DOUX de `apply_post` : alpha uint8 0..255 en entrée ET en sortie.

    Le matte fin (cf. nrroto.matte) produit un alpha en niveaux de gris ; le faire passer par
    `apply_post` le seuillerait à `> 127` et effacerait précisément ce que le modèle a calculé.
    Chaque réglage garde donc son sens, transposé au gris : trous et poussières se DÉCIDENT sur la
    silhouette (`> 127`) mais s'ÉCRIVENT dans l'alpha, grow/smooth deviennent morphologiques sur le
    gris, feather et gamma sont déjà des opérations d'alpha et ne changent pas."""
    p = post or {}
    u8 = np.ascontiguousarray(alpha, dtype=np.uint8)
    holes = int(p.get("holes") or 0)
    dots = int(p.get("dots") or 0)
    border = int(p.get("border") or 0)
    grow = int(p.get("grow") or 0)
    smooth = int(p.get("smooth") or 0)
    feather = int(p.get("feather") or 0)
    gamma = float(p.get("gamma") or 1.0)
    if holes > 0:
        solid = u8 > 127
        u8 = np.where(_fill_holes(solid, holes * holes) & ~solid, np.uint8(255), u8)
    if dots > 0:
        solid = u8 > 127
        u8 = np.where(solid & ~_remove_dots(solid, dots * dots), np.uint8(0), u8)
    if border > 0:
        u8 = _border_fix(u8, border)
    if grow:
        u8 = _grow_alpha(u8, grow)
    if smooth > 0:
        u8 = _smooth_alpha(u8, smooth)
    return _gamma(_feather(u8, feather), gamma)


def apply_post(mask, post):
    """masque bool HxW + réglages {holes, dots, border, grow, smooth, feather, gamma} → uint8 0..255.
    Ordre : opérations binaires (trous → poussières → bord → grow → lissage) puis alpha (feather → gamma)."""
    p = post or {}
    m = mask.astype(bool)
    holes = int(p.get("holes") or 0)
    dots = int(p.get("dots") or 0)
    border = int(p.get("border") or 0)
    grow = int(p.get("grow") or 0)
    smooth = int(p.get("smooth") or 0)
    feather = int(p.get("feather") or 0)
    gamma = float(p.get("gamma") or 1.0)
    if holes > 0:
        m = _fill_holes(m, holes * holes)
    if dots > 0:
        m = _remove_dots(m, dots * dots)
    if border > 0:
        m = _border_fix(m, border)
    if grow:
        m = _grow(m, grow)
    if smooth > 0:
        m = _smooth(m, smooth)
    u8 = m.astype(np.uint8) * 255
    return _gamma(_feather(u8, feather), gamma)
