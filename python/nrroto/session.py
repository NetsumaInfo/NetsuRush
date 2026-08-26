"""Session Roto : tient l'état d'UNE vidéo entre les requêtes (frames extraites,
points par (frame, objet), moteur SAM2, mattes propagées sur disque). Orchestration seulement —
l'inférence vit dans sam_engine, le rendu dans overlay, l'export dans export_alpha.

Perf ouverture :
- CACHE DE SESSION par vidéo (NETSURUSH_ROTO_CACHE/<sha1 path|mtime|taille|in|out>) : frames,
  mattes ET points survivent aux changements dans NetsuRush, puis sont supprimés à la fermeture.
- EXTRACTION EN THREAD : open() répond dès la 1re frame écrite (ready:false) ; le renderer scrub
  pendant que ffmpeg continue (STAGE:prog puis STAGE:extractdone:N). SAM attend la fin (join).

Corrections (réimplémentation propre : aucun code GPL) : re-propagation PARTIELLE directionnelle
depuis la frame courante (sans effacer le suivi existant), annulation par fichier cancel.flag,
undo du dernier point, preview d'un point candidat (pose → capture → revert par re-pose des points
réels), post-traitement NON destructif des masques (postproc), ROI auto pour le matte fin (roi)."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from nri18n import t

from nrroto import dedupe as dedupe_mod, export_alpha, matte as matte_mod, overlay, postproc, roi as roi_mod
from nrroto.sam_engine import SamEngine
from nrroto.sam3_engine import Sam3Engine

FFMPEG = os.environ.get("NETSURUSH_FFMPEG", "ffmpeg")
MAX_W = 1920  # plafond d'extraction (SAM travaille en 1024 de toute façon ; l'alpha est recalé à l'export)
CACHE_ROOT = os.environ.get("NETSURUSH_ROTO_CACHE", "") or os.path.join(tempfile.gettempdir(), "nr-roto-cache")
CACHE_KEEP = 6  # sessions gardées sur disque (LRU par mtime)

# Moteurs de suppression d'objet CÂBLÉS : id → (env des poids, libellé).
# `minimax-remover` (CC-BY-NC, diffusion vidéo cohérente temporellement) est le seul câblé depuis le
# retrait de Big LaMa, dont l'inpainting image par image faisait scintiller le fond d'une image à
# l'autre. diffueraser/powerpaint : pas câblés → refus explicite plutôt qu'un plantage obscur.
DEFAULT_REMOVE_ENGINE = "minimax-remover"
REMOVE_ENGINES = {
    "minimax-remover": ("NETSURUSH_MINIMAX_DIR", "MiniMax-Remover"),
}

# Le moteur de segmentation dépend de la GÉNÉRATION du modèle choisi : SAM 3 ne parle pas l'API de
# SAM 2 (sessions tenues par le paquet amont, pilotage par requêtes) — l'écart est absorbé par
# `Sam3Engine`, qui expose la même interface. Les forks SAM 2 (SAMURAI, SAM2Long) réutilisent l'API
# ET les poids de SAM 2.1 : ils passent par `SamEngine` sans une ligne de plus.
SAM3_MODELS = {"sam3.1"}

# Moteurs de matte fin qui travaillent par LOTS au lieu de propager une mémoire : ils n'ont pas de
# graine, reçoivent un masque par image, et se règlent en taille de lot + recouvrement. L'écart est
# absorbé par `_refine_batched` ; le reste de la chaîne (ROI, alpha doux, bascule) est commun.
VIDEOMAMA_ENGINES = {"videomama"}


def _make_engine(model):
    return Sam3Engine() if str(model or "") in SAM3_MODELS else SamEngine()


# Raccord de la zone effacée (cf. nrroto.harmonize). Actifs par défaut : sans eux la retouche se
# voit — la correction couleur est presque toujours souhaitable, et le grain s'auto-annule sur une
# source propre puisqu'il est mesuré sur la couronne.
DEFAULT_HARMONIZE = 85
DEFAULT_GRAIN = 100


def _stage(msg):
    sys.stderr.write("STAGE:%s\n" % msg)
    sys.stderr.flush()


def _percent(value, fallback):
    """Réglage d'interface 0..100 → facteur 0..1, borné. `None` = valeur par défaut du produit."""
    try:
        raw = fallback if value is None else float(value)
    except (TypeError, ValueError):
        raw = fallback
    return max(0.0, min(1.0, raw / 100.0))


def _cache_key(video, in_s, out_s):
    try:
        st = os.stat(video)
        sig = "%s|%d|%d|%s|%s|%d" % (video, int(st.st_mtime), st.st_size, in_s, out_s, MAX_W)
    except OSError:
        sig = "%s|%s|%s|%d" % (video, in_s, out_s, MAX_W)
    return hashlib.sha1(sig.encode("utf-8")).hexdigest()[:20]


def _prune_cache(keep_key):
    """Garde les CACHE_KEEP sessions les plus récentes (l'active toujours incluse)."""
    try:
        dirs = [(os.path.getmtime(os.path.join(CACHE_ROOT, d)), d) for d in os.listdir(CACHE_ROOT)
                if os.path.isdir(os.path.join(CACHE_ROOT, d))]
    except OSError:
        return
    dirs.sort(reverse=True)
    for _, d in dirs[CACHE_KEEP:]:
        if d != keep_key:
            shutil.rmtree(os.path.join(CACHE_ROOT, d), ignore_errors=True)


class RotoSession:
    def __init__(self):
        self.engine = SamEngine()
        self.video = None
        self.in_s = None          # borne du plan (source du bac avec in/out)
        self.w = 0                # dimensions SOURCE (les points UI arrivent dans ce repère)
        self.h = 0
        self.scale = 1.0          # source -> frames extraites
        self.fps = 0.0
        self.frames = 0
        self.points = {}          # (frame, obj) -> [(x, y, label)] en pixels source
        self.order = []           # ordre de pose [(frame, obj)] — undo du dernier point
        self.names = {}           # obj -> nom (persisté avec les points, repris à la réouverture)
        self.current = {}         # frame -> {obj: masque} (masques du dernier add/clear, avant propagation)
        self.post = postproc.default_post()   # post-traitement non destructif (overlay + export)
        self.view = {"mode": "edit", "outline": False, "bg": "#00ff00"}   # mode d'affichage du masque
        self.propagated = False
        self.work = None          # dossier de cache de la session (frames/ + mattes/)
        self.sam_dir = None       # dossier de poids SAM demandé (sélecteur UI)
        self.sam_model = None     # id du modèle demandé : décide de la GÉNÉRATION du moteur
        self._extract_thread = None
        self._extract_error = None
        self.frame_manifest = None  # originalToUnique + uniqueToOriginal (JPEG originaux conservés)
        # Matte fin : un alpha DOUX vit à côté des mattes binaires du suivi, jamais à leur place.
        # L'écraser interdirait de comparer et exigerait un suivi complet pour revenir en arrière.
        self.refined = False      # un matte fin a été calculé pour le suivi COURANT
        self.use_refined = True   # ...et l'affichage/export/suppression s'en servent
        self._matte_proc = None   # processeur d'affinage gardé CHAUD entre deux essais
        self._matte_engine = None
        self.matte_batch = 16     # images par lot (moteurs par lots — cf. VIDEOMAMA_ENGINES)
        self.matte_overlap = 2    # images communes à deux lots, fondues pour effacer la jonction
        # Dernier test de matte fin sur 1 image : {frame, alpha}. L'alpha calculé est gardé pour
        # rejouer l'aperçu avec un autre post-traitement sans refaire tourner le modèle.
        self.last_test = None

    # ---- ouverture : cache de session, sinon extraction en thread ----
    def open(self, video, in_s=None, out_s=None, sam_dir=None, sam_model=None):
        from nrproc.media import probe
        if not video or not os.path.exists(video):
            return {"ok": False, "error": t("video_not_found", path=video)}
        w, h, _fps_str, fps, nb = probe(video)
        if not w or not h:
            return {"ok": False, "error": t("video_dimensions", detail="")}
        self.close()
        self.sam_dir = sam_dir
        # Changer de génération change de moteur : on n'essaie pas de recycler l'ancien, ses poids et
        # son état de session n'ont rien à voir.
        if str(sam_model or "") != str(self.sam_model or ""):
            self.engine.unload()
            self.engine = _make_engine(sam_model)
        self.sam_model = sam_model
        self.video, self.w, self.h, self.fps = video, int(w), int(h), float(fps or 24)
        self.in_s = float(in_s) if in_s is not None else None
        self.scale = min(1.0, MAX_W / float(w))
        key = _cache_key(video, in_s, out_s)
        os.makedirs(CACHE_ROOT, exist_ok=True)
        _prune_cache(key)
        self.work = os.path.join(CACHE_ROOT, key)
        frames_dir = self._frames_dir()

        cached = self._try_cache()
        if cached is not None:
            return cached

        # Cache absent/incomplet → repartir propre puis extraire en thread.
        shutil.rmtree(self.work, ignore_errors=True)
        os.makedirs(frames_dir, exist_ok=True)
        dur = (float(nb) / self.fps) if (nb and self.fps) else 0.0
        seg = (float(out_s) - float(in_s)) if (in_s is not None and out_s is not None) \
            else (float(out_s) if out_s is not None else dur)
        total_f = max(1, int(seg * self.fps)) if seg else 1
        _stage("extract")
        self._extract_error = None
        self._extract_thread = threading.Thread(
            target=self._extract, args=(video, in_s, out_s, frames_dir, total_f), daemon=True)
        self._extract_thread.start()
        # Répond dès la 1re frame : le renderer affiche/scrubbe pendant que l'extraction continue.
        t0 = time.time()
        while time.time() - t0 < 20:
            if self._extract_error:
                return {"ok": False, "error": self._extract_error}
            if not self._extract_thread.is_alive() or os.path.isfile(os.path.join(frames_dir, "00000.jpg")):
                break
            time.sleep(0.05)
        if self._extract_error:
            return {"ok": False, "error": self._extract_error}
        self.frames = total_f   # estimation ; corrigée par extractdone (meta + SSE)
        return {"ok": True, "frames": total_f, "w": self.w, "h": self.h, "fps": self.fps,
                "framesDir": frames_dir, "work": self.work, "ready": False, "cached": False,
                "deduped": False}

    def _try_cache(self):
        """Session déjà en cache et complète → restaure frames + points + suivi, zéro extraction."""
        meta_p = os.path.join(self.work, "meta.json")
        frames_dir = self._frames_dir()
        try:
            with open(meta_p, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
            n = int(meta.get("frames") or 0)
            if n <= 0 or len([f for f in os.listdir(frames_dir) if f.endswith(".jpg")]) < n:
                return None
        except (OSError, ValueError):
            return None
        self.frames = n
        self.frame_manifest = dedupe_mod.load_frame_manifest(self.work, frames_dir)
        self._load_points()
        union = os.path.join(self.work, "mattes", "union")
        self.propagated = os.path.isdir(union) and bool(os.listdir(union))
        refined = os.path.join(self._refined_dir(), "union")
        self.refined = os.path.isdir(refined) and bool(os.listdir(refined))
        os.utime(self.work, None)   # touch → LRU
        pts = [{"frame": f, "obj": o, "x": x, "y": y, "label": lb}
               for (f, o) in dict.fromkeys(self.order)
               for (x, y, lb) in self.points.get((f, o), [])] if self.order else \
              [{"frame": f, "obj": o, "x": x, "y": y, "label": lb}
               for (f, o), lst in sorted(self.points.items()) for (x, y, lb) in lst]
        return {"ok": True, "frames": n, "w": self.w, "h": self.h, "fps": self.fps,
                "framesDir": frames_dir, "work": self.work, "ready": True, "cached": True,
                "tracked": self.propagated, "points": pts, "refined": self.refined,
                "names": {str(k): v for k, v in self.names.items()},
                "deduped": os.path.isdir(dedupe_mod.backup_dir(self.work))}

    def _extract(self, video, in_s, out_s, frames_dir, total_f):
        """Thread d'extraction : JPEG 0-based (-start_number 0 → pas de renommage, le renderer lit
        les frames au fil de l'eau), progression sur stderr, meta.json à la fin."""
        args = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
        if in_s is not None:
            args += ["-ss", str(in_s)]
        if out_s is not None:
            args += ["-to" if in_s is None else "-t", str(out_s if in_s is None else float(out_s) - float(in_s))]
        args += ["-i", video, "-q:v", "2"]
        if self.scale < 1.0:
            args += ["-vf", "scale=%d:-2" % MAX_W]
        args += ["-start_number", "0", os.path.join(frames_dir, "%05d.jpg"), "-progress", "pipe:2"]
        try:
            p = subprocess.Popen(args, stderr=subprocess.PIPE, text=True)
        except OSError as exc:
            self._extract_error = t("ffmpeg_missing", error=exc)
            return
        except Exception as exc:  # arg invalide (None…) → ne jamais laisser le thread crasher (open() pendrait)
            self._extract_error = "extraction impossible : %s" % exc
            return
        tail = []
        for line in p.stderr:
            line = line.strip()
            if line.startswith("out_time_us="):
                try:
                    cur = int(int(line.split("=", 1)[1]) / 1e6 * self.fps)
                    _stage("prog:%d/%d" % (min(cur, total_f), total_f))
                except ValueError:
                    pass
            elif line and "=" not in line:
                tail.append(line)
        if p.wait() != 0:
            self._extract_error = ("\n".join(tail) or t("frame_extraction_failed"))[-300:]
            return
        n = len([f for f in os.listdir(frames_dir) if f.endswith(".jpg")])
        if not n:
            self._extract_error = t("no_extracted_frame")
            return
        self.frames = n
        try:
            self.frame_manifest = dedupe_mod.build_frame_manifest(self.work, frames_dir)
            with open(os.path.join(self.work, "meta.json"), "w", encoding="utf-8") as fh:
                json.dump({"frames": n, "uniqueFrames": self.frame_manifest["uniqueCount"],
                           "w": self.w, "h": self.h, "fps": self.fps, "scale": self.scale}, fh)
        except Exception as exc:  # manifeste requis : SAM ne doit jamais voir un mapping incomplet
            self._extract_error = "analyse des frames impossible : %s" % exc
            return
        _stage("extractdone:%d" % n)

    def _wait_extract(self):
        """SAM a besoin de TOUTES les frames (init_state scanne le dossier une fois)."""
        t = self._extract_thread
        if t is not None and t.is_alive():
            _stage("extractwait")
            t.join()
        if self._extract_error:
            raise RuntimeError(self._extract_error)
        if self.frame_manifest is None:
            self.frame_manifest = dedupe_mod.load_frame_manifest(self.work, self._frames_dir())

    def _frames_dir(self):
        return os.path.join(self.work, "frames")

    def _mattes_dir(self):
        d = os.path.join(self.work, "mattes")
        os.makedirs(d, exist_ok=True)
        return d

    def _unique_mattes_dir(self):
        d = os.path.join(self.work, "mattes_unique")
        os.makedirs(d, exist_ok=True)
        return d

    def _refined_dir(self):
        return os.path.join(self.work, "mattes_refined")

    def _matte_root(self):
        """Racine des mattes qui font FOI (affinées ou brutes) — arbitre UNIQUE.

        `mask()`, `_post_dir()` et `object_remove()` la consomment tous : sans ce point unique,
        l'aperçu, l'export et la suppression finiraient par ne plus montrer la même chose."""
        if self.refined and self.use_refined:
            root = self._refined_dir()
            if os.path.isdir(root):
                return root
        return self._mattes_dir()

    def _refined_active(self):
        return self._matte_root() == self._refined_dir()

    def _drop_refined(self):
        """Le matte fin est indexé sur le suivi qui l'a produit : toute nouvelle propagation le
        périme. Le garder afficherait un alpha calculé d'après des mattes qui n'existent plus."""
        shutil.rmtree(self._refined_dir(), ignore_errors=True)
        self.refined = False

    def set_refined(self, on=True):
        """Bascule « utiliser le matte fin » (comparer avant/après sans rien recalculer)."""
        self.use_refined = bool(on)
        return {"ok": True, "refined": self.refined, "useRefined": self.use_refined}

    def _unique_frame(self, frame):
        self._wait_extract()
        mapping = self.frame_manifest["originalToUnique"]
        f = min(max(0, int(frame)), len(mapping) - 1)
        return int(mapping[f])

    def _original_frames(self, unique_frame):
        self._wait_extract()
        groups = self.frame_manifest["uniqueToOriginal"]
        u = min(max(0, int(unique_frame)), len(groups) - 1)
        return [int(f) for f in groups[u]]

    def _cancel_flag(self):
        return os.path.join(self.work, "cancel.flag")

    def _ensure_open(self):
        if self.video is None:
            raise RuntimeError(t("no_video"))
        self._wait_extract()
        if self.engine.state is None:
            _stage("load")
            self.engine.open(dedupe_mod.unique_frames_dir(self.work), sam_dir=self.sam_dir)
            if self.points:
                self._replay()

    # ---- points / masques ----
    def _to_extracted(self, pts):
        return [(x * self.scale, y * self.scale, lb) for (x, y, lb) in pts]

    def _save_points(self):
        try:
            data = {"order": [[f, o] for (f, o) in self.order],
                    "points": {"%d:%d" % k: v for k, v in self.points.items()},
                    "names": {str(k): v for k, v in self.names.items()}}
            with open(os.path.join(self.work, "points.json"), "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        except OSError:
            pass

    def _load_points(self):
        self.points, self.order, self.names = {}, [], {}
        try:
            with open(os.path.join(self.work, "points.json"), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            for k, v in (data.get("points") or {}).items():
                f, o = k.split(":")
                self.points[(int(f), int(o))] = [tuple(p) for p in v]
            self.order = [tuple(e) for e in (data.get("order") or [])]
            self.names = {int(k): str(v) for k, v in (data.get("names") or {}).items()}
        except (OSError, ValueError):
            pass

    def _replay(self):
        """Reset des prompts SAM + re-pose groupée de tous les points (retrait/undo/preview/restore)."""
        self.current = {}
        self.engine.reset_prompts()
        grouped = {}
        for (f, o), pts in sorted(self.points.items()):
            if pts:
                grouped.setdefault((self._unique_frame(f), o), []).extend(pts)
        for (u, o), pts in sorted(grouped.items()):
            masks = self.engine.add_points(u, o, self._to_extracted(pts))
            for f in self._original_frames(u):
                if (f, o) in self.points:
                    self.current.setdefault(f, {}).update(masks)

    def _points_for_unique(self, unique_frame, obj):
        pts = []
        for f in self._original_frames(unique_frame):
            pts.extend(self.points.get((f, int(obj)), []))
        return pts

    def add_point(self, frame, x, y, label, obj=1):
        self._ensure_open()
        key = (int(frame), int(obj))
        self.points.setdefault(key, []).append((float(x), float(y), int(label)))
        self.order.append(key)
        unique = self._unique_frame(frame)
        masks = self.engine.add_points(unique, int(obj), self._to_extracted(self._points_for_unique(unique, obj)))
        for original in self._original_frames(unique):
            if (original, int(obj)) in self.points:
                self.current.setdefault(original, {}).update(masks)
        self.propagated = False
        self._save_points()
        return {"ok": True, "mask": self._render(int(frame), self.current[int(frame)])}

    def preview_point(self, frame, x, y, label, obj=1):
        """Masque « et si je posais ce point ? » (survol Maj) : pose temporaire → capture → revert
        en rejouant les points réels. Ne modifie NI les points NI le suivi."""
        self._ensure_open()
        f, o = int(frame), int(obj)
        unique = self._unique_frame(f)
        pts = self._points_for_unique(unique, o) + [(float(x), float(y), int(label))]
        masks = self.engine.add_points(unique, o, self._to_extracted(pts))
        merged = dict(self.current.get(f, {}))
        merged.update(masks)
        uri = self._render(f, merged)
        self._replay()
        return {"ok": True, "mask": uri}

    def undo_point(self):
        """Retire le DERNIER point posé (Ctrl+Z) puis rejoue le reste."""
        if not self.order:
            return {"ok": False, "error": t("nothing_to_undo")}
        key = self.order.pop()
        pts = self.points.get(key)
        if pts:
            pts.pop()
            if not pts:
                del self.points[key]
        self.propagated = False
        self._save_points()
        if self.engine.state is not None:
            self._replay()
        f = key[0]
        return {"ok": True, "frame": f, "mask": self._render(f, self.current.get(f, {}))}

    def clear_points(self, frame=None, obj=None):
        """Retire les points (d'une frame, d'un objet, ou tout) puis REJOUE les points restants."""
        if self.video is None:
            return {"ok": False, "error": t("no_video")}
        drop = lambda k: ((frame is None or k[0] == int(frame)) and (obj is None or k[1] == int(obj)))  # noqa: E731
        self.points = {k: v for k, v in self.points.items() if not drop(k)}
        self.order = [k for k in self.order if not drop(k)]
        self.current = {}
        self.propagated = False
        self._save_points()
        if self.engine.state is not None:
            self._replay()
        f0 = int(frame) if frame is not None else None
        mask = self._render(f0, self.current.get(f0, {})) if f0 is not None else None
        return {"ok": True, "mask": mask}

    def _frame_path(self, f):
        return os.path.join(self._frames_dir(), "%05d.jpg" % int(f))

    def _render(self, f, masks):
        """Rendu selon le mode d'affichage courant (edit/matte/alpha/bgcolor + contours)."""
        v = self.view
        return overlay.render_view(self._frame_path(f), masks, self.post,
                                   mode=v.get("mode", "edit"), outline=bool(v.get("outline")),
                                   bg=v.get("bg", "#00ff00"))

    def mask(self, frame):
        """Rendu du masque d'une frame : masques live (avant propagation) sinon mattes du disque."""
        if self.video is None:
            return {"ok": False, "error": t("no_video")}
        f = int(frame)
        if self.current.get(f):
            masks = self.current[f]
        elif not self.propagated:
            masks = {}
        elif self._refined_active():
            # Alpha DOUX relu sans seuil : c'est le seul chemin par lequel le travail du modèle
            # d'affinage devient visible à l'écran.
            masks = overlay.load_alpha(self._refined_dir(), f)
        else:
            masks = overlay.load_mattes(self._mattes_dir(), f)
        return {"ok": True, "mask": self._render(f, masks), "full": self.view.get("mode", "edit") != "edit"}

    def set_post(self, grow=None, feather=None, holes=None, dots=None,
                 border=None, smooth=None, gamma=None, harden=None):
        """Post-traitement non destructif (overlay + export). Les mattes propagées ne bougent pas."""
        for k, v in (("grow", grow), ("feather", feather), ("holes", holes), ("dots", dots),
                     ("border", border), ("smooth", smooth), ("harden", harden)):
            if v is not None:
                self.post[k] = int(v)
        if gamma is not None:
            self.post["gamma"] = float(gamma)
        return {"ok": True, "post": dict(self.post)}

    def set_view(self, mode=None, outline=None, bg=None):
        """Mode d'affichage du masque (edit/matte/alpha/bgcolor), contours, couleur de fond."""
        if mode is not None:
            self.view["mode"] = str(mode)
        if outline is not None:
            self.view["outline"] = bool(outline)
        if bg is not None:
            self.view["bg"] = str(bg)
        return {"ok": True, "view": dict(self.view)}

    def set_objects(self, names=None):
        """Noms des objets (id -> nom), persistés avec les points (repris à la réouverture)."""
        if self.video is None:
            return {"ok": False, "error": t("no_video")}
        self.names = {int(k): str(v) for k, v in (names or {}).items()}
        self._save_points()
        return {"ok": True}

    def remove_point(self, frame, obj, index):
        """Retire UN point précis (table des points) puis rejoue les points restants."""
        if self.video is None:
            return {"ok": False, "error": t("no_video")}
        key = (int(frame), int(obj))
        pts = self.points.get(key)
        i = int(index)
        if not pts or i < 0 or i >= len(pts):
            return {"ok": False, "error": t("point_not_found")}
        pts.pop(i)
        if not pts:
            del self.points[key]
        # Retire UNE occurrence de la clé dans l'ordre de pose (undo garde un ordre cohérent).
        for j in range(len(self.order) - 1, -1, -1):
            if self.order[j] == key:
                del self.order[j]
                break
        self.propagated = self.propagated and bool(self.points)
        self._save_points()
        if self.engine.state is not None:
            self._replay()
        f = key[0]
        return {"ok": True, "frame": f, "mask": self._render(f, self.current.get(f, {}))}

    def move_point(self, frame, obj, index, x, y):
        """Déplace UN point (table/glisser sur le viewer) : nouvelle position, même polarité, puis
        rejoue les points restants. Le suivi existant est conservé."""
        if self.video is None:
            return {"ok": False, "error": t("no_video")}
        key = (int(frame), int(obj))
        pts = self.points.get(key)
        i = int(index)
        if not pts or i < 0 or i >= len(pts):
            return {"ok": False, "error": t("point_not_found")}
        lbl = pts[i][2]
        pts[i] = (float(x), float(y), int(lbl))
        self._save_points()
        if self.engine.state is not None:
            self._replay()
        f = key[0]
        return {"ok": True, "frame": f, "mask": self._render(f, self.current.get(f, {}))}

    def clear_tracking(self):
        """Efface les mattes propagées SANS toucher aux points, puis rejoue les points (les masques
        des frames annotées reviennent immédiatement)."""
        if self.video is None:
            return {"ok": False, "error": t("no_video")}
        shutil.rmtree(os.path.join(self.work, "mattes"), ignore_errors=True)
        shutil.rmtree(os.path.join(self.work, "mattes_unique"), ignore_errors=True)
        shutil.rmtree(os.path.join(self.work, "mattes_post"), ignore_errors=True)
        shutil.rmtree(dedupe_mod.backup_dir(self.work), ignore_errors=True)
        self._drop_refined()
        self.propagated = False
        if self.engine.state is not None and self.points:
            self._replay()
        return {"ok": True}

    def dedupe(self, threshold=None, restore=False):
        """Déduplication des mattes (animation) : frames quasi identiques → même matte. `restore`
        remet les mattes d'origine (sauvegardées avant la première dédup)."""
        if restore:
            ok = dedupe_mod.restore(self.work)
            return {"ok": ok, "error": None if ok else t("no_restore")}
        if not self.propagated:
            return {"ok": False, "error": t("track_before_dedupe")}
        thr = float(threshold) if threshold is not None else 0.8
        _stage("dedupe")
        groups, changed = dedupe_mod.run(
            self.work, self._frames_dir(), threshold=thr,
            progress=lambda cur, tot: _stage("prog:%d/%d" % (cur, tot)))
        return {"ok": True, "groups": groups, "changed": changed}

    # ---- propagation / exports ----
    def propagate(self, mode="all", frame=None, in_f=None, out_f=None, count=None):
        """mode=all : suivi complet (avant + arrière depuis les frames annotées, mattes remises à
        zéro). mode=forward|backward : re-propagation PARTIELLE depuis `frame` (correction locale,
        les autres mattes restent) ; `count` = NOMBRE d'images NOUVELLES à suivre (pas-à-pas :
        count=1 avance d'une seule image). in_f/out_f bornent la plage. Annulable via cancel.flag.

        SAM2 ré-émet la frame de DÉPART (déjà annotée) en tête de `propagate_in_video` : on ne la
        compte pas, et on arrête net dans le sink après `count` images NEUVES (indépendant de la
        sémantique exacte de max_frame_num_to_track → pas-à-pas fiable, jamais « tout »)."""
        if not self.points:
            return {"ok": False, "error": t("add_point_first")}
        self._ensure_open()
        # Une propagation partielle repart des mattes pré-déduplication pour ne pas figer les zones
        # hors de sa portée. Une propagation complète va tout réécrire et peut supprimer directement.
        if mode in ("forward", "backward") and os.path.isdir(dedupe_mod.backup_dir(self.work)):
            dedupe_mod.restore(self.work)
        # Toute nouvelle propagation invalide ensuite la sauvegarde/manifeste précédente.
        shutil.rmtree(dedupe_mod.backup_dir(self.work), ignore_errors=True)
        # ...ainsi que le matte fin, calculé d'après les mattes qu'on s'apprête à réécrire.
        self._drop_refined()
        try:
            os.remove(dedupe_mod.manifest_path(self.work))
        except OSError:
            pass
        mattes = self._mattes_dir()
        unique_mattes = self._unique_mattes_dir()
        lo = max(0, int(in_f)) if in_f is not None else 0
        hi = min(self.frames - 1, int(out_f)) if out_f is not None else self.frames - 1
        try:
            os.remove(self._cancel_flag())
        except OSError:
            pass
        canceled = {"v": False}
        done = {"n": 0}
        written = set()
        limit = max(1, int(count)) if count is not None else None
        st = {"start": None, "direction": 1, "total": max(1, hi - lo + 1), "partial": False}

        def sink(f, masks):
            if os.path.exists(self._cancel_flag()):
                canceled["v"] = True
                raise StopIteration
            overlay.save_mattes(unique_mattes, f, masks)
            originals = [o for o in self._original_frames(f) if lo <= o <= hi]
            if st["direction"] < 0:
                originals.reverse()
            if st["partial"]:
                originals = [o for o in originals if
                             (o >= st["start"] if st["direction"] > 0 else o <= st["start"])]
            for original in originals:
                if not st["partial"] and original in written:
                    continue
                dedupe_mod.expand_unique_mattes(unique_mattes, mattes, f, [original])
                written.add(original)
                # SAM ré-émet l'image de départ : elle est reconstruite mais ne compte pas comme pas.
                if st["partial"] and original == st["start"] and done["n"] == 0:
                    _stage("prog:0/%d@%d" % (st["total"], original))
                    continue
                done["n"] += 1
                _stage("prog:%d/%d@%d" % (min(done["n"], st["total"]), st["total"], original))
                if limit is not None and done["n"] >= limit:
                    raise StopIteration

        n = 0
        if mode == "forward" or mode == "backward":
            start = int(frame) if frame is not None else lo
            st["start"] = start
            st["partial"] = True
            st["direction"] = -1 if mode == "backward" else 1
            span = max(0, hi - start) if mode == "forward" else max(0, start - lo)
            start_u = self._unique_frame(start)
            bound_u = self._unique_frame(hi if mode == "forward" else lo)
            # Le sink borne en images originales ; ce plafond SAM est seulement un garde large.
            eng = (limit + 1) if limit is not None else abs(bound_u - start_u)
            st["total"] = limit if limit is not None else max(1, span)
            n = self.engine.propagate(sink, start=start_u, count=eng, reverse=(mode == "backward"))
        else:
            shutil.rmtree(mattes, ignore_errors=True)
            shutil.rmtree(unique_mattes, ignore_errors=True)
            os.makedirs(unique_mattes, exist_ok=True)
            first = min((k[0] for k in self.points), default=lo)
            st["start"] = first
            first_u = self._unique_frame(first)
            hi_u = self._unique_frame(hi)
            lo_u = self._unique_frame(lo)
            n = self.engine.propagate(sink, start=first_u, count=max(0, hi_u - first_u))
            if not canceled["v"] and first > lo:
                st["direction"] = -1
                n += self.engine.propagate(sink, start=first_u, count=first_u - lo_u, reverse=True)
        self.propagated = True
        self.current = {}
        return {"ok": True, "frames": done["n"], "uniqueFrames": n, "canceled": canceled["v"]}

    def _post_dir(self, scope="union"):
        """Mattes à exporter (union OU obj-N) : brutes si post par défaut, sinon « cuites » dans
        mattes_post/<scope>. Les PNG propagés d'origine ne bougent jamais.

        Sur un matte fin, la lecture se fait SANS seuil et le post-traitement emprunte son jumeau
        doux : `> 127` suivi de `apply_post` transformerait le dégradé en contour dur juste avant
        l'export, c'est-à-dire au seul endroit où il compte."""
        soft = self._refined_active()
        src = os.path.join(self._matte_root(), scope)
        if not os.path.isdir(src):
            raise RuntimeError(t("no_matte_scope", scope=scope))
        if postproc.is_default(self.post):
            return src
        import numpy as np
        from PIL import Image
        out = os.path.join(self.work, "mattes_post", scope)
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out, exist_ok=True)
        for nme in sorted(os.listdir(src)):
            raw = np.array(Image.open(os.path.join(src, nme)).convert("L"))
            baked = postproc.apply_post_alpha(raw, self.post) if soft \
                else postproc.apply_post(raw > 127, self.post)
            Image.fromarray(baked, "L").save(os.path.join(out, nme))
        return out

    def export(self, fmt, out=None, mode=None, obj=None, bg=None):
        """Export : `obj` = id d'objet (matte de CET objet seul) ou None (union de tous)."""
        if not self.propagated:
            return {"ok": False, "error": t("track_before_export")}
        import re
        scope = ("obj-%d" % int(obj)) if obj else "union"
        raw = (self.names.get(int(obj)) or scope) if obj else ""
        suffix = ("_%s" % re.sub(r'[\\/:*?"<>|]+', "_", raw)) if obj else ""
        base = os.path.splitext(self.video)[0] + "_roto" + suffix
        out = out or base
        _stage("export")
        path = export_alpha.export(self.video, self._post_dir(scope), fmt, out, self.fps,
                                   self.in_s, bg=bg or self.view.get("bg"))
        return {"ok": True, "output": path}

    def _refine_proc(self, eng):
        """Processeur d'affinage, gardé CHAUD tant que le moteur ne change pas.

        Le bouton « tester sur une image » n'a d'intérêt que s'il répond vite : recharger 282 Mo
        de poids à chaque essai transformerait l'aller-retour en attente."""
        if self._matte_proc is not None and self._matte_engine == eng:
            return self._matte_proc
        self._release_matte()
        if eng in VIDEOMAMA_ENGINES:
            from nrroto.videomama import VideoMaMaEngine
            weights = os.environ.get("NETSURUSH_VIDEOMAMA_DIR", "")
            if not weights or not os.path.isdir(weights):
                raise RuntimeError(t("engine_weights_missing", engine="VideoMaMa"))
            self._matte_proc = VideoMaMaEngine(weights)
        else:
            self._matte_proc = matte_mod.load_engine(eng)
        self._matte_engine = eng
        return self._matte_proc

    def _release_matte(self):
        if self._matte_proc is None:
            return
        # Un moteur par lots tient DEUX réseaux (UNet + VAE) : les lâcher lui-même évite qu'ils
        # restent en VRAM le temps que le ramasse-miettes s'en aperçoive.
        unload = getattr(self._matte_proc, "unload", None)
        if callable(unload):
            try:
                unload()
            except Exception:  # noqa: BLE001 — libération best-effort
                pass
        self._matte_proc = None
        self._matte_engine = None
        try:
            import torch
            from nrdevice import empty_torch_cache, torch_backend
            empty_torch_cache(torch, torch_backend(torch))
        except Exception:  # noqa: BLE001 — libération best-effort, jamais bloquante
            pass

    def _refine_seeds(self, obj=None):
        """Images d'amorçage = celles que l'utilisateur a ANNOTÉES (leur masque est validé),
        bornées à la plage suivie et filtrées sur celles qui portent réellement une matte.

        Repli sur la première matte propagée quand aucun point ne tombe dans la plage — mieux vaut
        une graine imparfaite que pas d'affinage du tout."""
        scope = ("obj-%d" % int(obj)) if obj else "union"
        root = os.path.join(self._mattes_dir(), scope)
        if not os.path.isdir(root):
            return [], scope
        have = {int(os.path.splitext(n)[0]) for n in os.listdir(root) if n.endswith(".png")}
        if not have:
            return [], scope
        annotated = {f for (f, o) in self.points if self.points[(f, o)]
                     and (obj is None or int(o) == int(obj))}
        seeds = sorted(annotated & have)
        return (seeds or [min(have)]), scope

    def _union_matte_for(self, f):
        """Matte union d'UNE frame : propagée (disque) sinon masques live (points posés) écrits en
        matte temporaire. None si la frame n'a aucun masque."""
        p = os.path.join(self._mattes_dir(), "union", "%05d.png" % f)
        if os.path.isfile(p):
            return p
        masks = self.current.get(f)
        if not masks:
            return None
        import numpy as np
        from PIL import Image
        u = None
        for m in masks.values():
            u = m if u is None else (u | m)
        tmp = os.path.join(self.work, "test_mask.png")
        Image.fromarray(u.astype(np.uint8) * 255, "L").save(tmp)
        return tmp

    def _refine_test(self, eng, f, warmup, max_size):
        """Test du matte fin sur UNE image : le moteur s'amorce sur la matte de cette image et ne
        propage rien (aperçu « et si », rien d'écrit hors du dossier de travail).

        Le résultat est un PNG RGBA en data-URI, jamais une vidéo : c'est la même sortie que la
        chaîne réelle, sinon l'aperçu ne dirait rien de ce qu'on obtiendra."""
        self._wait_extract()
        mask0 = self._union_matte_for(f)
        if not mask0:
            return {"ok": False, "error": t("no_mask_frame")}
        out_dir = os.path.join(self.work, "test_refine")
        shutil.rmtree(out_dir, ignore_errors=True)
        _stage("refine")
        try:
            proc = self._refine_proc(eng)
            if eng in VIDEOMAMA_ENGINES:
                self._refine_test_batched(proc, f, mask0, out_dir, max_size)
            else:
                matte_mod.run(proc, [(f, [f])], self._frame_path, lambda _s: mask0, out_dir,
                              warmup=warmup, max_size=max_size)
        except ImportError as exc:
            return {"ok": False, "error": t("engine_missing", engine=eng, error=exc)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": t("engine_failed", engine=eng, error=exc)}
        alpha_path = os.path.join(out_dir, "%05d.png" % f)
        uri = self._alpha_preview(alpha_path, self._frame_path(f))
        if not uri:
            return {"ok": False, "error": t("fine_matte_unreadable")}
        self.last_test = {"frame": f, "alpha": alpha_path}
        return {"ok": True, "preview": uri, "mode": self.view.get("mode", "edit")}

    def _refine_test_batched(self, engine, f, mask_path, out_dir, max_size):
        """Essai d'un moteur par lots sur UNE image : lot d'une seule image, rien d'autre.

        Le résultat est donc moins bon que sur un vrai lot (le modèle est temporel et n'a ici aucun
        voisinage), mais il montre ce qui compte — le bord que ce modèle-là sait rendre."""
        import numpy as np
        from PIL import Image

        os.makedirs(out_dir, exist_ok=True)
        img = Image.open(self._frame_path(f)).convert("RGB")
        if max_size:
            w, h = img.size
            short = min(w, h)
            if short > max_size:
                k = max_size / float(short)
                img = img.resize((max(8, int(w * k)), max(8, int(h * k))), Image.LANCZOS)
        w, h = img.size
        img = img.resize(((w // 8) * 8 or 8, (h // 8) * 8 or 8), Image.LANCZOS)
        mask = Image.open(mask_path).convert("L").resize(img.size, Image.NEAREST)
        alpha = engine.run_batch([np.asarray(img, dtype=np.uint8)],
                                 [np.asarray(mask, dtype=np.uint8)])[0]
        full = Image.open(self._frame_path(f)).size
        Image.fromarray(alpha, "L").resize(full, Image.BILINEAR).save(
            os.path.join(out_dir, "%05d.png" % f))

    def _alpha_preview(self, alpha_path, frame_path):
        """Alpha d'un test + image source → data-URI PNG rendu EXACTEMENT comme le viewer.

        Même chemin que l'overlay (mode d'affichage, contours, couleur de fond, post-traitement
        courants) : l'aperçu d'un test montre donc ce que l'écran et l'export donneront, au lieu
        d'une découpe RGBA figée qui ignorait les deux. Aplati, parce qu'un comparateur affiche une
        seule image sans calque en dessous."""
        if not os.path.isfile(alpha_path):
            return None
        import numpy as np
        from PIL import Image
        a = np.array(Image.open(alpha_path).convert("L"))
        v = self.view
        return overlay.render_view_flat(frame_path, {1: a}, self.post,
                                        mode=v.get("mode", "edit"), outline=bool(v.get("outline")),
                                        bg=v.get("bg", "#00ff00"))

    def test_preview(self):
        """Rejoue l'aperçu du dernier test de matte fin avec le post-traitement et le mode
        d'affichage COURANTS.

        Le modèle ne retourne pas : seul l'alpha déjà sur le disque est recomposé, donc retouche du
        masque et changement de vue restent vivants pendant qu'on regarde le comparateur.
        `preview: None` = rien à rejouer (aucun test, ou le dernier aperçu vient d'une suppression
        d'objet)."""
        lt = self.last_test
        if not lt or self.video is None:
            return {"ok": True, "preview": None}
        uri = self._alpha_preview(lt["alpha"], self._frame_path(lt["frame"]))
        if not uri:
            return {"ok": True, "preview": None}
        return {"ok": True, "preview": uri, "frame": lt["frame"], "mode": self.view.get("mode", "edit")}

    def refine(self, engine="matanyone", obj=None, combined=False, warmup=None, max_size=None,
               frame=None, batch=None, overlap=None):
        """Matte fin (cheveux, bords fins) : réaffine l'alpha du suivi avec un modèle vidéo à
        mémoire, une image à la fois, en PNG GRIS dans `mattes_refined/`.

        Amorçage sur les images ANNOTÉES (leur masque a été validé par l'utilisateur), passe
        arrière puis passes avant — cf. nrroto.matte. Une passe PAR OBJET : c'est ce qui permet à
        l'export « un seul objet » d'en profiter et empêche deux objets qui se croisent de
        fusionner ; `combined` retombe sur une passe unique quand la vitesse prime.

        Recadrage ROI conservé : le modèle ne voit que la zone utile, donc y consacre toute sa
        résolution. `frame` = essai sur cette seule image, rien n'est écrit hors du travail."""
        eng = str(engine or "matanyone")
        steady = matte_mod.WARMUP if warmup is None else max(0, int(warmup))
        cap = matte_mod.DEFAULT_MAX_SIZE if max_size is None else max(0, int(max_size))
        if batch is not None:
            self.matte_batch = max(1, int(batch))
        if overlap is not None:
            self.matte_overlap = max(0, int(overlap))
        if frame is not None:
            if self.video is None:
                return {"ok": False, "error": t("no_video")}
            return self._refine_test(eng, int(frame), steady, cap)
        if not self.propagated:
            return {"ok": False, "error": t("track_before_refine")}

        scopes = ["union"] if (combined or not self._object_ids()) else \
                 [("obj-%d" % o) for o in self._object_ids()]
        root = self._refined_dir()
        shutil.rmtree(root, ignore_errors=True)
        try:
            os.remove(self._cancel_flag())
        except OSError:
            pass

        ew = int(round(self.w * self.scale))
        eh = int(round(self.h * self.scale))
        _stage("roi")
        rect = roi_mod.compute_roi(os.path.join(self._mattes_dir(), "union"), ew, eh)
        crop = self._refine_crop(rect) if rect is not None else None
        total = self._refine_total(eng, scopes)
        state = {"done": 0}

        _stage("refine")
        try:
            for scope in scopes:
                obj_id = int(scope[4:]) if scope.startswith("obj-") else None
                if not self._refine_scope(eng, scope, obj_id, crop, rect, steady, cap, state, total):
                    return {"ok": False, "error": t("no_propagated_matte")}
        except StopIteration:
            shutil.rmtree(root, ignore_errors=True)
            return {"ok": True, "canceled": True}
        except ImportError as exc:
            return {"ok": False, "error": t("engine_missing", engine=eng, error=exc)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": t("engine_failed", engine=eng, error=exc)}

        if len(scopes) > 1:
            matte_mod.merge_union([os.path.join(root, s) for s in scopes],
                                  os.path.join(root, "union"))
        self.refined = True
        self.use_refined = True
        return {"ok": True, "refined": True, "scopes": scopes,
                "liveDir": os.path.join(root, "union")}

    def _object_ids(self):
        """Objets réellement suivis (dossiers obj-N écrits par la propagation)."""
        root = self._mattes_dir()
        try:
            return sorted(int(d[4:]) for d in os.listdir(root) if d.startswith("obj-"))
        except (OSError, ValueError):
            return []

    def _refine_total(self, eng, scopes):
        """Images que l'affinage va traiter, tous objets confondus — pour une barre honnête.

        Un moteur par lots parcourt la plage UNE fois ; un moteur à mémoire repasse sur l'image
        d'amorçage à chaque changement de direction, donc son total est celui de son plan."""
        lo, hi = self._refine_range()
        if eng in VIDEOMAMA_ENGINES:
            return sum(len([f for f in range(lo, hi + 1)
                            if os.path.isfile(os.path.join(self._mattes_dir(), s, "%05d.png" % f))])
                       for s in scopes) or 1
        return sum(matte_mod.frame_total(
            matte_mod.plan_segments(self._refine_seeds(int(s[4:]) if s.startswith("obj-") else None)[0], lo, hi))
            for s in scopes) or 1

    def _refine_range(self):
        """Bornes du suivi réellement présent sur le disque (le suivi peut être borné in/out)."""
        union = os.path.join(self._mattes_dir(), "union")
        try:
            got = sorted(int(os.path.splitext(n)[0]) for n in os.listdir(union) if n.endswith(".png"))
        except (OSError, ValueError):
            return 0, max(0, self.frames - 1)
        return (got[0], got[-1]) if got else (0, max(0, self.frames - 1))

    def _refine_crop(self, rect):
        """Images recadrées sur la ROI, écrites une fois et partagées par tous les objets."""
        return roi_mod.crop_dir(self._frames_dir(), os.path.join(self.work, "refine_src"), rect)

    def _refine_scope(self, eng, scope, obj_id, crop, rect, steady, cap, state, total):
        """Affine UNE portée (un objet, ou l'union) et écrit `mattes_refined/<scope>/`."""
        src = os.path.join(self._mattes_dir(), scope)
        out = os.path.join(self._refined_dir(), scope)
        lo, hi = self._refine_range()

        def frame_path(f):
            return os.path.join(crop, "%05d.jpg" % f) if crop else self._frame_path(f)

        def on_frame(_done, _tot, frame):
            state["done"] += 1
            _stage("prog:%d/%d@%d" % (min(state["done"], total), total, frame))

        canceled = lambda: os.path.exists(self._cancel_flag())   # noqa: E731 — passé en rappel
        if eng in VIDEOMAMA_ENGINES:
            ok = self._refine_batched(eng, src, out, lo, hi, crop, rect, cap, on_frame, canceled)
        else:
            ok = self._refine_seeded(eng, scope, obj_id, src, out, lo, hi, frame_path, rect,
                                     steady, cap, on_frame, canceled)
        if ok and rect is not None:
            self._expand_alpha_dir(out, rect, ew_eh=(int(round(self.w * self.scale)),
                                                     int(round(self.h * self.scale))))
        return ok

    def _refine_seeded(self, eng, scope, obj_id, src, out, lo, hi, frame_path, rect, steady, cap,
                       on_frame, canceled):
        """MatAnyone : amorçage sur les images annotées puis propagation de sa mémoire."""
        from PIL import Image
        seeds, _ = self._refine_seeds(obj_id)
        if not seeds:
            return False
        plan = matte_mod.plan_segments(seeds, lo, hi)
        if not plan:
            return False
        seed_dir = os.path.join(self.work, "refine_seed", scope)
        shutil.rmtree(seed_dir, ignore_errors=True)
        os.makedirs(seed_dir, exist_ok=True)

        def seed_mask(f):
            path = os.path.join(src, "%05d.png" % f)
            if not os.path.isfile(path) or rect is None:
                return path
            cropped = os.path.join(seed_dir, "%05d.png" % f)
            Image.open(path).crop(rect).save(cropped)
            return cropped

        proc = self._refine_proc(eng)
        matte_mod.run(proc, plan, frame_path, seed_mask, out, warmup=steady, max_size=cap,
                      on_frame=on_frame, cancelled=canceled)
        return True

    def _refine_batched(self, eng, src, out, lo, hi, crop, rect, cap, on_frame, canceled):
        """VideoMaMa : aucun amorçage — il reçoit un masque PAR image et travaille par lots.

        Les images sans matte propagée sont écartées plutôt que nourries d'un masque vide : le
        modèle rendrait un alpha inventé là où le suivi n'a rien vu."""
        import numpy as np
        from PIL import Image
        from nrroto import videomama as vmm

        frames = [f for f in range(lo, hi + 1)
                  if os.path.isfile(os.path.join(src, "%05d.png" % f))]
        if not frames:
            return False
        os.makedirs(out, exist_ok=True)
        engine = self._refine_proc(eng)

        def load(path, cap_px):
            img = Image.open(path)
            if cap_px:
                w, h = img.size
                short = min(w, h)
                if short > cap_px:
                    k = cap_px / float(short)
                    img = img.resize((max(8, int(w * k)), max(8, int(h * k))), Image.LANCZOS)
            # Le VAE réduit d'un facteur 8 : une dimension non multiple de 8 casse la reconstruction.
            w, h = img.size
            return img.resize(((w // 8) * 8 or 8, (h // 8) * 8 or 8), Image.LANCZOS)

        size = {}

        def frame_image(f):
            img = load(os.path.join(crop, "%05d.jpg" % f) if crop else self._frame_path(f), cap)
            size["wh"] = img.size
            return np.asarray(img.convert("RGB"), dtype=np.uint8)

        def frame_mask(f):
            path = os.path.join(src, "%05d.png" % f)
            img = Image.open(path).convert("L")
            if rect is not None:
                img = img.crop(rect)
            target = size.get("wh")
            if target and img.size != target:
                img = img.resize(target, Image.NEAREST)
            return np.asarray(img, dtype=np.uint8)

        def write(f, alpha):
            src_img = Image.open(os.path.join(crop, "%05d.jpg" % f) if crop else self._frame_path(f))
            img = Image.fromarray(alpha, "L")
            if img.size != src_img.size:
                img = img.resize(src_img.size, Image.BILINEAR)
            img.save(os.path.join(out, "%05d.png" % f))

        vmm.refine_batches(engine, frames, frame_image, frame_mask, write,
                           batch=self.matte_batch, overlap=self.matte_overlap,
                           on_frame=on_frame, cancelled=canceled)
        return True

    def _expand_alpha_dir(self, out_dir, rect, ew_eh):
        """Recolle les alphas recadrés ROI dans le plein cadre (hors ROI = transparent).

        L'ancienne version ré-expansait une VIDÉO par ffmpeg, ce qui ajoutait un second encodage
        à un alpha déjà compressé. Ici on recolle des PNG : aucune perte."""
        import numpy as np
        from PIL import Image
        w, h = ew_eh
        for name in sorted(os.listdir(out_dir)):
            if not name.endswith(".png"):
                continue
            path = os.path.join(out_dir, name)
            full = Image.fromarray(np.zeros((h, w), dtype=np.uint8), "L")
            full.paste(Image.open(path).convert("L"), (rect[0], rect[1]))
            full.save(path)

    def _remove_test(self, eng, label, runner, kw, frame):
        """TEST sur UNE image (« et si ? » avant de lancer tout le plan) : aperçu seul, rien n'est
        écrit hors du dossier de travail. MiniMax exige une fenêtre Wan de 13 frames (4k+1) centrée —
        son modèle a besoin d'un contexte temporel."""
        self._wait_extract()
        f = min(max(0, int(frame)), self.frames - 1)
        cnt = min(13, self.frames)
        start = min(max(0, f - cnt // 2), max(0, self.frames - cnt))
        try:
            img = runner(out_path=os.path.join(self.work, "test_remove.mp4"),
                         start=start, count=cnt, preview_index=f - start, **kw)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": t("engine_failed", engine=label, error=exc)}
        from nrroto.overlay import _png_uri
        # L'aperçu affiché n'est plus un alpha : la retouche du masque ne s'y rejoue pas.
        self.last_test = None
        return {"ok": True, "preview": _png_uri(img)}

    def object_remove(self, engine=DEFAULT_REMOVE_ENGINE, out=None, steps=None, grow=None, frame=None,
                      plate=None, harmonize=None, grain=None, quality=None, seed=None, window=None,
                      overlap=None, vae_tiling=None, cpu_offload=None):
        """Suppression d'objet (inpainting) pilotée par les mattes union. Qualité : recadrage ROI
        auto, plaque propre (le fond réellement filmé dans les images voisines prime sur ce que le
        modèle inventerait), raccord couleur/netteté/grain sur la couronne, et composite dans la
        SEULE zone masquée dilatée (le reste = frames originales nettes). `frame` = TEST sur cette
        image (renvoie `preview` data-URI, rien n'est écrit). Moteurs : cf. REMOVE_ENGINES.

        plate (bool) · harmonize/grain (0..100 côté UI, ramenés en 0..1) · quality (px, MiniMax
        seul : palier de résolution de diffusion)."""
        if not self.propagated:
            return {"ok": False, "error": t("segment_before_remove")}
        eng = str(engine or DEFAULT_REMOVE_ENGINE)
        meta = REMOVE_ENGINES.get(eng)
        if meta is None:
            return {"ok": False, "error": t("remove_engine_unwired", engine=eng,
                                              fallback="MiniMax-Remover")}
        env_key, label = meta
        weights = os.environ.get(env_key, "")
        if not weights or not os.path.isdir(weights):
            return {"ok": False, "error": t("engine_weights_missing", engine=label)}
        try:
            from nrroto.minimax import run_minimax_remover as runner
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": t("engine_unavailable", engine=label, error=exc)}
        # Le matte fin, quand il est actif, sert AUSSI de masque à la suppression : un contour plus
        # juste, c'est une couronne de référence plus juste pour le raccord.
        kw = dict(frames_dir=self._frames_dir(), mattes_root=self._matte_root(),
                  weights_dir=weights, fps=self.fps,
                  progress=lambda cur, tot: _stage("prog:%d/%d" % (cur, tot)),
                  grow=int(grow) if grow is not None else 8,
                  plate=True if plate is None else bool(plate),
                  harmonize=_percent(harmonize, DEFAULT_HARMONIZE),
                  grain=_percent(grain, DEFAULT_GRAIN))
        kw["steps"] = int(steps) if steps else 12
        if quality:
            kw["quality"] = int(quality)
        # Réglages du MODÈLE (par opposition à ceux du masque) : chacun n'est transmis que s'il a
        # été demandé, pour que le défaut reste celui du module d'inférence et pas celui de l'UI.
        for key, value in (("seed", seed), ("window", window), ("overlap", overlap)):
            if value is not None:
                kw[key] = int(value)
        if vae_tiling is not None:
            kw["vae_tiling"] = bool(vae_tiling)
        if cpu_offload is not None:
            kw["cpu_offload"] = bool(cpu_offload)
        _stage("remove")
        # Décharge SAM de la VRAM AVANT l'inpainting : la suppression ne lit que les mattes (disque),
        # pas le modèle SAM. Sur petite carte ça libère la place pour Wan. SAM se recharge tout seul
        # au prochain point/propagation (points + mattes déjà persistés → rien de perdu).
        self.engine.unload()
        # Même raison pour le modèle d'affinage : ses mattes sont sur le disque, sa présence en
        # VRAM ne sert plus qu'à priver Wan de la place dont il a besoin.
        self._release_matte()
        if frame is not None:
            return self._remove_test(eng, label, runner, kw, int(frame))
        out_path = out or (os.path.splitext(self.video)[0] + "_remove.mp4")
        from nrroto.video import Canceled
        try:
            runner(out_path=out_path, **kw)
        except Canceled:
            return {"ok": True, "canceled": True}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": t("engine_failed", engine=label, error=exc)}
        return {"ok": True, "output": out_path}

    def close(self):
        """Fin de la vidéo active : libère SAM. Le dossier reste jusqu'à la fermeture de l'app afin
        de permettre une réouverture instantanée pendant les retouches de la même session."""
        self.engine.reset()
        self._release_matte()
        self.video, self.work, self.frames = None, None, 0
        self.points, self.order, self.names, self.current, self.propagated = {}, [], {}, {}, False
        self.refined, self.use_refined = False, True
        self.last_test = None
        self.post = postproc.default_post()
        self.view = {"mode": "edit", "outline": False, "bg": "#00ff00"}
        self._extract_thread, self._extract_error = None, None
