"""Rendu des masques Roto : overlay composite teinté (data-URI PNG pour l'UI), modes d'affichage
(edit / matte / alpha / fond couleur, avec contours optionnels) + mattes N&B sur disque (par objet
+ union) écrites au fil de la propagation, relues pour le scrub et l'export."""
import base64
import io
import os

# Palette par id d'objet (1..n) — MIROIR de ROTO_COLORS dans src/components/netsulab/roto/rotoShared.ts.
PALETTE = [(34, 197, 94), (59, 130, 246), (249, 115, 22), (225, 29, 72), (168, 85, 247), (234, 179, 8)]


def color_of(obj):
    return PALETTE[(int(obj) - 1) % len(PALETTE)]


def _png_uri(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _post_u8(m, post):
    """Masque → alpha uint8 post-traité.

    Deux natures de masque circulent : le bool de la segmentation et l'alpha uint8 du matte fin
    (cf. nrroto.matte). Le second passe par le jumeau DOUX du post-traitement — l'envoyer dans
    `apply_post` le seuillerait à `> 127`, donc rendrait le dégradé exactement là où on l'affiche."""
    import numpy as np
    from nrroto import postproc
    soft = m.dtype != np.bool_
    if post is not None and not postproc.is_default(post):
        return postproc.apply_post_alpha(m, post) if soft else postproc.apply_post(m, post)
    return np.ascontiguousarray(m, dtype=np.uint8) if soft else m.astype(np.uint8) * 255


def _outline_of(m, thickness=2):
    """Contour du masque (gradient morphologique) — bool HxW. Repli PIL si cv2 absent."""
    import numpy as np
    try:
        import cv2
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * thickness + 1, 2 * thickness + 1))
        return cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_GRADIENT, k).astype(bool)
    except Exception:  # noqa: BLE001
        from PIL import Image, ImageFilter
        im = Image.fromarray(m.astype(np.uint8) * 255, "L")
        size = 2 * thickness + 1
        dil = np.array(im.filter(ImageFilter.MaxFilter(size))) > 127
        ero = np.array(im.filter(ImageFilter.MinFilter(size))) > 127
        return dil & ~ero


def _overlay_rgba(masks, post=None, outline=False):
    """{obj: masque HxW} -> RGBA teinté (chaque objet sa couleur, alpha ~55 %, contour opaque
    optionnel), None sans masque. `post` = post-traitement appliqué au rendu seulement."""
    if not masks:
        return None
    import numpy as np

    h, w = next(iter(masks.values())).shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for obj, m in sorted(masks.items()):
        r, g, b = color_of(obj)
        u8 = _post_u8(m, post)
        a = (u8.astype(np.uint16) * 140 // 255).astype(np.uint8)
        sel = a > 0
        rgba[sel, 0], rgba[sel, 1], rgba[sel, 2] = r, g, b
        rgba[sel, 3] = a[sel]
        if outline:
            edge = _outline_of(u8 > 127)
            rgba[edge, 0], rgba[edge, 1], rgba[edge, 2], rgba[edge, 3] = r, g, b, 255
    return rgba


def overlay_data_uri(masks, post=None, outline=False):
    """Overlay teinté en data-URI PNG RGBA, posé PAR-DESSUS la frame côté client. L'opacité globale
    est réglée là-bas (CSS) — l'alpha calculé ici est la base."""
    from PIL import Image
    rgba = _overlay_rgba(masks, post, outline=outline)
    return None if rgba is None else _png_uri(Image.fromarray(rgba, "RGBA"))


def _hex_rgb(s, default=(0, 255, 0)):
    try:
        s = (s or "").lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except (ValueError, IndexError):
        return default


def render_view(frame_path, masks, post=None, mode="edit", outline=False, bg="#00ff00"):
    """Rendu d'une frame selon le mode d'affichage :
    - edit    : overlay transparent teinté (posé PAR-DESSUS la frame côté client)
    - matte   : matte N&B pleine image (union des objets, post appliqué)
    - alpha   : frame RGBA découpée par la matte (le client affiche un damier dessous)
    - bgcolor : frame composée sur une couleur unie
    Les modes pleine image REMPLACENT la frame côté client."""
    if mode == "edit" or not mode:
        return overlay_data_uri(masks, post, outline=outline)
    import numpy as np
    from PIL import Image
    if not masks:
        return None
    h, w = next(iter(masks.values())).shape
    alpha = np.zeros((h, w), dtype=np.uint8)
    for m in masks.values():
        alpha = np.maximum(alpha, _post_u8(m, post))
    if mode == "matte":
        img = Image.fromarray(alpha, "L")
    else:
        frame = np.array(Image.open(frame_path).convert("RGB").resize((w, h)))
        if mode == "alpha":
            img = Image.fromarray(np.dstack([frame, alpha]), "RGBA")
        else:  # bgcolor
            bgc = np.array(_hex_rgb(bg), dtype=np.float32)
            a = (alpha.astype(np.float32) / 255.0)[..., None]
            comp = (frame.astype(np.float32) * a + bgc * (1.0 - a)).astype(np.uint8)
            img = Image.fromarray(comp, "RGB")
    if outline and mode != "matte":
        rgba = np.array(img.convert("RGBA"))
        for obj, m in sorted(masks.items()):
            r, g, b = color_of(obj)
            edge = _outline_of(_post_u8(m, post) > 127)
            rgba[edge, 0], rgba[edge, 1], rgba[edge, 2], rgba[edge, 3] = r, g, b, 255
        img = Image.fromarray(rgba, "RGBA")
    return _png_uri(img)


def render_view_flat(frame_path, masks, post=None, mode="edit", outline=False, bg="#00ff00"):
    """Rendu d'une frame en UNE image autonome — aperçus de test, comparateur avant/après.

    Identique à `render_view` sauf en mode `edit`, dont l'overlay teinté est ici APLATI sur la
    frame : un comparateur affiche une seule image, il n'a aucun calque en dessous où poser un
    RGBA transparent."""
    if mode and mode != "edit":
        return render_view(frame_path, masks, post, mode=mode, outline=outline, bg=bg)
    import numpy as np
    from PIL import Image
    rgba = _overlay_rgba(masks, post, outline=outline)
    if rgba is None:
        return None
    h, w = rgba.shape[:2]
    frame = np.array(Image.open(frame_path).convert("RGB").resize((w, h)), dtype=np.float32)
    a = (rgba[..., 3].astype(np.float32) / 255.0)[..., None]
    comp = (rgba[..., :3].astype(np.float32) * a + frame * (1.0 - a)).astype(np.uint8)
    return _png_uri(Image.fromarray(comp, "RGB"))


def matte_paths(root, frame):
    """Chemins des mattes d'une frame : {obj: path} d'après les dossiers obj-* présents."""
    out = {}
    try:
        for d in os.listdir(root):
            if d.startswith("obj-"):
                p = os.path.join(root, d, "%05d.png" % frame)
                if os.path.isfile(p):
                    out[int(d[4:])] = p
    except OSError:
        pass
    return out


def save_mattes(root, frame, masks):
    """Écrit les mattes d'une frame : obj-<id>/%05d.png (0/255) + union/%05d.png."""
    import numpy as np
    from PIL import Image
    union = None
    for obj, m in masks.items():
        d = os.path.join(root, "obj-%d" % int(obj))
        os.makedirs(d, exist_ok=True)
        Image.fromarray((m.astype(np.uint8)) * 255, "L").save(os.path.join(d, "%05d.png" % frame))
        union = m if union is None else (union | m)
    if union is not None:
        d = os.path.join(root, "union")
        os.makedirs(d, exist_ok=True)
        Image.fromarray((union.astype(np.uint8)) * 255, "L").save(os.path.join(d, "%05d.png" % frame))


def load_mattes(root, frame):
    """Relit les mattes d'une frame en {obj: masque bool} (scrub après propagation)."""
    import numpy as np
    from PIL import Image
    out = {}
    for obj, p in matte_paths(root, frame).items():
        out[obj] = np.array(Image.open(p).convert("L")) > 127
    return out


def load_alpha(root, frame):
    """Relit les mattes d'une frame en {obj: alpha uint8}, SANS seuiller.

    Jumeau de `load_mattes` pour le matte fin : ses PNG portent un dégradé, et `> 127` le
    remplacerait par un contour dur — c'est ce seuillage, présent partout dans la chaîne, qui
    rendait le modèle d'affinage inopérant même quand son résultat était juste."""
    import numpy as np
    from PIL import Image
    out = {}
    for obj, p in matte_paths(root, frame).items():
        out[obj] = np.array(Image.open(p).convert("L"), dtype=np.uint8)
    return out
