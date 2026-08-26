#!/usr/bin/env python3
"""NetsuRush — point d'entrée du hub de traitements vidéo (interpolation / depth / removeBG).

Pendant de python/upscale.py pour les 3 nouveaux modes du hub. La logique vit dans le package
`nrproc` (voir son docstring) ; ce fichier ne garde que le worker persistant `serve`, le CLI
argparse et le dispatch des 4 commandes.

Worker (core/sidecars.js : `python process.py serve`) : lit des commandes JSON (1 par ligne) sur
stdin, garde le modèle en VRAM, répond 1 ligne JSON (même `id`) sur stdout, progression sur stderr.

Commandes :
  python process.py interpolate --input <v> --out <v> --model <m> --factor <2|3|4> [--target_fps f]
                                [--slowmo] --codec <c> [--start s] [--end s] ...
  python process.py depth       --input <v> --out <v> --model <m> [--bits 8|16] [--colormap gray]
                                --codec <c> [--start s] [--end s] ...
  python process.py removebg    --input <v> --out <v> --model <m> --format <prores_4444|png_seq|webm_alpha>
                                [--start s] [--end s]
  python process.py frame       --input <v> --orig <png> --out <png> --mode <m> --model <m> [--time s]
Toutes les commandes acceptent une SORTIE IMAGE : --out_kind sequence|image avec --img_format,
--png_bits, --png_compression, --jpeg_quality et --seq_start (défaut : sortie vidéo).
Sortie stdout = 1 ligne JSON : {"ok":bool,"output":path,"width":w,"height":h,"frames":n,"error":null}
(la commande frame renvoie orig/out au lieu d'output)."""
import argparse
import json
import sys
from nri18n import t

from nrproc.depth import cmd_depth
from nrproc.frame import cmd_frame
from nrproc.interp import cmd_interpolate
from nrproc.seg import cmd_removebg


def _dispatch(cmd, args):
    """Aiguille une commande déjà désérialisée (Req ou namespace argparse) vers son handler."""
    if cmd == "interpolate":
        return cmd_interpolate(args)
    if cmd == "depth":
        return cmd_depth(args)
    if cmd == "removebg":
        return cmd_removebg(args)
    if cmd == "frame":
        return cmd_frame(args)
    return {"ok": False, "error": t("unknown_command", detail=": %s" % cmd)}


def serve():
    """Worker persistant : lit des commandes JSON (1 par ligne) sur stdin, garde le modèle en VRAM.
    Réponse JSON (1 ligne) sur stdout, avec le même `id`. Progression sur stderr (STAGE:*)."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "interpolate":
                res = cmd_interpolate(Req(req, INTERP_DEFAULTS))
            elif cmd == "depth":
                res = cmd_depth(Req(req, DEPTH_DEFAULTS))
            elif cmd == "removebg":
                res = cmd_removebg(Req(req, REMOVEBG_DEFAULTS))
            elif cmd == "frame":
                res = cmd_frame(Req(req, FRAME_DEFAULTS))
            else:
                res = {"ok": False, "error": t("unknown_command", detail=": %s" % cmd)}
        except Exception as exc:  # noqa: BLE001
            res = {"ok": False, "error": str(exc)}
        if rid is not None:
            res["id"] = rid
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
        return
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")

    it = sub.add_parser("interpolate")                    # interpolation de frames (RIFE)
    it.add_argument("--input", required=True)
    it.add_argument("--out", required=True)
    it.add_argument("--model", default="rife-v4.6")
    it.add_argument("--factor", type=int, default=2)      # 2 | 3 | 4 (nb d'intermédiaires + 1)
    it.add_argument("--target_fps", type=float, default=None)  # fps de sortie ciblé (optionnel)
    it.add_argument("--slowmo", action="store_true")      # ralenti : factor× frames, même fps
    it.add_argument("--dedup", action="store_true")       # supprime les frames mortes (doublons) avant interp
    it.add_argument("--dedup_thr", type=float, default=0.006)  # seuil de détection des doublons (0..1)
    it.add_argument("--codec", default="x264")
    it.add_argument("--quality", type=int, default=20)
    it.add_argument("--preset", default="medium")
    it.add_argument("--bitdepth", type=int, default=8)
    it.add_argument("--profile", default=None)            # profil codec réel (-profile:v), None = repli profondeur
    it.add_argument("--audio", default="copy")
    it.add_argument("--abr", type=int, default=192)
    it.add_argument("--atrack", type=int, default=0)
    it.add_argument("--start", type=float, default=None)
    it.add_argument("--end", type=float, default=None)

    de = sub.add_parser("depth")                          # carte de profondeur (transformers)
    de.add_argument("--input", required=True)
    de.add_argument("--out", required=True)
    de.add_argument("--model", default="depth-anything-v2-small")
    de.add_argument("--bits", type=int, default=8)        # 8 (vidéo) | 16 (séquence PNG)
    de.add_argument("--colormap", default="gray")         # gray | inferno | magma | viridis
    de.add_argument("--codec", default="x264")
    de.add_argument("--quality", type=int, default=20)
    de.add_argument("--preset", default="medium")
    de.add_argument("--bitdepth", type=int, default=8)
    de.add_argument("--profile", default=None)            # profil codec réel (-profile:v), None = repli profondeur
    de.add_argument("--audio", default="none")
    de.add_argument("--abr", type=int, default=192)
    de.add_argument("--atrack", type=int, default=0)
    de.add_argument("--start", type=float, default=None)
    de.add_argument("--end", type=float, default=None)

    rb = sub.add_parser("removebg")                       # suppression de fond (rembg)
    rb.add_argument("--input", required=True)
    rb.add_argument("--out", required=True)
    rb.add_argument("--model", default="isnet-anime")
    rb.add_argument("--format", default="prores_4444")    # prores_4444 | png_seq | webm_alpha
    rb.add_argument("--audio", default="copy")
    rb.add_argument("--abr", type=int, default=192)
    rb.add_argument("--atrack", type=int, default=0)
    rb.add_argument("--start", type=float, default=None)
    rb.add_argument("--end", type=float, default=None)
    rb.add_argument("--despeckle", type=int, default=0)
    rb.add_argument("--edge_smoothing", type=int, default=0)
    rb.add_argument("--edge_offset", type=int, default=0)

    fr = sub.add_parser("frame")                          # aperçu d'une seule frame (orig + traité)
    fr.add_argument("--input", required=True)
    fr.add_argument("--orig", required=True)              # PNG frame source
    fr.add_argument("--out", required=True)               # PNG frame traitée
    fr.add_argument("--mode", default="depth")            # interpolate | depth | removebg
    fr.add_argument("--model", default="depth-anything-v2-small")
    fr.add_argument("--colormap", default="gray")
    fr.add_argument("--time", type=float, default=0.0)
    fr.add_argument("--despeckle", type=int, default=0)
    fr.add_argument("--edge_smoothing", type=int, default=0)
    fr.add_argument("--edge_offset", type=int, default=0)

    # Sortie image commune aux trois commandes : "video" (défaut) = comportement historique.
    for sub_parser in (it, de, rb):
        sub_parser.add_argument("--out_kind", default="video")        # video | sequence | image
        sub_parser.add_argument("--img_format", default="png")        # png | jpeg
        sub_parser.add_argument("--png_bits", type=int, default=8)    # 8 | 16
        sub_parser.add_argument("--png_compression", type=int, default=6)   # 0..9 (sans perte)
        sub_parser.add_argument("--jpeg_quality", type=int, default=92)     # 1..100
        sub_parser.add_argument("--seq_start", type=int, default=1)   # numéro de la 1re image

    args = p.parse_args()
    try:
        res = _dispatch(args.cmd, args)
    except Exception as exc:  # noqa: BLE001
        res = {"ok": False, "error": str(exc)}
    print(json.dumps(res))


# Sortie image commune aux commandes du hub : "video" = comportement historique (les autres clés
# sont alors ignorées), "sequence" = motif numéroté, "image" = fichier unique. `image_args` porte
# les arguments ffmpeg déjà résolus par le core (cf. core/imageOutput.js).
IMAGE_OUT_DEFAULTS = {"out_kind": "video", "img_format": "png", "png_bits": 8,
                      "png_compression": 6, "jpeg_quality": 92, "seq_start": 1, "image_args": None}

# Valeurs par défaut d'une requête worker (les clés absentes du JSON prennent celles-ci).
INTERP_DEFAULTS = {"model": "rife-v4.6", "factor": 2, "target_fps": None, "slowmo": False,
                   "dedup": False, "dedup_thr": 0.006,
                   "codec": "x264", "quality": 20, "preset": "medium", "bitdepth": 8, "profile": None,
                   "audio": "copy", "abr": 192, "atrack": 0, "start": None, "end": None}
DEPTH_DEFAULTS = {"model": "depth-anything-v2-small", "bits": 8, "colormap": "gray",
                  "dedup": False, "dedup_thr": 0.006,
                  "codec": "x264", "quality": 20, "preset": "medium", "bitdepth": 8, "profile": None,
                  "audio": "none", "abr": 192, "atrack": 0, "start": None, "end": None}
REMOVEBG_DEFAULTS = {"model": "isnet-anime", "format": "prores_4444",
                     "dedup": False, "dedup_thr": 0.006,
                     "despeckle": 0, "edge_smoothing": 0, "edge_offset": 0,
                     "audio": "copy", "abr": 192, "atrack": 0, "start": None, "end": None}
FRAME_DEFAULTS = {"mode": "depth", "model": "depth-anything-v2-small", "colormap": "gray", "time": 0.0,
                  "despeckle": 0, "edge_smoothing": 0, "edge_offset": 0}
for _defaults in (INTERP_DEFAULTS, DEPTH_DEFAULTS, REMOVEBG_DEFAULTS):
    _defaults.update(IMAGE_OUT_DEFAULTS)


class Req:
    """Accès attribut (a.input, a.codec…) depuis un dict JSON, avec valeurs par défaut."""
    def __init__(self, d, defaults):
        for k, v in defaults.items():
            setattr(self, k, v)
        for k, v in d.items():
            setattr(self, k, v)


if __name__ == "__main__":
    main()
