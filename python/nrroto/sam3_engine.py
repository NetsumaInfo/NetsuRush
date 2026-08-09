"""Moteur SAM 3.1 : même interface publique que `SamEngine` (load / open / add_points / propagate /
reset_prompts / unload / reset), pour que `Session` n'ait à choisir qu'une classe.

SAM 3 n'expose PAS l'API de SAM 2. Là où SAM 2 rend un état d'inférence que l'appelant promène
(`init_state` → `add_new_points_or_box` → `propagate_in_video`), SAM 3 tient les sessions LUI-MÊME et
se pilote par requêtes : `handle_request({"type": "start_session" | "add_prompt" | …})` et
`handle_stream_request({"type": "propagate_in_video"})`. Tout l'écart est absorbé ici.

Deux contraintes du paquet amont, vérifiées dans la source :
  - `Sam3VideoPredictor.__init__` appelle `.cuda()` en dur : sans CUDA le modèle ne se construit pas.
    On refuse tôt, avec un message qui dit quoi faire, plutôt que de laisser remonter une erreur torch.
  - les masques de sortie arrivent DÉJÀ en pleine résolution et en booléen
    (`outputs["out_binary_masks"]`, forme (N, H, W)), contrairement à SAM 2 qui rend des logits.
"""
import glob
import os

from nri18n import t
from nrdevice import empty_torch_cache, torch_backend

# Le dépôt publie un seul poids par version ; on le retrouve par extension pour ne pas dépendre de
# son nom exact, qui a déjà changé entre `sam3.pt` et `sam3.1_multiplex.pt`.
_CKPT_GLOB = "*.pt"


def _find_ckpt(override_dir=None):
    for directory in (override_dir, os.environ.get("NETSURUSH_SAM3_DIR", "")):
        if directory and os.path.isdir(directory):
            hits = sorted(glob.glob(os.path.join(directory, "**", _CKPT_GLOB), recursive=True))
            if hits:
                return hits[0]
    return None


class Sam3Engine:
    """Une session vidéo SAM 3.1. `state` porte l'identifiant de session côté paquet amont : le reste
    de NetsuRush ne teste que sa présence (« une vidéo est-elle ouverte ? »), jamais son contenu."""

    def __init__(self):
        self.predictor = None
        self.state = None          # session_id SAM 3, ou None
        self.device = "cpu"
        self.backend = "cpu"
        self._frames_dir = None
        self._canceled = False

    def load(self, sam_dir=None):
        if self.predictor is not None:
            return
        try:
            import torch
            from sam3.model_builder import build_sam3_video_predictor
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(t("sam3_package_missing", error=exc))
        backend = torch_backend(torch)
        if backend != "cuda":
            # Refus explicite : le prédicteur amont force `.cuda()`, il n'a pas de chemin processeur.
            raise RuntimeError(t("sam3_cuda_required"))
        ckpt = _find_ckpt(sam_dir)
        if not ckpt:
            raise RuntimeError(t("sam3_weights_missing"))
        self.backend, self.device = backend, "cuda"
        self.predictor = build_sam3_video_predictor(checkpoint_path=ckpt, load_from_HF=False)

    def open(self, frames_dir, sam_dir=None):
        """Ouvre une session sur le dossier de frames extraites. Une session déjà ouverte est fermée
        avant : le paquet amont les garde en mémoire jusqu'à expiration."""
        self.load(sam_dir)
        self._close_session()
        self._frames_dir = frames_dir
        response = self.predictor.handle_request({
            "type": "start_session",
            "resource_path": frames_dir,
            "offload_video_to_cpu": True,
            "offload_state_to_cpu": True,
        })
        self.state = response["session_id"]

    def _masks_of(self, outputs):
        """Sortie SAM 3 → {obj: masque booléen HxW}, la forme qu'attend le reste du Roto Studio."""
        import numpy as np
        ids = np.asarray(outputs["out_obj_ids"]).reshape(-1)
        masks = np.asarray(outputs["out_binary_masks"])
        return {int(o): masks[i].astype(bool) for i, o in enumerate(ids) if i < len(masks)}

    def add_points(self, frame, obj, pts):
        """pts = [(x, y, label)] en pixels de la résolution EXTRAITE. Renvoie {obj: masque bool HxW}.

        `clear_old_points=False` : NetsuRush renvoie la liste COMPLÈTE des points de l'objet à chaque
        appel et attend un masque qui les respecte tous — vider l'historique amont à chaque ajout
        reviendrait à ne garder que le dernier clic."""
        if self.state is None:
            raise RuntimeError(t("no_video"))
        response = self.predictor.handle_request({
            "type": "add_prompt",
            "session_id": self.state,
            "frame_index": int(frame),
            "obj_id": int(obj),
            "points": [[float(p[0]), float(p[1])] for p in pts],
            "point_labels": [int(p[2]) for p in pts],
            "clear_old_points": False,
            # Coordonnées en PIXELS de la frame extraite, pas en fraction de l'image.
            "rel_coordinates": False,
        })
        return self._masks_of(response["outputs"])

    def propagate(self, sink, start=None, count=None, reverse=False):
        """Propage ; `sink(frame_idx, {obj: masque})` est appelé image par image (écriture disque au
        fil de l'eau). `sink` peut lever StopIteration (annulation) → arrêt propre, les frames déjà
        écrites restent. Le flux amont est un générateur : l'abandonner suffit à l'interrompre, mais
        on prévient aussi le prédicteur pour qu'il libère son état de propagation."""
        if self.state is None:
            raise RuntimeError(t("no_video"))
        request = {
            "type": "propagate_in_video",
            "session_id": self.state,
            "propagation_direction": "backward" if reverse else "forward",
        }
        if start is not None:
            request["start_frame_index"] = int(start)
        if count is not None:
            request["max_frame_num_to_track"] = int(count)
        n = 0
        try:
            for out in self.predictor.handle_stream_request(request):
                sink(int(out["frame_index"]), self._masks_of(out["outputs"]))
                n += 1
        except StopIteration:
            self._cancel_propagation()
        return n

    def _cancel_propagation(self):
        try:
            self.predictor.handle_request({"type": "cancel_propagation", "session_id": self.state})
        except Exception:  # noqa: BLE001 — le flux est déjà abandonné, l'état sera repris au reset
            pass

    def reset_prompts(self):
        """Efface points et suivi en GARDANT la vidéo ouverte (re-pose après correction)."""
        if self.predictor is not None and self.state is not None:
            self.predictor.handle_request({"type": "reset_session", "session_id": self.state})

    def _close_session(self):
        if self.predictor is None or self.state is None:
            return
        try:
            self.predictor.handle_request({"type": "close_session", "session_id": self.state})
        except Exception:  # noqa: BLE001 — session déjà expirée côté amont
            pass
        self.state = None

    def unload(self):
        """Libère la VRAM en GARDANT ce qui a été calculé (mattes sur disque, points persistés) : la
        suppression d'objet peut ainsi charger son propre modèle sur une petite carte."""
        self._close_session()
        self.predictor = None
        self._frames_dir = None
        self.device = "cpu"
        backend, self.backend = self.backend, "cpu"
        try:
            import gc
            import torch
            gc.collect()
            empty_torch_cache(torch, backend)
        except Exception:  # noqa: BLE001
            pass

    def reset(self):
        self._close_session()
