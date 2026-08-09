"""Recherche unifiée (texte ET/OU réfs images/plans, texte négatif, seuil calibré, score
esthétique), dédoublonnage (prises quasi-identiques, union-find) et clustering (moodboard par
ambiance, k-means cosinus à k auto). Périmètre : liste de plans, un clip, ou toute la base."""

import numpy as np
from nri18n import language, t

from .config import CHAR_POOL_THR, DEDUP_THR, IDENTITY_WEIGHT, MODEL_TAG
from .db import db_emb, purge_malformed_embeddings, usable_embeddings
from . import model, qtext
from .store import STORE


def cmd_warm():
    """Prépare modèle + index mémoire avant la première requête visible."""
    model.load()
    return STORE.warm()


def _unit(vec):
    """Re-normalise L2 (cosinus = produit scalaire). Vecteur nul → rendu tel quel."""
    norm = float(np.linalg.norm(vec))
    return (vec / norm).astype(np.float32) if norm > 0 else vec.astype(np.float32)


def _embed_query(text, ui_lang, character):
    """Vecteur d'une requête texte = moyenne PONDÉRÉE de ses vues (cf. qtext) re-normalisée.

    Une seule phrase rendait le classement dépendant de la tournure employée ; l'ensemble de vues
    (requête nue + cadrages écrits dans SA langue) annule ce bruit. None = plus rien à chercher une
    fois la requête nettoyée.
    """
    views, _lang = qtext.prepare(text, ui_lang, character)
    if not views:
        return None
    mat = model.embed_texts([view for view, _weight in views])
    weights = np.asarray([weight for _view, weight in views], dtype=np.float32)
    return _unit((mat * weights[:, None]).sum(axis=0))


def _ref_embedding(con, ref):
    """Embedding d'une référence de recherche : image externe (ref['path']) → embed à la volée ;
    plan déjà indexé (ref['file_path']+['scene_index']) → lit l'embedding stocké (instantané,
    aucun ré-embed). Renvoie None si introuvable/illisible (la réf est simplement ignorée)."""
    p = ref.get("path")
    if p:
        from PIL import Image
        try:
            return model.embed_images([Image.open(p).convert("RGB")])[0]
        except Exception:  # noqa: BLE001
            return None
    fp = ref.get("file_path")
    si = ref.get("scene_index")
    if fp is None or si is None:
        return None
    row = con.execute(
        "SELECT embedding FROM frame_embeddings_v1 WHERE file_path=? AND model=? AND scene_index=?",
        (fp, MODEL_TAG, int(si)),
    ).fetchone()
    return np.frombuffer(row[0], dtype=np.float32).copy() if row else None


def cmd_query(text, top_k=60):
    return cmd_search({"text": text, "top_k": top_k})              # compat (reroute)


def cmd_query_image(img_path, top_k=60):
    return cmd_search({"refs": [{"path": img_path}], "top_k": top_k})  # compat (reroute)


def cmd_search(req):
    """Recherche unifiée : texte ET/OU réfs (images externes + plans indexés), texte négatif,
    seuil calibré, score esthétique. Les réfs sont mean-poolées puis re-normalisées L2 →
    1 réf = image→image, N réfs = moodboard, 1 réf indexée = « trouver similaires ».
    `char_ids` (mentions @perso) → la recherche est RESTREINTE au pool de plans de ces persos
    (intersection : plans contenant TOUS les persos cités). `char_id` seul accepté (compat).
    `lang` = langue de l'interface, a priori quand la requête est trop courte pour trancher."""
    text = (req.get("text") or "").strip()
    neg_text = (req.get("neg_text") or "").strip()
    # Langue de repli quand la requête est trop courte pour trancher : celle demandée par l'appelant,
    # sinon celle du sidecar (NR_LANG = langue de l'app) → les entrées sans `lang` (commande `query`
    # compat, panneau de références) restent cadrées dans la bonne langue.
    ui_lang = req.get("lang") or language()
    refs = req.get("refs") or []
    top_k = int(req.get("top_k", 60))
    min_score = float(req.get("min_score", 0.0))
    beta = float(req.get("beta", 0.4))
    aesthetic = bool(req.get("aesthetic"))
    file_paths = req.get("file_paths") if "file_paths" in req else None
    char_ids = req.get("char_ids")
    if not char_ids:
        cid = req.get("char_id")
        char_ids = [int(cid)] if cid is not None else []
    else:
        char_ids = [int(c) for c in char_ids]
    model.load()
    con = db_emb()
    try:
        pos = []
        if text:
            q_text = _embed_query(text, ui_lang, bool(char_ids))
            if q_text is not None:
                pos.append(q_text)
        for r in refs:
            e = _ref_embedding(con, r)
            if e is not None:
                pos.append(e)
        q_pos = None
        if pos:
            q_pos = _unit(np.mean(np.stack(pos), axis=0)) if len(pos) > 1 else pos[0]
        q_neg = _embed_query(neg_text, ui_lang, False) if neg_text else None
        if char_ids:
            # Avec des mentions : filtre par pool perso, texte optionnel (vide = tous leurs plans).
            return _char_filtered_search(con, q_pos, top_k, min_score, q_neg, beta, aesthetic, char_ids, file_paths)
        if q_pos is None:
            return {"hits": [], "error": t("empty_query")}
        if file_paths is not None:
            return STORE.search_paths(q_pos, file_paths, top_k, min_score, q_neg, beta, aesthetic)
        return STORE.search(q_pos, top_k, min_score, q_neg, beta, aesthetic)
    finally:
        con.close()


def _plan_grid(con, fp, cache):
    """Plans SigLIP d'un fichier : [(scene_index, start_frame, end_frame)]. Mémoïsé par fichier
    (le remap projette potentiellement des centaines de visages sur la même grille)."""
    if fp not in cache:
        cache[fp] = con.execute(
            "SELECT scene_index, start_frame, end_frame FROM frame_embeddings_v1 "
            "WHERE file_path=? AND model=? ORDER BY scene_index", (fp, MODEL_TAG)).fetchall()
    return cache[fp]


def _remap_to_plans(con, face_rows, cache):
    """Projette des visages reconnus sur les plans de l'INDEX SIGLIP par POSITION TEMPORELLE,
    pas par égalité aveugle de scene_index : l'index visages et l'index de plans peuvent avoir
    été bâtis sur des DÉCOUPES DIFFÉRENTES (le repli « découpe la plus récente en cache » de
    media.get_scenes diverge si une détection Derush s'est intercalée) → les scene_index se
    décalent et l'intersection désignait les mauvais plans. Ici : mid_frame du visage contenu
    dans [start,end] du plan ; repli chevauchement max de [f0,f1] ; repli scene_index identique
    (grille sans frames). face_rows = [(fp, si, mid_frame, f0, f1, score)].
    Renvoie {(fp, scene_index_PLAN): meilleur score de reconnaissance}."""
    pool = {}
    for fp, si, midf, f0, f1, sc in face_rows:
        grid = _plan_grid(con, fp, cache)
        if not grid:
            continue                      # fichier absent de l'index de plans → infilrable
        target = None
        m = midf
        if m is None and f0 is not None and f1 is not None:
            m = (int(f0) + int(f1)) // 2
        if m is not None:
            for psi, ps, pe in grid:
                if ps is not None and pe is not None and ps <= m <= pe:
                    target = psi
                    break
        if target is None and f0 is not None and f1 is not None:
            best_ov = 0
            for psi, ps, pe in grid:
                if ps is None or pe is None:
                    continue
                ov = min(int(f1), pe) - max(int(f0), ps) + 1
                if ov > best_ov:
                    best_ov, target = ov, psi
        if target is None and any(psi == si for psi, _ps, _pe in grid):
            target = si                   # grille sans frame-info : même découpe supposée
        if target is None:
            continue
        key = (fp, target)
        s = float(sc or 0.0)
        if s > pool.get(key, 0.0):
            pool[key] = s
    return pool


def _char_pool(con, char_id, thr, cache):
    """{(file_path, scene_index): score} des plans (espace INDEX SIGLIP) où CE perso est reconnu
    au-dessus de `thr`. D'abord les labels stockés (instantané, score déjà en base) remappés sur
    la grille de plans ; si aucun ne passe le seuil, repli LIVE : matche les échantillons du perso
    contre les visages indexés au même seuil, remappés pareil."""
    rows = con.execute(
        "SELECT l.file_path, l.scene_index, e.mid_frame, e.start_frame, e.end_frame, l.score "
        "FROM face_labels_v1 l LEFT JOIN face_embeddings_v2 e ON e.file_path=l.file_path "
        "AND e.scene_index=l.scene_index AND e.face_index=l.face_index AND e.domain=l.domain "
        "WHERE l.char_id=? AND l.score>=?", (char_id, thr)).fetchall()
    if rows:
        return _remap_to_plans(con, rows, cache)
    from . import characters, faces
    by_dom = {dom: [f for _cid, f in samp]
              for dom, samp in characters._samples_by_domain(con, char_id).items()}
    if by_dom:
        live = faces._search_by_domain_feats(by_dom, con, top_k=20000, min_score=thr)
        face_rows = [(h["file_path"], h["scene_index"], h.get("mid_frame"),
                      h.get("start_frame"), h.get("end_frame"), h.get("score") or 0.0)
                     for h in (live.get("hits") or [])]
        return _remap_to_plans(con, face_rows, cache)
    return {}


def _char_pool_cascade(con, char_id, cache):
    """Pool au seuil nominal CHAR_POOL_THR ; s'il est VIDE, repli au seuil officiel 0.5 des
    moteurs (mieux vaut des plans un peu moins sûrs qu'une erreur sèche alors que des labels
    existent juste sous le seuil)."""
    pool = _char_pool(con, char_id, CHAR_POOL_THR, cache)
    if pool or CHAR_POOL_THR <= 0.5:
        return pool
    return _char_pool(con, char_id, 0.5, cache)


def _pool_hits(con, allowed, score_map, char, top_k):
    """Plans du pool perso (SANS texte de recherche) → hits format standard, triés par meilleur
    score de reconnaissance (déjà porté par le pool remappé — aucune requête par plan). Un plan
    du pool absent de l'index de plans est simplement sauté."""
    scored = sorted(((score_map.get((fp, si), 0.0), fp, si) for fp, si in allowed), reverse=True)
    hits = []
    for sc, fp, si in scored[: int(top_k or 200)]:
        r = con.execute(
            "SELECT start_frame, end_frame, mid_frame, start_sec, end_sec, fps, src_frames "
            "FROM frame_embeddings_v1 WHERE file_path=? AND model=? AND scene_index=? LIMIT 1",
            (fp, MODEL_TAG, si)).fetchone()
        if not r:
            continue
        hits.append({"file_path": fp, "scene_index": si, "start_frame": r[0], "end_frame": r[1],
                     "mid_frame": r[2], "start_sec": r[3], "end_sec": r[4], "fps": r[5],
                     "src_frames": r[6], "score": sc, "char": char})
    return {"hits": hits, "error": None}


def _co_occurrence(pools, file_paths):
    """Plans réunissant le PLUS GRAND nombre possible de personnages cités → (plans, ce nombre).

    L'intersection stricte reste la réponse attendue. Mais rendre une erreur sèche quand elle est
    vide cachait les plans où 2 des 3 persos cités sont bel et bien ensemble : on dégrade d'un cran
    et on le DIT (notice), au lieu de ne rien montrer.
    """
    wanted = set(str(p) for p in file_paths) if file_paths is not None else None
    counts = {}
    for pool in pools:
        for key in pool:
            if wanted is not None and key[0] not in wanted:
                continue
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return set(), 0
    best = max(counts.values())
    return {key for key, n in counts.items() if n == best}, best


def _joint_confidence(allowed, pools):
    """Confiance qu'un plan réunit VRAIMENT les persos cités = la PLUS FAIBLE des reconnaissances
    qui le retiennent. Le MAX d'avant faisait passer devant un plan où A est certain et B limite,
    alors que c'est exactement le cas douteux."""
    joint = {}
    for key in allowed:
        scores = [pool[key] for pool in pools if key in pool]
        joint[key] = min(scores) if scores else 0.0
    return joint


def _char_filtered_search(con, q_pos, top_k, min_score, q_neg, beta, aesthetic, char_ids, file_paths=None):
    """Recherche RESTREINTE au pool de plans des personnages cités. Chaque pool est REMAPPÉ dans
    l'espace scene_index de l'index de plans (_remap_to_plans) → l'intersection tombe sur les bons
    plans même si l'index visages a été bâti sur une autre découpe. Sans texte : renvoie le pool
    trié par confiance de reconnaissance ; avec texte : classe l'action sur la matrice COMPLÈTE de
    ce pool, la confiance de reconnaissance pesant en second (cf. IDENTITY_WEIGHT) — sur une action
    peu discriminante, tous les cosinus se tiennent et le classement n'était plus que du bruit."""
    cache = {}
    pools = [_char_pool_cascade(con, cid, cache) for cid in char_ids]
    empty = [char_ids[i] for i, p in enumerate(pools) if not p]
    if empty:
        names = [r[0] for cid in empty
                 for r in con.execute("SELECT name FROM characters_v1 WHERE id=?", (cid,)).fetchall()]
        who = ", ".join(names) if names else t("cited_character")
        n_lbl = con.execute("SELECT COUNT(*) FROM face_labels_v1 WHERE char_id IN (%s)"
                            % ",".join("?" * len(empty)), empty).fetchone()[0]
        if n_lbl:
            return {"hits": [], "error": t("no_confident_shot", who=who)}
        return {"hits": [], "error": t("no_recognized_shot", who=who)}
    allowed, covered = _co_occurrence(pools, file_paths)
    crow = con.execute("SELECT id, name, color FROM characters_v1 WHERE id=?", (char_ids[0],)).fetchone()
    char = {"id": crow[0], "name": crow[1], "color": crow[2]} if crow else None
    if not allowed:
        return {"hits": [], "error": t("no_shared_shot")}
    score_map = _joint_confidence(allowed, pools)
    if q_pos is None:
        out = _pool_hits(con, allowed, score_map, char, top_k)
    else:
        res = STORE.search_scoped(q_pos, allowed, top_k, min_score, q_neg, beta, aesthetic,
                                  identity=score_map, identity_weight=IDENTITY_WEIGHT)
        out = {"hits": [dict(h, char=char) for h in (res.get("hits") or [])], "error": res.get("error")}
    if covered < len(pools):
        out["notice"] = t("partial_character_overlap", found=covered, total=len(pools))
    return out


_SCOPE_COLS = ("rowid, file_path, scene_index, start_frame, end_frame, mid_frame, "
               "start_sec, end_sec, fps, src_frames, embedding")


def _scope_rows(con, scenes=None, file_path=None, limit=None):
    base = "SELECT %s FROM frame_embeddings_v1 WHERE model=?" % _SCOPE_COLS
    if scenes:
        clause = " AND (" + " OR ".join(["(file_path=? AND scene_index=?)"] * len(scenes)) + ")"
        params = [MODEL_TAG]
        for s in scenes:
            params += [s.get("file_path"), int(s.get("scene_index", 0))]
        return con.execute(base + clause, params).fetchall()
    if file_path:
        return con.execute(base + " AND file_path=? ORDER BY scene_index", (MODEL_TAG, file_path)).fetchall()
    q = base + " ORDER BY rowid"
    if limit:
        return con.execute(q + " LIMIT ?", (MODEL_TAG, limit)).fetchall()
    return con.execute(q, (MODEL_TAG,)).fetchall()


def _row_to_hit(r, score=None, aesthetic=None):
    h = {"file_path": r[1], "scene_index": r[2], "start_frame": r[3], "end_frame": r[4],
         "mid_frame": r[5], "start_sec": r[6], "end_sec": r[7], "fps": r[8], "src_frames": r[9],
         "score": score}
    if aesthetic is not None:
        h["aesthetic"] = aesthetic
    return h


def cmd_dedup(req):
    """Groupe les prises quasi-identiques (cosinus ≥ threshold) par union-find. Ancre = plan le
    plus central du groupe. Ne renvoie que les groupes de taille ≥ 2 (les vrais doublons)."""
    threshold = float(req.get("threshold", DEDUP_THR))
    scenes = req.get("scenes")
    file_path = req.get("file_path")
    whole = not scenes and not file_path
    con = db_emb()
    try:
        purge_malformed_embeddings(con)
        rows = usable_embeddings(_scope_rows(con, scenes, file_path), 10)
        n = len(rows)
        truncated = False
        if whole and n > 20000:  # garde-fou base entière : matrice N×N trop grosse
            rows = rows[:20000]; n = 20000; truncated = True
        if n < 2:
            return {"groups": [], "truncated": truncated, "error": None}
        vecs = np.stack([np.frombuffer(r[10], dtype=np.float32) for r in rows]).astype(np.float32)
        parent = list(range(n))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]; a = parent[a]
            return a

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)

        CH = 2048  # chunke la similarité par blocs de lignes (pic RAM borné)
        for i0 in range(0, n, CH):
            block = vecs[i0:i0 + CH]
            sims = block @ vecs.T
            for bi in range(block.shape[0]):
                gi = i0 + bi
                for j in np.nonzero(sims[bi] >= threshold)[0]:
                    j = int(j)
                    if j > gi:
                        union(gi, j)
        groups = {}
        for i in range(n):
            groups.setdefault(find(i), []).append(i)
        out = []
        for members in groups.values():
            if len(members) < 2:
                continue
            sub = vecs[members]
            centrality = (sub @ sub.T).sum(axis=1)  # plan le plus central = meilleure ancre
            order = np.argsort(-centrality)
            ms = [members[o] for o in order]
            out.append({"anchor": _row_to_hit(rows[ms[0]]),
                        "members": [_row_to_hit(rows[m]) for m in ms], "size": len(ms)})
        out.sort(key=lambda g: g["size"], reverse=True)
        return {"groups": out, "truncated": truncated, "error": None}
    finally:
        con.close()


def _kmeans_one(vecs, k, iters=25, seed=0):
    """k-means cosinus (vecteurs L2-normalisés → cos = produit scalaire), numpy pur."""
    n = vecs.shape[0]
    rng = np.random.RandomState(seed)
    centers = vecs[rng.choice(n, k, replace=False)].copy()
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        new = np.argmax(vecs @ centers.T, axis=1)
        if np.array_equal(new, labels):
            break
        labels = new
        for c in range(k):
            m = vecs[labels == c]
            if len(m):
                ctr = m.mean(axis=0); nrm = float(np.linalg.norm(ctr))
                centers[c] = ctr / nrm if nrm > 0 else ctr
    return labels, centers


def _silhouette(vecs, labels):
    """Score de silhouette (distance cosinus) sur échantillon ≤600 → choix automatique de k."""
    n = len(vecs)
    if n > 600:
        idx = np.linspace(0, n - 1, 600).astype(int)
        vecs = vecs[idx]; labels = labels[idx]; n = len(vecs)
    uniq = np.unique(labels)
    if len(uniq) < 2:
        return -1.0
    D = np.clip(1.0 - (vecs @ vecs.T), 0.0, 2.0)
    total = 0.0
    for i in range(n):
        same = labels == labels[i]; same[i] = False
        a = D[i, same].mean() if same.any() else 0.0
        b = min((D[i, labels == c].mean() for c in uniq if c != labels[i]), default=0.0)
        total += 0.0 if max(a, b) == 0 else (b - a) / max(a, b)
    return total / n


def _kmeans_auto(vecs, k_req=None):
    n = vecs.shape[0]
    if k_req:
        k = max(1, min(int(k_req), n))
        return _kmeans_one(vecs, k)
    cand = [c for c in (2, 3, 4, 5, 6, 8, 10, 12) if c < n]
    if not cand:
        return np.zeros(n, dtype=int), vecs.mean(axis=0, keepdims=True)
    best = None
    for k in cand:
        labels, centers = _kmeans_one(vecs, k)
        s = _silhouette(vecs, labels)
        if best is None or s > best[0]:
            best = (s, labels, centers)
    return best[1], best[2]


def cmd_cluster(req):
    """Regroupe les plans par similarité visuelle (k-means cosinus, k auto via silhouette) →
    vue moodboard par ambiance. Représentant = plan le plus proche du centroïde."""
    scenes = req.get("scenes")
    file_path = req.get("file_path")
    k_req = req.get("k")
    con = db_emb()
    try:
        purge_malformed_embeddings(con)
        rows = usable_embeddings(
            _scope_rows(con, scenes, file_path, limit=(None if (scenes or file_path) else 5000)), 10)
        n = len(rows)
        if n == 0:
            return {"clusters": [], "error": None}
        vecs = np.stack([np.frombuffer(r[10], dtype=np.float32) for r in rows]).astype(np.float32)
        if n <= 2:
            labels = np.zeros(n, dtype=int)
        else:
            labels, _centers = _kmeans_auto(vecs, k_req)
        clusters = []
        for c in np.unique(labels):
            members = [i for i in range(n) if labels[i] == c]
            if not members:
                continue
            sub = vecs[members]
            center = sub.mean(axis=0); nrm = float(np.linalg.norm(center))
            center = center / nrm if nrm > 0 else center
            order = np.argsort(-(sub @ center))  # tri par proximité au centre du cluster
            hits = [_row_to_hit(rows[members[o]]) for o in order]
            clusters.append({"size": len(hits), "rep": hits[0], "members": hits})
        clusters.sort(key=lambda g: g["size"], reverse=True)
        for idx, cl in enumerate(clusters):
            cl["label"] = "Groupe %d" % (idx + 1)
        return {"clusters": clusters, "error": None}
    finally:
        con.close()
