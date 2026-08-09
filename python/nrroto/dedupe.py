"""Déduplication de mattes pour l'ANIMATION (réimplémentation propre) : les tenues
d'animation (frames quasi identiques) reçoivent des mattes légèrement différentes à chaque frame →
tremblement du contour. On détecte les groupes de frames consécutives visuellement identiques
(features ORB comparées DANS la zone masquée, le fond est ignoré) et on copie la matte de la
première frame du groupe sur tout le groupe.

Sécurité : sauvegarde des mattes dans mattes_backup/ avant la première dédup ; relancer la dédup
repart TOUJOURS de la sauvegarde (idempotent) ; `restore` remet l'original."""
import json
import os
import shutil

import numpy as np


FRAME_MANIFEST_VERSION = 1
FRAME_DEDUPE_THR = 0.002


def frame_manifest_path(work):
    return os.path.join(work, "frame_dedupe_manifest.json")


def unique_frames_dir(work):
    return os.path.join(work, "frames_unique")


def _load_rgb(path):
    from PIL import Image
    return np.array(Image.open(path).convert("RGB"))


def _same_source_frame(a, b, threshold=FRAME_DEDUPE_THR):
    """Comparaison conservatrice des JPEG extraits, contre l'ancre du groupe (pas en chaîne)."""
    if a.shape != b.shape:
        return False
    diff = np.abs(a.astype(np.int16) - b.astype(np.int16))
    # La moyenne seule dilue un petit mouvement local. Le plafond pixel rend la compaction sûre :
    # une zone réellement modifiée ne peut pas disparaître entre les échantillons.
    return int(diff.max()) <= 2 and (float(diff.mean()) / 255.0) < float(threshold)


def build_frame_manifest(work, frames_dir, threshold=FRAME_DEDUPE_THR):
    """Détecte les doublons source AVANT SAM et bâtit une séquence compacte contiguë.

    Les JPEG originaux restent la sauvegarde et la source de l'UI/export. Le manifeste conserve les
    deux sens du mapping ; ``frames_unique`` ne contient que les ancres, renumérotées pour SAM2.
    """
    names = sorted(n for n in os.listdir(frames_dir) if n.lower().endswith(".jpg"))
    sources = [int(os.path.splitext(n)[0]) for n in names]
    if not sources:
        raise RuntimeError("aucune frame à dédupliquer")
    mapping = []
    unique_sources = []
    anchor_img = None
    previous = None
    for original in sources:
        cur = _load_rgb(os.path.join(frames_dir, "%05d.jpg" % original))
        contiguous = previous is None or original == previous + 1
        if anchor_img is None or not contiguous or not _same_source_frame(anchor_img, cur, threshold):
            unique_sources.append(original)
            anchor_img = cur
        mapping.append(len(unique_sources) - 1)
        previous = original

    target = unique_frames_dir(work)
    tmp = target + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    for unique, original in enumerate(unique_sources):
        src = os.path.join(frames_dir, "%05d.jpg" % original)
        dst = os.path.join(tmp, "%05d.jpg" % unique)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
    shutil.rmtree(target, ignore_errors=True)
    os.replace(tmp, target)

    reverse = [[] for _ in unique_sources]
    for original, unique in zip(sources, mapping):
        reverse[unique].append(original)
    manifest = {
        "version": FRAME_MANIFEST_VERSION,
        "threshold": float(threshold),
        "originalCount": len(sources),
        "uniqueCount": len(unique_sources),
        "originalToUnique": mapping,
        "uniqueToOriginal": reverse,
        "uniqueSources": unique_sources,
    }
    tmp_manifest = frame_manifest_path(work) + ".tmp"
    with open(tmp_manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    os.replace(tmp_manifest, frame_manifest_path(work))
    return manifest


def load_frame_manifest(work, frames_dir=None):
    """Charge un manifeste complet/compatible, sinon le reconstruit depuis les originaux."""
    try:
        with open(frame_manifest_path(work), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        count = int(data.get("originalCount") or 0)
        mapping = [int(v) for v in data.get("originalToUnique", [])]
        reverse = [[int(v) for v in group] for group in data.get("uniqueToOriginal", [])]
        valid = (data.get("version") == FRAME_MANIFEST_VERSION and count > 0 and
                 len(mapping) == count and reverse and os.path.isdir(unique_frames_dir(work)) and
                 len([n for n in os.listdir(unique_frames_dir(work)) if n.endswith(".jpg")]) == len(reverse))
        if valid:
            data["originalToUnique"], data["uniqueToOriginal"] = mapping, reverse
            return data
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    if frames_dir is None:
        return None
    return build_frame_manifest(work, frames_dir)


def expand_unique_mattes(unique_root, mattes_root, unique_frame, originals):
    """Reconstruit les mattes de tous les index originaux associés à une sortie SAM unique."""
    written = 0
    if not os.path.isdir(unique_root):
        return written
    for name in os.listdir(unique_root):
        src_dir = os.path.join(unique_root, name)
        if not os.path.isdir(src_dir) or not (name == "union" or name.startswith("obj-")):
            continue
        src = os.path.join(src_dir, "%05d.png" % int(unique_frame))
        if not os.path.isfile(src):
            continue
        dst_dir = os.path.join(mattes_root, name)
        os.makedirs(dst_dir, exist_ok=True)
        for original in originals:
            shutil.copy2(src, os.path.join(dst_dir, "%05d.png" % int(original)))
            written += 1
    return written


def _list_frames(union_dir):
    try:
        return sorted(int(os.path.splitext(n)[0]) for n in os.listdir(union_dir) if n.endswith(".png"))
    except OSError:
        return []


def _masked_gray(frames_dir, union_dir, frame):
    """Frame en niveaux de gris, fond mis à zéro par la matte union dilatée (on ne compare que
    l'objet — un fond qui bouge ne casse pas la détection de tenue)."""
    from PIL import Image
    fp = os.path.join(frames_dir, "%05d.jpg" % frame)
    mp = os.path.join(union_dir, "%05d.png" % frame)
    if not (os.path.isfile(fp) and os.path.isfile(mp)):
        return None
    g = np.array(Image.open(fp).convert("L"))
    m = np.array(Image.open(mp).convert("L").resize((g.shape[1], g.shape[0]))) > 127
    try:
        import cv2
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        m = cv2.dilate(m.astype(np.uint8), k).astype(bool)
    except Exception:  # noqa: BLE001
        pass
    out = g.copy()
    out[~m] = 0
    return out


def _similarity(a, b):
    """Score 0..1 de similarité ORB entre deux images grises (ratio de bonnes correspondances)."""
    try:
        import cv2
    except Exception:  # noqa: BLE001
        return 0.0
    orb = cv2.ORB_create(nfeatures=500)
    ka, da = orb.detectAndCompute(a, None)
    kb, db = orb.detectAndCompute(b, None)
    if da is None or db is None or not len(ka) or not len(kb):
        # Aucune feature (aplat uni) : comparaison directe des pixels masqués.
        diff = np.abs(a.astype(np.int16) - b.astype(np.int16))
        return 1.0 if float(diff.mean()) < 2.0 else 0.0
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(da, db)
    good = [m for m in matches if m.distance < 40]
    return len(good) / float(max(len(ka), len(kb)))


def _copy_group_mattes(mattes_root, src_frame, dst_frames):
    """Copie TOUTES les mattes (obj-* + union) de src_frame vers chaque frame du groupe."""
    n = 0
    for d in os.listdir(mattes_root):
        sub = os.path.join(mattes_root, d)
        if not os.path.isdir(sub) or not (d.startswith("obj-") or d == "union"):
            continue
        src = os.path.join(sub, "%05d.png" % src_frame)
        if not os.path.isfile(src):
            continue
        for f in dst_frames:
            shutil.copy2(src, os.path.join(sub, "%05d.png" % f))
            n += 1
    return n


def backup_dir(work):
    return os.path.join(work, "mattes_backup")


def manifest_path(work):
    return os.path.join(work, "dedupe_manifest.json")


def restore(work):
    """Remet les mattes d'origine depuis la sauvegarde (annule la dédup)."""
    bak, mattes = backup_dir(work), os.path.join(work, "mattes")
    if not os.path.isdir(bak):
        return False
    shutil.rmtree(mattes, ignore_errors=True)
    shutil.copytree(bak, mattes)
    try:
        os.remove(manifest_path(work))
    except OSError:
        pass
    return True


def run(work, frames_dir, threshold=0.8, progress=None):
    """Dédoublonne les mattes de `work/mattes`. Retourne (groupes, frames modifiées)."""
    mattes = os.path.join(work, "mattes")
    union = os.path.join(mattes, "union")
    frames = _list_frames(union)
    if len(frames) < 2:
        return 0, 0
    bak = backup_dir(work)
    if os.path.isdir(bak):
        restore(work)          # idempotent : repartir des mattes d'origine
    else:
        shutil.copytree(mattes, bak)
    groups, changed = 0, 0
    manifest = {"version": 1, "threshold": float(threshold), "groups": [], "map": {}}
    anchor = frames[0]
    anchor_img = _masked_gray(frames_dir, union, anchor)
    pending = []
    total = len(frames) - 1
    for i, f in enumerate(frames[1:]):
        cur_img = _masked_gray(frames_dir, union, f)
        contiguous = f == (anchor if not pending else pending[-1]) + 1
        same = contiguous and anchor_img is not None and cur_img is not None and _similarity(anchor_img, cur_img) >= threshold
        if same:
            pending.append(f)
            manifest["map"][str(f)] = anchor
        else:
            if pending:
                groups += 1
                changed += len(pending)
                _copy_group_mattes(mattes, anchor, pending)
                manifest["groups"].append({"source": anchor, "duplicates": pending[:]})
            anchor, pending = f, []
            anchor_img = cur_img
        if progress:
            progress(i + 1, total)
    if pending:
        groups += 1
        changed += len(pending)
        _copy_group_mattes(mattes, anchor, pending)
        manifest["groups"].append({"source": anchor, "duplicates": pending[:]})
    try:
        with open(manifest_path(work), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return groups, changed
