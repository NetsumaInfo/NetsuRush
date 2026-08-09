"""Bibliothèque de personnages nommés : mémorise un visage → nom + métadonnées, pour que la
recherche future le reconnaisse (auto-suggestion), permette de chercher par personnage enregistré
(multi-échantillons = plus robuste qu'une photo) et d'auto-étiqueter tout l'index (filtre instantané
« tous les plans de X »). Réutilise faceengines (embeddings/scores par domaine) et le cœur de
recherche visage (faces._search_by_domain_feats). Voir db.py pour le schéma."""
import base64
import json
import sys
import time

import numpy as np
from nri18n import t

from . import faces, media
from .catalog import path_chunks
from .db import db_emb
from .faceengines import engines


def _uri(blob):
    return ("data:image/jpeg;base64," + base64.b64encode(blob).decode()) if blob else None


def _jpeg_px(blob):
    """Nb de pixels d'une vignette JPEG (0 si absente/illisible) — pour comparer deux avatars."""
    if not blob:
        return 0
    import io

    from PIL import Image
    try:
        w, h = Image.open(io.BytesIO(blob)).size
        return w * h
    except Exception:  # noqa: BLE001
        return 0


def _tags(s):
    try:
        v = json.loads(s) if s else []
        return [str(t) for t in v] if isinstance(v, list) else []
    except Exception:  # noqa: BLE001
        return []


# --- CRUD ------------------------------------------------------------------------------------

def cmd_char_list(file_paths=None):
    con = db_emb()
    try:
        chars = con.execute("SELECT id, name, notes, tags, color, avatar FROM characters_v1 ORDER BY name").fetchall()
        # Plans étiquetés DANS la portée : le renderer masque les persos absents du projet courant.
        scope_shots = {}
        if file_paths is not None:
            for chunk in path_chunks(file_paths):
                if not chunk:
                    continue
                for cid, shots in con.execute(
                        "SELECT char_id, COUNT(DISTINCT file_path || '#' || scene_index) "
                        "FROM face_labels_v1 WHERE file_path IN (%s) GROUP BY char_id"
                        % ",".join("?" * len(chunk)), chunk):
                    scope_shots[cid] = scope_shots.get(cid, 0) + int(shots or 0)
        counts = {}
        for cid, dom, n in con.execute(
                "SELECT char_id, domain, COUNT(*) FROM character_samples_v1 GROUP BY char_id, domain"):
            counts.setdefault(cid, {}).update({dom: n})
        out = []
        for c in chars:
            sc = counts.get(c[0], {})
            out.append({"id": c[0], "name": c[1] or "", "notes": c[2] or "", "tags": _tags(c[3]),
                        "color": c[4] or "", "avatar": _uri(c[5]),
                        "samples": {"anime": int(sc.get("anime", 0)), "real": int(sc.get("real", 0))},
                        "total": int(sum(sc.values())),
                        "scope_shots": scope_shots.get(c[0], 0) if file_paths is not None else None})
        return {"characters": out, "error": None}
    finally:
        con.close()


def cmd_char_create(req):
    name = (req.get("name") or "").strip()
    if not name:
        return {"id": None, "error": t("required_name")}
    con = db_emb()
    try:
        now = time.time()
        cur = con.execute(
            "INSERT INTO characters_v1(name, notes, tags, color, avatar, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (name, req.get("notes") or "", json.dumps(req.get("tags") or []), req.get("color") or "", None, now, now))
        con.commit()
        return {"id": cur.lastrowid, "error": None}
    finally:
        con.close()


def cmd_char_update(req):
    cid = req.get("id")
    if cid is None:
        return {"ok": False, "error": t("required_id")}
    fields, vals = [], []
    for k, col in (("name", "name"), ("notes", "notes"), ("color", "color")):
        if k in req:
            fields.append("%s=?" % col); vals.append(req.get(k) or "")
    if "tags" in req:
        fields.append("tags=?"); vals.append(json.dumps(req.get("tags") or []))
    if not fields:
        return {"ok": True, "error": None}
    fields.append("updated_at=?"); vals.append(time.time())
    con = db_emb()
    try:
        con.execute("UPDATE characters_v1 SET %s WHERE id=?" % ", ".join(fields), (*vals, int(cid)))
        con.commit()
        return {"ok": True, "error": None}
    finally:
        con.close()


def cmd_char_delete(req):
    cid = req.get("id")
    if cid is None:
        return {"ok": False, "error": t("required_id")}
    con = db_emb()
    try:
        con.execute("DELETE FROM characters_v1 WHERE id=?", (int(cid),))
        con.execute("DELETE FROM character_samples_v1 WHERE char_id=?", (int(cid),))
        con.execute("DELETE FROM face_labels_v1 WHERE char_id=?", (int(cid),))
        con.commit()
        return {"ok": True, "error": None}
    finally:
        con.close()


def cmd_char_merge(req):
    """Fusionne deux personnages (même individu créé en double) : les échantillons et labels de la
    SOURCE passent à la CIBLE, métadonnées fondues (nom/couleur/avatar de la cible conservés,
    tags unionnés, notes concaténées), puis la source est supprimée. Labels re-pointés sans conflit
    (1 label par visage, char_id hors PK). Réversibilité : ré-étiqueter l'index reclasse tout."""
    src = req.get("source_id"); tgt = req.get("target_id")
    if src is None or tgt is None:
        return {"ok": False, "error": t("required_source_target")}
    src, tgt = int(src), int(tgt)
    if src == tgt:
        return {"ok": False, "error": t("same_character")}
    con = db_emb()
    try:
        # Ne JAMAIS nommer ces lignes `s`/`t` : `t` est la fonction de traduction importée en tête,
        # et la masquer transformait le message « personnage introuvable » en TypeError.
        src_row = con.execute("SELECT name, notes, tags, color, avatar FROM characters_v1 WHERE id=?", (src,)).fetchone()
        tgt_row = con.execute("SELECT name, notes, tags, color, avatar FROM characters_v1 WHERE id=?", (tgt,)).fetchone()
        if not src_row or not tgt_row:
            return {"ok": False, "error": t("character_not_found")}
        tags = list(dict.fromkeys(_tags(tgt_row[2]) + _tags(src_row[2])))           # union, ordre préservé
        notes = "\n".join([n for n in (tgt_row[1], src_row[1]) if n]) if (tgt_row[1] and src_row[1]) else (tgt_row[1] or src_row[1] or "")
        avatar = tgt_row[4] if _jpeg_px(tgt_row[4]) >= _jpeg_px(src_row[4]) else src_row[4]   # le plus net des deux
        con.execute("UPDATE characters_v1 SET tags=?, notes=?, color=?, avatar=?, updated_at=? WHERE id=?",
                    (json.dumps(tags), notes, tgt_row[3] or src_row[3] or "", avatar, time.time(), tgt))
        con.execute("UPDATE character_samples_v1 SET char_id=? WHERE char_id=?", (tgt, src))
        con.execute("UPDATE face_labels_v1 SET char_id=? WHERE char_id=?", (tgt, src))
        con.execute("DELETE FROM characters_v1 WHERE id=?", (src,))
        con.commit()
        return {"ok": True, "target_id": tgt, "error": None}
    finally:
        con.close()


def cmd_char_duplicates(req):
    """Paires de personnages qui se RESSEMBLENT (probablement le même individu créé en double) :
    similarité croisée des échantillons, calibrée, MAX sur les domaines. Roster petit → O(paires)
    peu coûteux. Renvoie {pairs:[{a:{id,name}, b:{id,name}, score}]} triées (score décroissant)."""
    min_score = float(req.get("min_score", 0.55) or 0.55)
    con = db_emb()
    try:
        engs = engines()
        roster = _samples_by_domain(con)   # {domain: [(char_id, feat), ...]}
        if not roster:
            return {"pairs": [], "error": None}
        names = dict(con.execute("SELECT id, name FROM characters_v1"))
        colors = dict(con.execute("SELECT id, color FROM characters_v1"))
        pair_best = {}   # frozenset({a,b}) -> score max sur les domaines
        for domain, samp in roster.items():
            eng = engs.get(domain)
            if eng is None:
                continue
            by_char = {}
            for cid, f in samp:
                by_char.setdefault(cid, []).append(f)
            cids = list(by_char.keys())
            for i in range(len(cids)):
                for j in range(i + 1, len(cids)):
                    a, b = cids[i], cids[j]
                    sc = float(np.max(eng.scores(by_char[a], by_char[b])))   # meilleure paire d'échantillons
                    key = frozenset((a, b))
                    if key not in pair_best or sc > pair_best[key]:
                        pair_best[key] = sc
        pairs = []
        for key, sc in pair_best.items():
            if sc < min_score:
                continue
            a, b = sorted(key)
            pairs.append({"a": {"id": a, "name": names.get(a, ""), "color": colors.get(a, "")},
                          "b": {"id": b, "name": names.get(b, ""), "color": colors.get(b, "")},
                          "score": sc})
        pairs.sort(key=lambda p: p["score"], reverse=True)
        return {"pairs": pairs, "error": None}
    finally:
        con.close()


# --- Échantillons ----------------------------------------------------------------------------

def _samples_from_ref(rf, con):
    """[(domain, engine_tag, emb_bytes, dim, thumb_bytes, file_path, scene_index, face_index), ...]
    pour un visage de référence. Réf indexée (file_path/scene_index/face_index) → lit la ligne
    face_embeddings_v2 telle quelle (pas de ré-embed), en respectant `domain` si fourni (un plan
    peut avoir un visage animé ET un visage réel au même face_index). Réf image (path[, bbox,
    domain]) → embed avec le(s) moteur(s) du domaine (provenance = None)."""
    fp = rf.get("file_path"); si = rf.get("scene_index")
    if fp is not None and si is not None:
        fi = rf.get("face_index", 0) or 0
        dom = rf.get("domain")
        q = ("SELECT domain, engine, embedding, dim, thumb FROM face_embeddings_v2 "
             "WHERE file_path=? AND scene_index=? AND face_index=?")
        args = [fp, int(si), int(fi)]
        if dom:
            q += " AND domain=?"; args.append(dom)
        row = con.execute(q, args).fetchone()
        return [(row[0], row[1], row[2], int(row[3]), row[4], fp, int(si), int(fi))] if row else []
    p = rf.get("path")
    if not p:
        return []
    from PIL import Image
    try:
        pil = Image.open(p).convert("RGB")
    except Exception:  # noqa: BLE001
        return []
    engs = engines()
    bbox = rf.get("bbox")
    want = rf.get("domain")
    doms = [want] if want and want in engs else list(engs.keys())
    out = []
    for domain in doms:
        eng = engs[domain]
        try:
            if bbox:
                box = tuple(int(v) for v in bbox)
            else:
                found = eng.detect(pil)
                box = max(found, key=lambda fc: fc[0][2] * fc[0][3])[0] if found else None
            if box is None:
                continue
            feat = eng.embed(pil, box)
            if feat is None:
                continue
            thumb = media.thumb_bytes(eng.crop(pil, box))
            out.append((domain, eng.tag, feat.astype(np.float32).tobytes(), int(feat.shape[0]), thumb,
                        None, None, None))
        except Exception:  # noqa: BLE001
            continue
    return out


def cmd_char_add_sample(req):
    cid = req.get("char_id")
    if cid is None:
        return {"ok": False, "added": 0, "error": t("required_char_id")}
    con = db_emb()
    try:
        # Réf indexée SANS face_index (confirmation « c'est bien lui » sur un résultat) : prendre
        # LE visage du plan déjà étiqueté pour CE perso (meilleur score), pas aveuglément le n°0.
        if req.get("file_path") is not None and req.get("face_index") is None:
            row = con.execute(
                "SELECT face_index FROM face_labels_v1 WHERE file_path=? AND scene_index=? AND char_id=? "
                "ORDER BY score DESC LIMIT 1", (req["file_path"], int(req.get("scene_index", 0)), int(cid))).fetchone()
            if row:
                req = {**req, "face_index": int(row[0])}
        samples = _samples_from_ref(req, con)
        if not samples:
            return {"ok": False, "added": 0, "error": t("no_face_to_save")}
        now = time.time()
        for domain, tag, emb, dim, thumb, fp, si, fi in samples:
            con.execute("INSERT INTO character_samples_v1(char_id, domain, engine, embedding, dim, thumb, "
                        "created_at, file_path, scene_index, face_index) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (int(cid), domain, tag, emb, dim, thumb, now, fp, si, fi))
        # Avatar : la plus GRANDE vignette vue jusqu'ici (un nouvel échantillon nettement plus
        # grand remplace l'ancien avatar flou — le perso devient plus net à l'usage).
        av = con.execute("SELECT avatar FROM characters_v1 WHERE id=?", (int(cid),)).fetchone()
        best_thumb = max((t for _d, _e, _b, _n, t, _fp, _si, _fi in samples if t), key=_jpeg_px, default=None)
        if best_thumb and _jpeg_px(best_thumb) > _jpeg_px(av[0] if av else None) * 1.3:
            con.execute("UPDATE characters_v1 SET avatar=?, updated_at=? WHERE id=?", (best_thumb, now, int(cid)))
        con.commit()
        return {"ok": True, "added": len(samples), "error": None}
    finally:
        con.close()


def cmd_char_samples(req):
    """Échantillons d'un personnage (vignettes) — pour VOIR quels visages composent le perso et
    supprimer ceux qui n'ont rien à y faire. Au passage, GUÉRIT les vignettes : si l'échantillon a
    une provenance et que la ligne d'index correspondante porte une vignette plus grande (index
    re-croppé en haute résolution), on la recopie ici (et sur l'avatar si mieux)."""
    cid = req.get("char_id")
    if cid is None:
        return {"samples": [], "error": t("required_char_id")}
    con = db_emb()
    try:
        rows = con.execute(
            "SELECT id, domain, thumb, created_at, file_path, scene_index, face_index "
            "FROM character_samples_v1 WHERE char_id=? ORDER BY created_at DESC", (int(cid),)).fetchall()
        healed = False
        out = []
        for sid, dom, tb, ts, fp, si, fi in rows:
            if fp is not None and si is not None:
                fr = con.execute(
                    "SELECT thumb FROM face_embeddings_v2 WHERE file_path=? AND scene_index=? "
                    "AND face_index=? AND domain=?", (fp, int(si), int(fi or 0), dom)).fetchone()
                if fr and fr[0] and _jpeg_px(fr[0]) > _jpeg_px(tb) * 1.2:
                    tb = fr[0]
                    con.execute("UPDATE character_samples_v1 SET thumb=? WHERE id=?", (tb, sid))
                    healed = True
            out.append({"id": sid, "domain": dom, "thumb": _uri(tb), "created_at": ts,
                        "file_path": fp, "scene_index": si})
        if healed:
            best = max((r for r in con.execute(
                "SELECT thumb FROM character_samples_v1 WHERE char_id=?", (int(cid),)) if r[0]),
                key=lambda r: _jpeg_px(r[0]), default=None)
            av = con.execute("SELECT avatar FROM characters_v1 WHERE id=?", (int(cid),)).fetchone()
            if best and _jpeg_px(best[0]) > _jpeg_px(av[0] if av else None) * 1.2:
                con.execute("UPDATE characters_v1 SET avatar=?, updated_at=? WHERE id=?",
                            (best[0], time.time(), int(cid)))
            con.commit()
        return {"samples": out, "error": None}
    finally:
        con.close()


def cmd_char_remove_sample(req):
    sid = req.get("id")
    if sid is None:
        return {"ok": False, "error": t("required_id")}
    con = db_emb()
    try:
        con.execute("DELETE FROM character_samples_v1 WHERE id=?", (int(sid),))
        con.commit()
        return {"ok": True, "error": None}
    finally:
        con.close()


# --- Identification / recherche / étiquetage -------------------------------------------------

def _samples_by_domain(con, char_id=None):
    """{domain: [(char_id, feat), ...]} des échantillons du roster (ou d'un seul perso)."""
    q = "SELECT char_id, domain, engine, embedding FROM character_samples_v1"
    args = ()
    if char_id is not None:
        q += " WHERE char_id=?"; args = (int(char_id),)
    out = {}
    for cid, domain, _tag, emb in con.execute(q, args):
        out.setdefault(domain, []).append((cid, np.frombuffer(emb, dtype=np.float32)))
    return out


def cmd_char_identify(req):
    """Pour chaque visage de référence, meilleur personnage du roster (par domaine, calibré).
    Renvoie {matches: [{index, char_id, name, color, score} | null]} aligné sur refs."""
    refs = req.get("refs") or []
    min_score = float(req.get("min_score", 0.5) or 0.5)
    con = db_emb()
    try:
        roster = _samples_by_domain(con)
        if not roster:
            return {"matches": [None] * len(refs), "error": None}
        names = dict(con.execute("SELECT id, name FROM characters_v1"))
        colors = dict(con.execute("SELECT id, color FROM characters_v1"))
        engs = engines()
        matches = []
        for i, rf in enumerate(refs):
            by_dom = faces._embed_refs([rf], con)  # {domain: [feat]}
            best = None
            for domain, feats in by_dom.items():
                eng = engs.get(domain)
                samp = roster.get(domain)
                if eng is None or not samp or not feats:
                    continue
                ref = feats[0]
                sfeats = [f for _cid, f in samp]
                scores = eng.scores([ref], sfeats)   # calibré par échantillon
                per_char = {}
                for (cid, _f), sc in zip(samp, scores):
                    if cid not in per_char or sc > per_char[cid]:
                        per_char[cid] = float(sc)
                for cid, sc in per_char.items():
                    if sc >= min_score and (best is None or sc > best["score"]):
                        best = {"index": i, "char_id": cid, "name": names.get(cid, ""),
                                "color": colors.get(cid, ""), "score": sc, "domain": domain}
            matches.append(best)
        return {"matches": matches, "error": None}
    finally:
        con.close()


def cmd_char_search(req):
    """Recherche visage par personnage enregistré : tous ses échantillons = réfs multi-domaine."""
    cid = req.get("char_id")
    if cid is None:
        return {"hits": [], "error": t("required_char_id")}
    con = db_emb()
    try:
        by_dom = {dom: [f for _cid, f in samp] for dom, samp in _samples_by_domain(con, int(cid)).items()}
        if not by_dom:
            return {"hits": [], "error": t("character_no_samples")}
        return faces._search_by_domain_feats(by_dom, con, req.get("top_k", 60),
                                              float(req.get("min_score", 0) or 0), req.get("file_paths"))
    finally:
        con.close()


def cmd_char_label_index(req):
    """Auto-étiquetage : matche TOUS les visages indexés contre le roster → face_labels_v1
    (meilleur personnage par visage, calibré ≥ seuil). Recalculable (purge d'abord)."""
    min_score = float(req.get("min_score", 0.5) or 0.5)
    con = db_emb()
    try:
        engs = engines()
        roster = _samples_by_domain(con)
        if not roster:
            return {"ok": False, "labeled": 0, "faces": 0, "error": t("no_characters")}
        con.execute("DELETE FROM face_labels_v1")
        con.commit()
        # unité de progression = (domaine, personnage) traité.
        units = sum(len({cid for cid, _f in samp}) for dom, samp in roster.items() if dom in engs)
        done = 0
        sys.stderr.write("PHASE:embed\n"); sys.stderr.flush()
        best = {}   # (file_path, scene_index, face_index, domain) -> (score, char_id)
        n_faces = 0
        for domain, samp in roster.items():
            eng = engs.get(domain)
            if eng is None:
                continue
            rows = con.execute("SELECT file_path, scene_index, face_index, embedding FROM face_embeddings_v2 "
                               "WHERE domain=? AND engine=?", (domain, eng.tag)).fetchall()
            if not rows:
                # avance quand même la progression pour les persos de ce domaine
                done += len({cid for cid, _f in samp})
                continue
            n_faces += len(rows)
            ffeats = [np.frombuffer(r[3], dtype=np.float32) for r in rows]
            by_char = {}
            for cid, f in samp:
                by_char.setdefault(cid, []).append(f)
            for cid, cfeats in by_char.items():
                scores = eng.scores(cfeats, ffeats)   # par visage, max sur les échantillons du perso
                for r, sc in zip(rows, scores):
                    key = (r[0], r[1], r[2], domain)
                    s = float(sc)
                    if s >= min_score and (key not in best or s > best[key][0]):
                        best[key] = (s, cid)
                done += 1
                sys.stderr.write("STAGE:prog:%d/%d\n" % (min(done, units), units)); sys.stderr.flush()
        for (fp, si, fi, dom), (s, cid) in best.items():
            con.execute("INSERT OR REPLACE INTO face_labels_v1(file_path, scene_index, face_index, domain, char_id, score) "
                        "VALUES (?,?,?,?,?,?)", (fp, si, fi, dom, cid, s))
        con.commit()
        return {"ok": True, "labeled": len(best), "faces": n_faces, "error": None}
    finally:
        con.close()


def cmd_char_shots(req):
    """Tous les plans d'un personnage via la table de labels (instantané, zéro calcul d'embedding)."""
    cid = req.get("char_id")
    if cid is None:
        return {"hits": [], "error": t("required_char_id")}
    con = db_emb()
    try:
        rows = con.execute(
            "SELECT f.file_path, f.scene_index, f.start_frame, f.end_frame, f.mid_frame, f.start_sec, "
            "f.end_sec, f.fps, f.src_frames, f.thumb, l.score "
            "FROM face_labels_v1 l JOIN face_embeddings_v2 f "
            "ON f.file_path=l.file_path AND f.scene_index=l.scene_index AND f.face_index=l.face_index "
            "AND f.domain=l.domain WHERE l.char_id=?", (int(cid),)).fetchall()
        if "file_paths" in req:
            wanted = set(str(p) for p in (req.get("file_paths") or []))
            rows = [r for r in rows if r[0] in wanted]
        name = con.execute("SELECT name, color FROM characters_v1 WHERE id=?", (int(cid),)).fetchone()
        label = {"id": int(cid), "name": name[0] if name else "", "color": name[1] if name else ""}
        best = {}
        for r in rows:
            key = (r[0], r[1])
            if key not in best or r[10] > best[key][10]:
                best[key] = r
        items = sorted(best.values(), key=lambda r: r[10], reverse=True)[: int(req.get("top_k", 200) or 200)]
        hits = []
        for r in items:
            st = con.execute("SELECT thumb FROM frame_embeddings_v1 WHERE file_path=? AND scene_index=? LIMIT 1",
                             (r[0], r[1])).fetchone()
            tb = st[0] if st and st[0] else r[9]
            thumb = ("data:image/jpeg;base64," + base64.b64encode(tb).decode()) if tb else None
            hits.append({"file_path": r[0], "scene_index": r[1], "start_frame": r[2], "end_frame": r[3],
                         "mid_frame": r[4], "start_sec": r[5], "end_sec": r[6], "fps": r[7],
                         "src_frames": r[8], "score": float(r[10]), "thumb": thumb, "char": label})
        return {"hits": hits, "error": None}
    finally:
        con.close()
