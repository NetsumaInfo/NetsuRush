"""Backend de recherche : index vectoriel en RAM (accélérateur reconstructible), SQLite = vérité.
  - BruteForce : matrice (N, dim), score = matrice @ requête. Exact, défaut.
  - FaissIndex : IVFPQ COMPRESSÉ (faiss-cpu, ~64 o/plan). Bascule AUTO au-delà du budget RAM,
                 persisté + rejoué au boot. faiss absent → retombe sur BruteForce.
Le daemon garde l'index en RAM ; chaque requête se resynchronise paresseusement avec SQLite
(COUNT/MAX(rowid)) → ajouts incrémentaux, rebuild complet seulement sur suppression/ré-index."""
import json
import math
import os
import sys

import numpy as np

from detect import db_path

from . import model
from .config import (ADD_BATCH, FAISS_FLOOR, FAISS_THRESHOLD_FIXED, MODEL_TAG,
                     PQ_NBITS, RAM_FRACTION, TRAIN_CAP)
from .db import db_emb, purge_malformed_embeddings, usable_embeddings

_HAS_FAISS = None


def _faiss_ok():
    """faiss-cpu présent ? (note unique sur stderr sinon). Détermine si le tier FAISS est dispo."""
    global _HAS_FAISS
    if _HAS_FAISS is None:
        try:
            import faiss  # noqa: F401
            _HAS_FAISS = True
        except Exception:  # noqa: BLE001
            _HAS_FAISS = False
            sys.stderr.write("FAISS indisponible → backend brute-force (pip install faiss-cpu)\n")
            sys.stderr.flush()
    return _HAS_FAISS


def _faiss_paths():
    base = os.path.join(os.path.dirname(db_path()), "faiss_%s" % MODEL_TAG)
    return base + ".index", base + ".json"


def _total_ram_bytes():
    """RAM physique totale (sans dépendance : ctypes Windows / sysconf POSIX, fallback 8 Go)."""
    try:
        import ctypes
        if sys.platform == "win32":
            class _MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = _MS(); ms.dwLength = ctypes.sizeof(_MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                return int(ms.ullTotalPhys)
    except Exception:  # noqa: BLE001
        pass
    try:
        return int(os.sysconf("SC_PHYS_PAGES")) * int(os.sysconf("SC_PAGE_SIZE"))
    except (ValueError, AttributeError, OSError):
        return 8 * 1024 ** 3


def _zscore(values):
    """Centre-réduit un signal de tri. Écart-type nul = le signal n'ordonne rien → il ne pèse pas
    (sinon une division par ~0 le ferait exploser devant l'autre)."""
    std = float(values.std())
    if std < 1e-6:
        return np.zeros_like(values, dtype=np.float32)
    return ((values - float(values.mean())) / std).astype(np.float32)


def _relative(values):
    """Signal de tri sans unité → score affichable 0..1 (min-max sur le lot rendu). Tout le lot à
    égalité = tout à 1 (aucun ordre à suggérer)."""
    lo, hi = float(min(values)), float(max(values))
    if hi <= lo:
        return [1.0] * len(values)
    return [(float(v) - lo) / (hi - lo) for v in values]


def _pq_m(dim):
    """Nombre de sous-quantiseurs PQ : plus grand diviseur de dim ≤ 64 (taille de code = m octets)."""
    for m in (64, 48, 32, 24, 16, 12, 8, 4, 2, 1):
        if dim % m == 0:
            return m
    return 1


class BruteForce:
    """Matrice (N, dim) en RAM, score = matrice @ requête (BLAS multi-thread). Tier par défaut."""

    def __init__(self, dim):
        self.dim = dim
        self._mat = np.empty((0, dim), dtype=np.float32)
        self._ids = np.empty((0,), dtype=np.int64)

    def add(self, ids, vecs):
        vecs = np.ascontiguousarray(vecs, dtype=np.float32)
        self._mat = vecs if self._mat.shape[0] == 0 else np.vstack([self._mat, vecs])
        self._ids = np.concatenate([self._ids, np.asarray(ids, dtype=np.int64)])

    def search(self, q, top_k):
        if self._mat.shape[0] == 0:
            return np.empty(0, np.int64), np.empty(0, np.float32)
        sims = self._mat @ q
        k = min(max(1, top_k), sims.shape[0])
        part = np.argpartition(-sims, k - 1)[:k]
        order = part[np.argsort(-sims[part])]
        return self._ids[order], sims[order]

    def search_dual(self, q_pos, q_neg, beta, top_k):
        """Requête négative EXACTE sur toute la matrice : classement par cos(pos)−β·cos(neg).
        Renvoie (ids, cos_pos, combiné) — le cos_pos sert au score affiché, le combiné au tri."""
        if self._mat.shape[0] == 0:
            return np.empty(0, np.int64), np.empty(0, np.float32), np.empty(0, np.float32)
        cos_pos = self._mat @ q_pos
        comb = cos_pos - beta * (self._mat @ q_neg)
        k = min(max(1, top_k), comb.shape[0])
        part = np.argpartition(-comb, k - 1)[:k]
        order = part[np.argsort(-comb[part])]
        return self._ids[order], cos_pos[order], comb[order]

    def size(self):
        return int(self._mat.shape[0])


class FaissIndex:
    """Index IVFPQ COMPRESSÉ (faiss-cpu), ids = rowid SQLite. Codes PQ ~m octets/plan (vs dim×4
    en brute) → la RAM cesse d'être le mur. Recherche approchée (nprobe), ajout incrémental après
    entraînement, persistance disque."""

    def __init__(self, dim, n_hint=0, index=None):
        import faiss
        self._faiss = faiss
        self.dim = dim
        if index is not None:
            self._index = index
            self.nlist = int(getattr(index, "nlist", 0))
            return
        # nlist ~ 4·√N, borné pour que l'échantillon d'entraînement (≤ TRAIN_CAP) reste ≥ ~40/centroïde
        nlist = int(4 * math.sqrt(max(1, n_hint)))
        nlist = max(64, min(nlist, max(64, TRAIN_CAP // 40), 65536))
        self.nlist = nlist
        quant = faiss.IndexFlatIP(dim)
        idx = faiss.IndexIVFPQ(quant, dim, nlist, _pq_m(dim), PQ_NBITS, faiss.METRIC_INNER_PRODUCT)
        idx.nprobe = max(8, min(nlist, 128))  # compromis recall/vitesse
        self._index = idx

    def train(self, vecs):
        self._index.train(np.ascontiguousarray(vecs, dtype=np.float32))

    def add(self, ids, vecs):
        self._index.add_with_ids(
            np.ascontiguousarray(vecs, dtype=np.float32),
            np.ascontiguousarray(ids, dtype=np.int64),
        )

    def search(self, q, top_k):
        n = self.size()
        if n == 0:
            return np.empty(0, np.int64), np.empty(0, np.float32)
        k = min(max(1, top_k), n)
        d, i = self._index.search(np.ascontiguousarray(q.reshape(1, -1), dtype=np.float32), k)
        ids, scores = i[0], d[0]
        mask = ids >= 0  # -1 quand moins de k voisins trouvés
        return ids[mask].astype(np.int64), scores[mask].astype(np.float32)

    def size(self):
        return int(self._index.ntotal)

    def save(self, path):
        tmp = path + ".tmp"
        self._faiss.write_index(self._index, tmp)
        os.replace(tmp, path)  # rename atomique

    @classmethod
    def load(cls, dim, path):
        import faiss
        return cls(dim, index=faiss.read_index(path))


class SearchStore:
    """Gère l'index RAM + sa synchronisation paresseuse avec SQLite (source de vérité).
    Choisit le backend selon la taille, persiste/recharge l'index FAISS."""

    def __init__(self):
        self.backend = None
        self.dim = None
        self.kind = None        # "brute" | "faiss"
        self.loaded_count = 0
        self.loaded_max = 0     # plus grand rowid chargé (watermark)

    def _reset(self):
        self.backend = None; self.dim = None; self.kind = None
        self.loaded_count = 0; self.loaded_max = 0

    def _threshold(self):
        """Nb de plans au-delà duquel on bascule en FAISS = ce que la matrice brute peut tenir
        dans le budget RAM (RAM totale × fraction), sauf override fixe par env."""
        if FAISS_THRESHOLD_FIXED is not None:
            return FAISS_THRESHOLD_FIXED
        dim = self.dim or 1152
        return max(FAISS_FLOOR, int(_total_ram_bytes() * RAM_FRACTION / (dim * 4)))

    def _want_faiss(self, count):
        return count >= self._threshold() and _faiss_ok()

    def _read_rows(self, con, extra="", params=()):
        rows = usable_embeddings(con.execute(
            "SELECT rowid, embedding FROM frame_embeddings_v1 WHERE model=?" + extra,
            (MODEL_TAG, *params),
        ).fetchall(), 1)
        if not rows:
            return np.empty(0, np.int64), None
        ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        vecs = np.stack([np.frombuffer(r[1], dtype=np.float32) for r in rows])
        return ids, vecs

    def _persist(self):
        if self.kind != "faiss" or not self.backend or self.backend.size() == 0:
            return
        try:
            ipath, mpath = _faiss_paths()
            self.backend.save(ipath)
            with open(mpath, "w") as f:
                json.dump({"model": MODEL_TAG, "dim": self.dim,
                           "count": self.loaded_count, "max_rowid": self.loaded_max}, f)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("persist FAISS échec: %s\n" % exc); sys.stderr.flush()

    def _try_checkpoint(self, con, count, max_rowid):
        """Recharge l'index FAISS persisté + rejoue la queue SQLite (reconstruction rapide au boot).
        Refuse si suppression détectée sous le watermark (cohérence) → rebuild complet à la place."""
        if not self._want_faiss(count):
            return False
        ipath, mpath = _faiss_paths()
        if not (os.path.exists(ipath) and os.path.exists(mpath)):
            return False
        try:
            with open(mpath) as f:
                meta = json.load(f)
        except Exception:  # noqa: BLE001
            return False
        if meta.get("model") != MODEL_TAG or not meta.get("count"):
            return False
        ckpt_count = int(meta["count"]); ckpt_max = int(meta["max_rowid"]); dim = int(meta["dim"])
        if ckpt_count > count:
            return False
        below = con.execute(
            "SELECT COUNT(*) FROM frame_embeddings_v1 WHERE model=? AND rowid<=?",
            (MODEL_TAG, ckpt_max),
        ).fetchone()[0]
        if below != ckpt_count:  # des lignes ont disparu sous le checkpoint → invalide
            return False
        try:
            self.dim = dim
            self.backend = FaissIndex.load(dim, ipath)
            self.kind = "faiss"
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("read FAISS échec: %s\n" % exc); sys.stderr.flush()
            return False
        self.loaded_count = ckpt_count; self.loaded_max = ckpt_max
        if count > ckpt_count:  # rejoue les plans ajoutés depuis le checkpoint
            ids, vecs = self._read_rows(con, " AND rowid>?", (ckpt_max,))
            if vecs is not None:
                self.backend.add(ids, vecs)
                self.loaded_count = count; self.loaded_max = max_rowid
                self._persist()
        return True

    def _build(self, con, count, max_rowid):
        if self._want_faiss(count):
            self._build_faiss(con, count, max_rowid)
            return
        ids, vecs = self._read_rows(con)
        if vecs is None:
            self._reset(); return
        self.dim = int(vecs.shape[1]); self.kind = "brute"
        self.backend = BruteForce(self.dim)
        self.backend.add(ids, vecs)
        self.loaded_count = count; self.loaded_max = max_rowid

    def _build_faiss(self, con, count, max_rowid):
        """Construit l'index IVFPQ depuis SQLite : lecture par lots (pic RAM borné) → train sur
        un échantillon → ajout de tout. Persiste le checkpoint à la fin."""
        r0 = con.execute(
            "SELECT embedding FROM frame_embeddings_v1 WHERE model=? LIMIT 1", (MODEL_TAG,)
        ).fetchone()
        if not r0:
            self._reset(); return
        self.dim = len(r0[0]) // 4  # float32
        self.kind = "faiss"
        self.backend = FaissIndex(self.dim, n_hint=count)
        n_train = min(count, max(TRAIN_CAP, self.backend.nlist * 40))
        _, tvecs = self._read_rows(con, " ORDER BY rowid LIMIT ?", (n_train,))
        self.backend.train(tvecs)
        offset = 0
        while True:
            ids, vecs = self._read_rows(con, " ORDER BY rowid LIMIT ? OFFSET ?", (ADD_BATCH, offset))
            if vecs is None:
                break
            self.backend.add(ids, vecs)
            offset += vecs.shape[0]
            if vecs.shape[0] < ADD_BATCH:
                break
        self.loaded_count = count; self.loaded_max = max_rowid
        self._persist()

    def _sync(self, con):
        purge_malformed_embeddings(con)   # lignes poubelle (dim aberrante) → np.stack planterait
        count, max_rowid = con.execute(
            "SELECT COUNT(*), COALESCE(MAX(rowid),0) FROM frame_embeddings_v1 WHERE model=?",
            (MODEL_TAG,),
        ).fetchone()
        count = int(count or 0); max_rowid = int(max_rowid or 0)
        if count == 0:
            self._reset(); return
        if self.backend is not None and count == self.loaded_count and max_rowid == self.loaded_max:
            return  # cache frais
        if self.backend is None and self._try_checkpoint(con, count, max_rowid):
            return  # boot à froid sur index FAISS persisté
        # ajout incrémental : que des nouveaux rowid au-dessus du watermark, même tier de backend
        if (self.backend is not None and max_rowid > self.loaded_max and count > self.loaded_count
                and self._want_faiss(count) == (self.kind == "faiss")):
            ids, vecs = self._read_rows(con, " AND rowid>?", (self.loaded_max,))
            n_new = 0 if vecs is None else vecs.shape[0]
            if n_new == count - self.loaded_count:  # aucune suppression → simple append
                if vecs is not None:
                    self.backend.add(ids, vecs)
                self.loaded_count = count; self.loaded_max = max_rowid
                return
        self._build(con, count, max_rowid)  # suppression / ré-index / changement de tier

    def warm(self):
        """Synchronise l'index RAM avant la première requête visible."""
        con = db_emb()
        try:
            self._sync(con)
            return {"ok": True, "count": self.loaded_count, "backend": self.kind, "error": None}
        finally:
            con.close()

    def search(self, q_pos, top_k, min_score=0.0, q_neg=None, beta=0.4, aesthetic=False):
        """q_pos = vecteur requête (déjà L2-normalisé). q_neg (optionnel) = requête négative :
        classement par cos(pos)−β·cos(neg). `score` renvoyé = cosinus positif CALIBRÉ en % (sert
        au slider). min_score filtre sur ce score calibré. aesthetic=True attache cos(net)−cos(flou)."""
        con = db_emb()
        try:
            self._sync(con)
            if self.backend is None or self.backend.size() == 0:
                return {"hits": [], "error": None}
            q_pos = q_pos.astype(np.float32)
            if q_neg is not None and self.kind == "brute":
                ids, cos_pos, _comb = self.backend.search_dual(q_pos, q_neg.astype(np.float32), beta, max(1, top_k))
            else:
                qv = q_pos
                if q_neg is not None:  # FAISS : scores non séparables → vecteur fusionné (approché)
                    qv = q_pos - beta * q_neg.astype(np.float32)
                    nrm = float(np.linalg.norm(qv))
                    qv = (qv / nrm).astype(np.float32) if nrm > 0 else q_pos
                ids, cos_pos = self.backend.search(qv, max(1, top_k))
            keep = []  # (rowid, score_calibré) dans l'ordre de pertinence
            for idx in range(len(ids)):
                cal = model.calibrate(cos_pos[idx])
                if cal >= min_score:
                    keep.append((int(ids[idx]), cal))
            if not keep:
                return {"hits": [], "error": None}
            idset = [i for i, _ in keep]
            ph = ",".join("?" * len(idset))
            cols = ("rowid, file_path, scene_index, start_frame, end_frame, mid_frame, "
                    "start_sec, end_sec, fps, src_frames")
            if aesthetic:
                cols += ", embedding"
            meta = {}
            for r in con.execute(
                "SELECT %s FROM frame_embeddings_v1 WHERE model=? AND rowid IN (%s)" % (cols, ph),
                (MODEL_TAG, *idset),
            ):
                meta[int(r[0])] = r
            gv = bv = None
            if aesthetic:
                gv, bv = model.aesthetic_vecs()
            hits = []
            for i, cal in keep:
                r = meta.get(i)
                if r is None:
                    continue
                hit = {
                    "file_path": r[1], "scene_index": r[2],
                    "start_frame": r[3], "end_frame": r[4], "mid_frame": r[5],
                    "start_sec": r[6], "end_sec": r[7], "fps": r[8], "src_frames": r[9],
                    "score": cal,
                }
                if aesthetic and gv is not None and r[10] is not None:
                    v = np.frombuffer(r[10], dtype=np.float32)
                    hit["aesthetic"] = float(v @ gv - v @ bv)
                hits.append(hit)
            return {"hits": hits, "error": None}
        finally:
            con.close()

    def search_scoped(self, q_pos, allowed, top_k, min_score=0.0, q_neg=None, beta=0.4,
                      aesthetic=False, file_paths=None, identity=None, identity_weight=0.0):
        """Classe EXACTEMENT les plans ``allowed`` seulement.

        Contrairement à ``search`` (index global), ce chemin charge la petite matrice déjà filtrée
        par identité et calcule l'action sur tous ses plans. La table TEMP évite la limite SQLite
        sur le nombre de paramètres quand le pool personnage contient des milliers de plans.

        ``identity`` = {(file_path, scene_index): confiance de reconnaissance} et ``identity_weight``
        son poids dans le TRI : les deux signaux sont centrés-réduits avant d'être additionnés (leurs
        échelles n'ont rien à voir). Le score AFFICHÉ reste le cosinus d'action calibré — c'est lui
        que filtre le curseur de pertinence.
        """
        keys = list(allowed) if allowed is not None else []
        paths = list(dict.fromkeys(str(p) for p in (file_paths or []) if p)) if file_paths is not None else None
        if paths is None and not keys:
            return {"hits": [], "error": None}
        if paths is not None and not paths:
            return {"hits": [], "error": None}
        con = db_emb()
        try:
            purge_malformed_embeddings(con)
            cols = ("SELECT f.rowid, f.file_path, f.scene_index, f.start_frame, f.end_frame, "
                    "f.mid_frame, f.start_sec, f.end_sec, f.fps, f.src_frames, f.embedding ")
            if paths is not None:
                con.execute("CREATE TEMP TABLE nr_search_paths(file_path TEXT PRIMARY KEY) WITHOUT ROWID")
                con.executemany("INSERT OR IGNORE INTO nr_search_paths VALUES (?)", ((p,) for p in paths))
                rows = con.execute(
                    cols + "FROM frame_embeddings_v1 f JOIN nr_search_paths s ON s.file_path=f.file_path "
                    "WHERE f.model=?", (MODEL_TAG,)).fetchall()
            else:
                con.execute(
                    "CREATE TEMP TABLE nr_search_scope("
                    "file_path TEXT, scene_index INTEGER, PRIMARY KEY(file_path, scene_index)) WITHOUT ROWID"
                )
                con.executemany("INSERT OR IGNORE INTO nr_search_scope VALUES (?,?)", keys)
                rows = con.execute(
                    cols + "FROM frame_embeddings_v1 f JOIN nr_search_scope s "
                    "ON s.file_path=f.file_path AND s.scene_index=f.scene_index WHERE f.model=?",
                    (MODEL_TAG,),
                ).fetchall()
            rows = usable_embeddings(rows, 10)
            if not rows:
                return {"hits": [], "error": None}

            vecs = np.stack([np.frombuffer(r[10], dtype=np.float32) for r in rows]).astype(np.float32)
            q_pos = q_pos.astype(np.float32)
            cos_pos = vecs @ q_pos
            ranking = cos_pos
            if q_neg is not None:
                ranking = cos_pos - beta * (vecs @ q_neg.astype(np.float32))
            fused = None
            if identity and identity_weight > 0:
                conf = np.asarray([float(identity.get((r[1], r[2]), 0.0)) for r in rows], np.float32)
                fused = _zscore(ranking) + float(identity_weight) * _zscore(conf)
                ranking = fused
            k = min(max(1, int(top_k)), len(rows))
            part = np.argpartition(-ranking, k - 1)[:k]
            order = part[np.argsort(-ranking[part])]

            # Le seuil de pertinence porte sur l'ACTION (cosinus calibré), jamais sur le classement
            # fusionné : celui-ci est centré-réduit, donc négatif pour la moitié du lot.
            keep = [(int(idx), model.calibrate(cos_pos[int(idx)])) for idx in order]
            keep = [(idx, cal) for idx, cal in keep if cal >= min_score]
            if not keep:
                return {"hits": [], "error": None}
            # Fusion active : le score AFFICHÉ suit le classement rendu (relatif au lot), sinon le
            # badge de pertinence contredirait l'ordre des cartes.
            shown = (_relative([fused[idx] for idx, _cal in keep]) if fused is not None
                     else [cal for _idx, cal in keep])

            gv = bv = None
            if aesthetic:
                gv, bv = model.aesthetic_vecs()
            hits = []
            for (idx, _cal), score in zip(keep, shown):
                r = rows[idx]
                hit = {
                    "file_path": r[1], "scene_index": r[2],
                    "start_frame": r[3], "end_frame": r[4], "mid_frame": r[5],
                    "start_sec": r[6], "end_sec": r[7], "fps": r[8], "src_frames": r[9],
                    "score": score,
                }
                if aesthetic and gv is not None:
                    hit["aesthetic"] = float(vecs[idx] @ gv - vecs[idx] @ bv)
                hits.append(hit)
            return {"hits": hits, "error": None}
        finally:
            con.close()

    def search_paths(self, q_pos, file_paths, top_k, min_score=0.0, q_neg=None, beta=0.4,
                     aesthetic=False):
        """Recherche exacte limitée aux médias du projet courant."""
        return self.search_scoped(q_pos, None, top_k, min_score, q_neg, beta, aesthetic,
                                  file_paths=file_paths)


STORE = SearchStore()
