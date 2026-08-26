#!/usr/bin/env python3
"""NetsuRush — point d'entrée du sidecar d'upscaling vidéo/image Real-ESRGAN (encode GPU + mux audio).

La logique est découpée dans le package `upscaler` (voir son docstring) ; ce fichier ne garde que
le worker persistant `serve`, le CLI argparse et le dispatch des 4 commandes.

Worker (core/sidecars.js : `python upscale.py serve`) : lit des commandes JSON (1 par ligne) sur
stdin, garde le modèle en VRAM, répond 1 ligne JSON (même `id`) sur stdout, progression sur stderr.

Commandes :
  python upscale.py upscale --input <v> --out <v> --model <m> --outscale <s> --codec <c>
                            [--start s] [--end s] [--denoise 0..1] [--tile px] [--fp32]
  python upscale.py frame   --input <v> --orig <png> --out <png> [--time s] ...
  python upscale.py image   --input <img> --out <img> [--img_format png|jpeg] [--png_bits 8|16] ...
  python upscale.py gif     --input <gif> --out <gif> ...
`upscale` accepte aussi une SORTIE IMAGE : --out_kind sequence|image (défaut : sortie vidéo).
Sortie stdout = 1 ligne JSON : {"ok":bool,"output":path,"width":w,"height":h,"frames":n,"error":null}
"""
import argparse
import json
import sys
from nri18n import t

from upscaler.backends import _patch_basicsr
from upscaler.commands import (FRAME_DEFAULTS, GIF_DEFAULTS, IMAGE_DEFAULTS,
                               UPSCALE_DEFAULTS, Req, cmd_frame, cmd_gif,
                               cmd_image, cmd_upscale)


def serve():
    """Worker persistant : lit des commandes JSON (1 par ligne) sur stdin, garde le modèle en VRAM.
    Réponse JSON (1 ligne) sur stdout, avec le même `id`. Progression sur stderr (STAGE:*)."""
    _patch_basicsr()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "frame":
                res = cmd_frame(Req(req, FRAME_DEFAULTS))
            elif cmd == "image":
                res = cmd_image(Req(req, IMAGE_DEFAULTS))
            elif cmd == "gif":
                res = cmd_gif(Req(req, GIF_DEFAULTS))
            elif cmd == "upscale":
                res = cmd_upscale(Req(req, UPSCALE_DEFAULTS))
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
    _patch_basicsr()
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")
    u = sub.add_parser("upscale")
    u.add_argument("--input", required=True)
    u.add_argument("--out", required=True)
    u.add_argument("--model", default="light")
    u.add_argument("--outscale", type=int, default=4)
    # Le daemon reçoit l'encodeur matériel sondé par le core. En appel CLI direct, CPU universel.
    u.add_argument("--codec", default="x264")
    u.add_argument("--start", type=float, default=None)
    u.add_argument("--end", type=float, default=None)
    u.add_argument("--denoise", type=float, default=None)
    u.add_argument("--tile", type=int, default=0)
    u.add_argument("--tile_pad", type=int, default=10)
    u.add_argument("--pre_pad", type=int, default=0)
    u.add_argument("--fp32", action="store_true")
    u.add_argument("--cleanup_noise", type=float, default=0.0)
    u.add_argument("--cleanup_edges", type=float, default=0.0)
    u.add_argument("--quality", type=int, default=20)     # CRF x264/x265 (bas = meilleure qualité)
    u.add_argument("--preset", default="medium")          # preset x264/x265 (veryfast..slow)
    u.add_argument("--bitdepth", type=int, default=8)     # 8 | 10 (x265)
    u.add_argument("--audio", default="copy")             # copy | aac | ac3 | flac | pcm | none
    u.add_argument("--abr", type=int, default=192)        # débit audio (kbps) pour aac/ac3
    u.add_argument("--atrack", type=int, default=0)       # index relatif de la piste audio

    f = sub.add_parser("frame")                           # test d'upscale sur une seule frame
    f.add_argument("--input", required=True)
    f.add_argument("--orig", required=True)               # PNG frame source
    f.add_argument("--out", required=True)                # PNG frame upscalée
    f.add_argument("--time", type=float, default=0.0)
    f.add_argument("--model", default="light")
    f.add_argument("--outscale", type=int, default=2)
    f.add_argument("--denoise", type=float, default=None)
    f.add_argument("--tile", type=int, default=0)
    f.add_argument("--tile_pad", type=int, default=10)
    f.add_argument("--pre_pad", type=int, default=0)
    f.add_argument("--fp32", action="store_true")
    f.add_argument("--cleanup_noise", type=float, default=0.0)
    f.add_argument("--cleanup_edges", type=float, default=0.0)

    im = sub.add_parser("image")                          # upscale d'un fichier image (board)
    im.add_argument("--input", required=True)
    im.add_argument("--out", required=True)
    im.add_argument("--model", default="light")
    im.add_argument("--outscale", type=int, default=2)
    im.add_argument("--denoise", type=float, default=None)
    im.add_argument("--tile", type=int, default=0)
    im.add_argument("--tile_pad", type=int, default=10)
    im.add_argument("--pre_pad", type=int, default=0)
    im.add_argument("--fp32", action="store_true")
    im.add_argument("--cleanup_noise", type=float, default=0.0)
    im.add_argument("--cleanup_edges", type=float, default=0.0)

    g = sub.add_parser("gif")                             # upscale d'un GIF animé (board)
    g.add_argument("--input", required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--model", default="light")
    g.add_argument("--outscale", type=int, default=2)
    g.add_argument("--denoise", type=float, default=None)
    g.add_argument("--tile", type=int, default=0)
    g.add_argument("--tile_pad", type=int, default=10)
    g.add_argument("--pre_pad", type=int, default=0)
    g.add_argument("--fp32", action="store_true")
    g.add_argument("--cleanup_noise", type=float, default=0.0)
    g.add_argument("--cleanup_edges", type=float, default=0.0)

    # Sortie image : "video" (défaut) = comportement historique pour `upscale` ; `image` écrit
    # toujours un fichier image et n'y lit que le format / la profondeur / la compression.
    for sub_parser in (u, im):
        sub_parser.add_argument("--out_kind", default=None)           # video | sequence | image
        sub_parser.add_argument("--img_format", default="png")        # png | jpeg
        sub_parser.add_argument("--png_bits", type=int, default=8)    # 8 | 16
        sub_parser.add_argument("--png_compression", type=int, default=6)   # 0..9 (sans perte)
        sub_parser.add_argument("--jpeg_quality", type=int, default=92)     # 1..100
        sub_parser.add_argument("--seq_start", type=int, default=1)   # numéro de la 1re image

    args = p.parse_args()
    try:
        if args.cmd == "upscale":
            res = cmd_upscale(args)
        elif args.cmd == "frame":
            res = cmd_frame(args)
        elif args.cmd == "image":
            res = cmd_image(args)
        elif args.cmd == "gif":
            res = cmd_gif(args)
        else:
            res = {"ok": False, "error": t("unknown_command", detail="")}
    except Exception as exc:  # noqa: BLE001
        res = {"ok": False, "error": str(exc)}
    print(json.dumps(res))


if __name__ == "__main__":
    main()
