"""Recherche par visage (animé + réel) — vrais modèles d'identité par domaine.

Animé : imgutils (détection YOLO anime) + CCIP (identité personnage). Réel : YuNet
(détection) + SFace (identité). Chaque visage détecté sur la frame du milieu d'un plan
devient une ligne de face_embeddings_v2 (domain + engine + bbox + feature brute).
La recherche embed les visages de référence par domaine puis score chaque ligne du
domaine (max sur les réfs), scores CALIBRÉS 0..1 (0.5 = seuil officiel du moteur)
→ même échelle que la recherche normale. Voir faceengines.py pour les moteurs."""
import base64
import json
import sys
import time

import numpy as np
from nri18n import t

from detect import file_mtime

from . import media
from .catalog import path_chunks
from .db import db_emb
from .faceengines import engines


def _thumb_uri(pil):
    tb = media.thumb_bytes(pil)
    return ("data:image/jpeg;base64," + base64.b64encode(tb).decode()) if tb else None


def _iou(a, b):
    """Intersection-sur-union de deux bbox xywh (0..1)."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ua = aw * ah + bw * bh - inter
    return inter / ua if ua > 0 else 0.0


def _detect_all(pil):
    """{domain: [(bbox xywh, conf), ...]} sur les moteurs disponibles, AVEC arbitrage
    inter-domaine : un même visage capté par PLUSIEURS moteurs (bbox qui se recouvrent)
    est attribué à l'ANIMÉ. YuNet (moteur « réel ») fait des faux positifs sur les
    visages dessinés (proportions humaines), alors que le moteur animé (YOLO anime + CCIP)
    ne se déclenche quasi jamais sur un vrai visage humain. Sans arbitrage, un visage
    animé était indexé DEUX fois et souvent affiché « Réel ». On garde donc les visages
    « réel » seulement s'ils ne recouvrent AUCUNE détection animé de la même frame."""
    out = {}
    for domain, eng in engines().items():
        try:
            found = eng.detect(pil)
        except Exception:  # noqa: BLE001
            found = []
        if found:
            out[domain] = found
    if "anime" in out and "real" in out:
        anime_boxes = [b for b, _ in out["anime"]]
        kept = [(b, c) for (b, c) in out["real"]
                if not any(_iou(b, ab) >= 0.3 for ab in anime_boxes)]
        if kept:
            out["real"] = kept
        else:
            out.pop("real", None)
    return out


def _purge_misdomained(con, path=None):
    """Supprime rétroactivement les lignes « réel » qui recouvrent une détection animé du MÊME plan
    (IoU ≥ 0.3) — doublons indexés AVANT l'arbitrage inter-domaine de _detect_all (un visage animé
    compté deux fois, affiché « Réel »). Même règle, appliquée au cache existant. `path=None` =
    toute la base (appelé à l'ouverture de la galerie), sinon un seul clip (chemin cache d'index)."""
    q = "SELECT rowid, file_path, domain, scene_index, face_index, bbox FROM face_embeddings_v2"
    args = ()
    if path is not None:
        q += " WHERE file_path=?"; args = (path,)
    by_scene = {}
    for rid, fp, dom, si, fi, bj in con.execute(q, args):
        try:
            bbox = tuple(float(v) for v in json.loads(bj))
        except Exception:  # noqa: BLE001
            continue
        by_scene.setdefault((fp, si), {}).setdefault(dom, []).append((rid, fi, bbox))
    dead = []
    for (fp, si), doms in by_scene.items():
        if "anime" not in doms or "real" not in doms:
            continue
        ab = [b for _r, _f, b in doms["anime"]]
        dead += [(rid, fp, si, fi) for rid, fi, b in doms["real"]
                 if any(_iou(b, a) >= 0.3 for a in ab)]
    for rid, fp, si, fi in dead:
        con.execute("DELETE FROM face_embeddings_v2 WHERE rowid=?", (rid,))
        con.execute("DELETE FROM face_labels_v1 WHERE file_path=? AND scene_index=? AND face_index=? "
                    "AND domain='real'", (fp, si, fi))
    if dead:
        con.commit()
    return len(dead)


_THUMB_MIN = 300   # côté long sous lequel une vignette stockée est jugée floue (crop de frame 720)


def _refresh_small_thumbs(con, path, engs):
    """Régénère les vignettes FLOUES d'un clip déjà indexé, sans ré-embedder : re-décode la frame
    du plan en haute résolution et re-découpe depuis le bbox stocké (coords frame 720, mis à
    l'échelle). Appelé sur le chemin « cache » de l'indexation → les index existants se réparent
    tout seuls au prochain passage. Saute les vignettes déjà proches du maximum atteignable
    (petit visage : re-décoder ne rendrait rien de plus net)."""
    import io

    from PIL import Image
    rows = con.execute(
        "SELECT rowid, domain, scene_index, start_sec, end_sec, bbox, thumb FROM face_embeddings_v2 "
        "WHERE file_path=?", (path,)).fetchall()
    todo = {}
    for rid, dom, si, s0, s1, bj, tb in rows:
        if dom not in engs:
            continue
        try:
            bbox = [float(v) for v in json.loads(bj)]
        except Exception:  # noqa: BLE001
            continue
        cur = 0
        if tb:
            try:
                cur = max(Image.open(io.BytesIO(tb)).size)
            except Exception:  # noqa: BLE001
                cur = 0
        if cur >= _THUMB_MIN:
            continue
        # meilleur côté long atteignable en re-croppant à 1600 (cap thumb_bytes = 320)
        reachable = min(320.0, max(bbox[2], bbox[3]) * (1 + 2 * engs[dom].margin) * (1600.0 / 720.0))
        if cur >= reachable * 0.9:
            continue
        todo.setdefault(si, []).append((rid, dom, s0, s1, bbox))
    if not todo:
        return 0
    done = 0
    total = len(todo)
    for k, (si, items) in enumerate(todo.items()):
        sys.stderr.write("STAGE:prog:%d/%d\n" % (k + 1, total)); sys.stderr.flush()
        s0 = float(items[0][2] or 0); s1 = float(items[0][3] or 0)
        hi = media.grab_ffmpeg(path, (s0 + s1) / 2.0, max_edge=1600)
        if hi is None:
            continue
        scale = max(hi.size) / 720.0
        if scale <= 1.05:
            break   # source ≤720p : aucun gain possible sur ce fichier
        for rid, dom, _a, _b, bbox in items:
            hb = tuple(int(round(v * scale)) for v in bbox)
            con.execute("UPDATE face_embeddings_v2 SET thumb=? WHERE rowid=?",
                        (media.thumb_bytes(engs[dom].crop(hi, hb)), rid))
            done += 1
    con.commit()
    return done


def cmd_face_index(path, force=False, cut_model=None, detect_options=None):
    """Indexe les visages d'un clip : pour chaque plan, décode la frame du milieu, détecte
    par domaine (animé + réel), embed chaque crop avec SON moteur → face_embeddings_v2.
    Réutilise les plans déjà détectés (cache scènes). `cut_model` = MÊME modèle de découpe que
    l'index de plans (SigLIP) : garantit que le scene_index des visages désigne le MÊME plan que
    l'index texte → l'intersection du filtre « @perso + mots-clés » (query._char_filtered_search)
    tombe sur le bon plan. Sans lui, les deux passes pouvaient prendre des découpes différentes."""
    engs = engines()
    if not engs:
        return {"ok": False, "file": path, "faces": 0, "cached": False,
                "error": t("face_engine_missing")}
    fps, frames, scenes = media.get_scenes(path, cut_model, detect_options)
    if not scenes:
        return {"ok": True, "file": path, "faces": 0, "cached": False, "error": None}
    mt = file_mtime(path)
    tags = [e.tag for e in engs.values()]
    engine_key = ",".join(sorted(tags))
    # Identité des FRONTIÈRES posées (cf. index.py) ; l'ancienne clé de réglages reste acceptée en
    # relecture pour ne pas périmer les passages déjà faits.
    cut_key = media.cut_identity(scenes)
    legacy_key = media.detection_key(cut_model, detect_options)
    con = db_emb()
    ph = ",".join("?" * len(tags))
    if not force:
        run = con.execute(
            "SELECT mtime, cut_key, faces FROM face_index_runs_v1 WHERE file_path=? AND engine_key=?",
            (path, engine_key)).fetchone()
        # cut_key NULL = passage antérieur à la clé de découpe : accepté (la découpe d'alors est
        # toujours celle que rend le cache de plans), sinon tout index de visages antérieur serait jeté.
        if run and abs((run[0] or 0) - mt) <= 1.0 and run[1] in (cut_key, legacy_key, None):
            purged = _purge_misdomained(con, path)
            refreshed = _refresh_small_thumbs(con, path, engs)
            remaining = max(0, int(run[2] or 0) - purged)
            if purged:
                con.execute(
                    "UPDATE face_index_runs_v1 SET faces=? WHERE file_path=? AND engine_key=?",
                    (remaining, path, engine_key))
                con.commit()
            con.close()
            return {"ok": True, "file": path, "faces": remaining, "cached": True,
                    "refreshed_thumbs": refreshed, "purged": purged, "error": None}
    # L'index existant n'est PAS effacé ici mais À LA FIN (cf. purge sous la boucle) : effacer d'abord
    # détruisait des visages valides dès qu'un job était interrompu — et « Arrêter » tue le daemon.
    # Préchauffe : le 1er clip charge les modèles (onnxruntime EXHAUSTIVE ~20-30 s). On le fait ICI,
    # sous la phase « chargement modèle », sur une image factice → la boucle par-plan reste fluide et
    # l'UI n'affiche pas « préparation » figée. Les clips suivants réutilisent les moteurs chauds.
    sys.stderr.write("PHASE:model\n"); sys.stderr.flush()
    try:
        from PIL import Image
        warm = Image.new("RGB", (128, 128))
        for domain, eng in engs.items():
            try:
                eng.detect(warm); eng.embed(warm, None)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass
    sys.stderr.write("PHASE:embed\n"); sys.stderr.flush()
    total = len(scenes); n_faces = 0
    now = time.time()
    # CLÉ pour l'indexation parallèle : on NE tient PAS le verrou d'écriture pendant le travail lourd
    # (décodage ffmpeg + inférence CCIP/SFace = plusieurs secondes par plan). On accumule les lignes en
    # mémoire et on les écrit en RAFALE (executemany + commit) toutes les ~64 lignes → verrou SQLite tenu
    # <1 s au lieu de tout le lot. Sinon les autres daemons attendent >30 s → « database is locked ».
    batch = []

    def flush():
        if not batch:
            return
        con.executemany(
            "INSERT OR REPLACE INTO face_embeddings_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
        con.commit()
        batch.clear()

    for i, sc in enumerate(scenes):
        sys.stderr.write("STAGE:prog:%d/%d\n" % (i + 1, total)); sys.stderr.flush()
        s0 = float(sc.get("start", 0) or 0); s1 = float(sc.get("end", 0) or 0)
        mid_sec = (s0 + s1) / 2.0
        f0 = sc.get("startFrame"); f1 = sc.get("endFrame")
        mid_frame = int((int(f0) + int(f1)) // 2) if f0 is not None and f1 is not None else None
        pil = media.grab_ffmpeg(path, mid_sec, max_edge=720)
        if pil is None:
            continue
        detected = _detect_all(pil)
        if not detected:
            # Escalade : le perso peut être hors champ pile au MILIEU du plan (dos tourné, cut-away)
            # → on retente à 25 % puis 75 % avant d'abandonner. Coût nul sur les plans où la frame
            # milieu a déjà un visage (la grande majorité) ; récupère les plans qui manquaient au
            # pool @perso.
            for frac in (0.25, 0.75):
                alt_sec = s0 + (s1 - s0) * frac
                alt = media.grab_ffmpeg(path, alt_sec, max_edge=720)
                if alt is None:
                    continue
                d2 = _detect_all(alt)
                if d2:
                    pil, detected, mid_sec = alt, d2, alt_sec
                    break
        if not detected:
            continue
        # Vignette NETTE : la frame 720px suffit pour l'embedding (le modèle redimensionne), mais un
        # crop de visage dessus fait ~100px → flou une fois affiché. On re-décode la frame en haute
        # résolution UNE fois par plan avec visage, et on découpe les vignettes dedans (bbox mise à
        # l'échelle). Sources ≤720p : pas de re-grab (rien à gagner). Échec du grab → repli 720.
        hi = media.grab_ffmpeg(path, mid_sec, max_edge=1600) if max(pil.size) >= 720 else None
        hs = (hi.width / float(pil.width)) if hi is not None and pil.width else 0.0
        for domain, found in detected.items():
            eng = engs[domain]
            for fidx, (bbox, _conf) in enumerate(found):
                try:
                    emb = eng.embed(pil, bbox)
                except Exception:  # noqa: BLE001
                    emb = None
                if emb is None:
                    continue
                if hs > 1.05:
                    hb = tuple(int(round(v * hs)) for v in bbox)
                    thumb = media.thumb_bytes(eng.crop(hi, hb))
                else:
                    thumb = media.thumb_bytes(eng.crop(pil, bbox))
                batch.append((path, mt, domain, eng.tag, i, fidx, f0, f1, mid_frame,
                              sc.get("start"), sc.get("end"), fps, frames,
                              json.dumps(list(bbox)), emb.astype(np.float32).tobytes(),
                              int(emb.shape[0]), now, thumb))
                n_faces += 1
        if len(batch) >= 64:
            flush()
    flush()
    # Reliquat du passage précédent = tout ce que CE passage n'a pas réécrit (`created_at` est fixé
    # une fois pour tout le run) : plans en trop d'une découpe plus courte, visages qui ne sont plus
    # détectés, embeddings d'une version antérieure du fichier. Purge en fin de run et pas au début,
    # pour qu'une interruption laisse l'index précédent intact plutôt que vide.
    con.execute(
        "DELETE FROM face_embeddings_v2 WHERE file_path=? AND engine IN (%s) "
        "AND created_at<>?" % ph, (path, *tags, now))
    con.execute(
        "INSERT OR REPLACE INTO face_index_runs_v1 (file_path,engine_key,mtime,cut_key,faces,created_at) "
        "VALUES (?,?,?,?,?,?)", (path, engine_key, mt, cut_key, n_faces, time.time()))
    con.commit()
    con.close()
    # NE PAS free_engines() ici : l'indexation itère sur TOUT le lot (1 RPC par clip). Libérer entre
    # chaque clip forcerait un rechargement CCIP/YuNet/SFace (onnxruntime EXHAUSTIVE, ~20-30 s) à CHAQUE
    # clip → saturation. On garde les moteurs CHAUDS ; le watchdog idle du daemon (180 s) libère la VRAM
    # quand le lot est fini (comme SigLIP).
    return {"ok": True, "file": path, "faces": n_faces, "cached": False, "error": None}


def cmd_face_detect(req):
    """Visages d'une IMAGE de référence (picker UI) : {faces:[{index,domain,bbox,thumb}]}.
    L'utilisateur clique le visage voulu → la réf {path,bbox,domain} part à face-search."""
    p = req.get("path", "")
    from PIL import Image
    try:
        pil = Image.open(p).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        return {"faces": [], "error": t("image_unreadable_error", error=exc)}
    if not engines():
        return {"faces": [], "error": t("face_engine_missing")}
    faces = []
    idx = 0
    for domain, found in _detect_all(pil).items():
        eng = engines()[domain]
        for bbox, conf in found:
            faces.append({"index": idx, "domain": domain, "bbox": list(bbox),
                          "conf": conf, "thumb": _thumb_uri(eng.crop(pil, bbox))})
            idx += 1
    return {"faces": faces, "error": None}


def _embed_refs(refs, con):
    """Embeddings des références groupés par domaine : {domain: [feat, ...]}.
    Réf = {path, bbox?, domain?} (visage choisi au picker, ou image entière → plus grand
    visage par domaine détecté) OU {file_path, scene_index, face_index?} (visage indexé)."""
    from PIL import Image
    by_dom = {}
    engs = engines()
    for rf in refs:
        p = rf.get("path")
        if p:
            try:
                pil = Image.open(p).convert("RGB")
            except Exception:  # noqa: BLE001
                continue
            bbox = rf.get("bbox")
            want = rf.get("domain")
            doms = [want] if want and want in engs else list(engs.keys())
            for domain in doms:
                eng = engs[domain]
                try:
                    if bbox:
                        feat = eng.embed(pil, tuple(int(v) for v in bbox))
                    else:
                        found = eng.detect(pil)
                        big = max(found, key=lambda fc: fc[0][2] * fc[0][3])[0] if found else None
                        feat = eng.embed(pil, big) if big else None
                except Exception:  # noqa: BLE001
                    feat = None
                if feat is not None:
                    by_dom.setdefault(domain, []).append(np.asarray(feat, dtype=np.float32))
            continue
        fp = rf.get("file_path"); si = rf.get("scene_index")
        if fp is None or si is None:
            continue
        fi = rf.get("face_index")
        q = ("SELECT domain, embedding FROM face_embeddings_v2 WHERE file_path=? AND scene_index=?"
             + (" AND face_index=?" if fi is not None else " ORDER BY face_index LIMIT 1"))
        args = (fp, int(si), int(fi)) if fi is not None else (fp, int(si))
        row = con.execute(q, args).fetchone()
        if row:
            by_dom.setdefault(row[0], []).append(np.frombuffer(row[1], dtype=np.float32).copy())
    return by_dom


def _label_map(con, keys):
    """{(file_path, scene_index): {id,name,color}} des personnages reconnus sur ces plans
    (face_labels_v1 → characters_v1). Meilleur score par plan. Roster/labels petits → rapide."""
    out = {}
    if not keys:
        return out
    for fp, si in keys:
        row = con.execute(
            "SELECT c.id, c.name, c.color FROM face_labels_v1 l JOIN characters_v1 c ON c.id=l.char_id "
            "WHERE l.file_path=? AND l.scene_index=? ORDER BY l.score DESC LIMIT 1", (fp, si)).fetchone()
        if row:
            out[(fp, si)] = {"id": row[0], "name": row[1], "color": row[2]}
    return out


def _search_by_domain_feats(by_dom, con, top_k=60, min_score=0.0, file_paths=None):
    """Cœur de la recherche visage, réutilisé par la recherche par personnage.
    by_dom = {domain: [feat, ...]} (réfs déjà embeddées). Par domaine : score de chaque visage
    indexé = MAX sur les réfs (calibré 0..1), max par plan, fusion des domaines, min_score, tri,
    top_k. Hits au format de la recherche normale + label personnage (face_labels_v1)."""
    engs = engines()
    wanted = set(str(p) for p in file_paths) if file_paths is not None else None
    best = {}
    any_rows = False
    for domain, ref_feats in by_dom.items():
        eng = engs.get(domain)
        if eng is None or not ref_feats:
            continue
        rows = con.execute(
            "SELECT file_path, scene_index, start_frame, end_frame, mid_frame, start_sec, end_sec, "
            "fps, src_frames, embedding, thumb FROM face_embeddings_v2 WHERE domain=? AND engine=?",
            (domain, eng.tag)).fetchall()
        if not rows:
            continue
        any_rows = True
        if wanted is not None:
            rows = [r for r in rows if r[0] in wanted]
        if not rows:
            continue
        feats = [np.frombuffer(r[9], dtype=np.float32) for r in rows]
        scores = eng.scores(ref_feats, feats)
        for r, score in zip(rows, scores):
            key = (r[0], r[1])
            if key not in best or score > best[key][0]:
                best[key] = (float(score), r)
    if not any_rows:
        return {"hits": [], "error": t("no_indexed_face")}
    items = sorted([v for v in best.values() if v[0] >= min_score], key=lambda t: t[0], reverse=True)
    items = items[: int(top_k or 60)]
    labels = _label_map(con, [(r[0], r[1]) for _s, r in items])
    hits = []
    for score, r in items:
        st = con.execute("SELECT thumb FROM frame_embeddings_v1 WHERE file_path=? AND scene_index=? LIMIT 1",
                         (r[0], r[1])).fetchone()
        tb = st[0] if st and st[0] else r[10]
        thumb = ("data:image/jpeg;base64," + base64.b64encode(tb).decode()) if tb else None
        hits.append({"file_path": r[0], "scene_index": r[1], "start_frame": r[2], "end_frame": r[3],
                     "mid_frame": r[4], "start_sec": r[5], "end_sec": r[6], "fps": r[7],
                     "src_frames": r[8], "score": score, "thumb": thumb,
                     "char": labels.get((r[0], r[1]))})
    return {"hits": hits, "error": None}


# Plafond de visages clusterisés PAR DOMAINE dans la galerie. Le clustering construit une matrice
# N×N (score_matrix) → coût mémoire/temps quadratique ; au-delà on garde les plus récents (mtime
# décroissant) et on journalise le surplus (jamais de calcul « infini » silencieux).
MAX_GALLERY_FACES = 4000

# Mémoïsation du clustering (partie COÛTEUSE) dans le daemon. Clé = signature de la table
# face_embeddings_v2 (count + mtime max par domaine/moteur) → rouvrir la galerie sans avoir
# (ré)indexé de visage est INSTANTANÉ. Les étiquettes de perso sont réappliquées à chaque appel
# (lecture SQLite légère), donc renommer/créer un perso reste immédiat sans refaire le clustering.
# La PORTÉE (rushs des projets sélectionnés) fait partie de la clé : les groupes et leurs effectifs
# sont calculés sur les seuls visages de la portée, pas filtrés après coup (un groupe dont le
# représentant est hors portée disparaîtrait alors qu'il a des membres dedans).
_GALLERY_CACHE = {}
_GALLERY_CACHE_MAX = 4   # portées récentes gardées (projet courant + quelques combinaisons)


def _greedy_cluster_matrix(S, thr=0.5):
    """Regroupement glouton par identité sur une matrice de scores N×N PRÉCALCULÉE (numpy pur, zéro
    appel modèle) : graine = 1er indice vivant, on rattache tous les vivants au-dessus du seuil, la
    graine appartient toujours à son groupe (terminaison garantie), on marque le groupe mort et on
    recommence. Renvoie une liste de listes d'indices."""
    n = S.shape[0]
    alive = np.ones(n, dtype=bool)
    clusters = []
    for seed in range(n):
        if not alive[seed]:
            continue
        mask = alive & (S[seed] >= thr)
        mask[seed] = True   # la graine appartient toujours à son groupe
        members = np.nonzero(mask)[0]
        clusters.append(members.tolist())
        alive[members] = False
    return clusters


def _face_area(r):
    """Aire du bbox — visage le plus GRAND du groupe = vignette la plus nette (jamais la graine
    arbitraire du clustering, souvent un petit crop flou). Sans vignette → dernier."""
    if not r[4]:
        return -1.0
    try:
        b = json.loads(r[5])
        return float(b[2]) * float(b[3])
    except Exception:  # noqa: BLE001
        return 0.0


def _gallery_rows(con, domain, engine_tag, file_paths):
    """Visages d'un moteur, restreints à la portée demandée (chemins par tranches : SQLite plafonne
    le nombre de paramètres liés). Ordre mtime décroissant conservé pour le plafond MAX_GALLERY_FACES."""
    sql = ("SELECT file_path, scene_index, face_index, embedding, thumb, bbox, mtime "
           "FROM face_embeddings_v2 WHERE domain=? AND engine=?")
    rows = []
    for chunk in path_chunks(file_paths):
        if chunk is None:
            rows += con.execute(sql + " ORDER BY mtime DESC", (domain, engine_tag)).fetchall()
            continue
        if not chunk:
            continue
        rows += con.execute(
            sql + " AND file_path IN (%s)" % ",".join("?" * len(chunk)),
            [domain, engine_tag] + chunk).fetchall()
    rows.sort(key=lambda r: r[6] or 0, reverse=True)
    return rows


def _cluster_gallery(con, file_paths=None):
    """Regroupement (coûteux) des visages indexés → groupes SANS étiquette, mémoïsé sur la signature
    de la table ET la portée (recalcul uniquement après une (ré)indexation ou un changement de portée)."""
    sig = tuple(con.execute(
        "SELECT domain, engine, COUNT(*), COALESCE(MAX(mtime), 0) "
        "FROM face_embeddings_v2 GROUP BY domain, engine").fetchall())
    scope = None if file_paths is None else tuple(sorted({str(p) for p in file_paths if p}))
    key = (sig, scope)
    if key in _GALLERY_CACHE:
        return _GALLERY_CACHE[key]

    out = []
    for domain, eng in engines().items():
        rows = _gallery_rows(con, domain, eng.tag, file_paths)
        if not rows:
            continue
        if len(rows) > MAX_GALLERY_FACES:
            sys.stderr.write("gallery: %d visages '%s' → clustering plafonné aux %d plus récents\n"
                             % (len(rows), domain, MAX_GALLERY_FACES))
            rows = rows[:MAX_GALLERY_FACES]
        feats = [np.frombuffer(r[3], dtype=np.float32) for r in rows]
        S = eng.score_matrix(feats)   # 1 seul passage modèle (vs 1 par graine avant)
        for members in _greedy_cluster_matrix(S):
            r = max((rows[m] for m in members), key=_face_area)
            thumb = ("data:image/jpeg;base64," + base64.b64encode(r[4]).decode()) if r[4] else None
            out.append({"domain": domain, "count": len(members), "thumb": thumb,
                        "ref": {"file_path": r[0], "scene_index": r[1], "face_index": r[2], "domain": domain}})
    out.sort(key=lambda c: c["count"], reverse=True)
    if len(_GALLERY_CACHE) >= _GALLERY_CACHE_MAX:
        _GALLERY_CACHE.pop(next(iter(_GALLERY_CACHE)))   # plus ancienne portée mémoïsée
    _GALLERY_CACHE[key] = out
    return out


def cmd_face_gallery(req):
    """Galerie des visages DÉJÀ indexés, regroupés par identité → l'utilisateur clique un visage pour
    le chercher directement (sans fournir de photo). Un groupe = un visage représentatif + son nombre
    d'occurrences + une réf (file_path/scene_index/face_index) pour la recherche + le nom si étiqueté."""
    top_k = int(req.get("top_k", 200) or 200)
    min_size = int(req.get("min_size", 1) or 1)
    file_paths = req.get("file_paths") if "file_paths" in req else None
    con = db_emb()
    try:
        _purge_misdomained(con)   # nettoie les doublons real/anime d'avant l'arbitrage (toute la base)
        groups = [c for c in _cluster_gallery(con, file_paths) if c["count"] >= min_size][:top_k]
        # étiquette (nom du perso) du plan représentatif — fraîche à chaque appel (clustering en cache)
        labels = _label_map(con, [(c["ref"]["file_path"], c["ref"]["scene_index"]) for c in groups])
        faces = [dict(c, char=labels.get((c["ref"]["file_path"], c["ref"]["scene_index"]))) for c in groups]
        return {"faces": faces, "error": None}
    finally:
        con.close()


def cmd_face_search(req):
    """Top-K plans contenant le personnage des références (images/visages choisis)."""
    con = db_emb()
    try:
        refs = req.get("refs")
        if not refs:
            rf = {k: req.get(k) for k in ("path", "file_path", "scene_index", "face_index")}
            refs = [rf] if (rf.get("path") or rf.get("file_path") is not None) else []
        by_dom = _embed_refs(refs, con)
        if not by_dom:
            return {"hits": [], "error": t("no_reference_face")}
        return _search_by_domain_feats(by_dom, con, req.get("top_k", 60),
                                       float(req.get("min_score", 0) or 0), req.get("file_paths"))
    finally:
        con.close()


def cmd_face_status(file_paths=None):
    con = db_emb()
    faces = clips = 0
    doms = {}
    try:
        for chunk in path_chunks(file_paths):
            where, args = "", []
            if chunk is not None:
                if not chunk:
                    continue
                where = " WHERE file_path IN (%s)" % ",".join("?" * len(chunk))
                args = chunk
            row = con.execute(
                "SELECT COUNT(*), COUNT(DISTINCT file_path) FROM face_embeddings_v2" + where, args).fetchone()
            faces += row[0] or 0
            clips += row[1] or 0
            for dom, count in con.execute(
                    "SELECT domain, COUNT(*) FROM face_embeddings_v2" + where + " GROUP BY domain", args):
                doms[dom] = doms.get(dom, 0) + int(count or 0)
    finally:
        con.close()
    return {"faces": faces, "clips": clips,
            "anime": int(doms.get("anime", 0)), "real": int(doms.get("real", 0)), "error": None}


def cmd_face_engines():
    """Moteurs de visage DISPONIBLES (dépendances + poids présents) — pour proposer le téléchargement
    des modèles quand ils manquent. Ne charge rien de lourd (available() = test léger)."""
    engs = engines()
    return {"anime": "anime" in engs, "real": "real" in engs, "ready": bool(engs), "error": None}


def cmd_face_indexed():
    """État d'indexation des VISAGES par clip (pour le sélecteur d'indexation) : nb de visages +
    mtime source du dernier index. Le picker marque « fait » vs « à faire » / « périmé »."""
    con = db_emb()
    rows = con.execute("SELECT file_path, COUNT(*), MAX(mtime) FROM face_embeddings_v2 GROUP BY file_path").fetchall()
    con.close()
    return {"indexed": {r[0]: {"faces": int(r[1]), "mtime": r[2]} for r in rows}, "error": None}
