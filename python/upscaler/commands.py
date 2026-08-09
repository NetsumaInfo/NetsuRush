"""Handlers des 4 commandes (upscale/frame/image/gif) + valeurs par défaut d'une requête worker.

Sortie = dict JSON (le point d'entrée le sérialise). Marqueurs de progression sur stderr
(STAGE:load / STAGE:infer / STAGE:prog:i/n)."""
import os
from nri18n import t

from .backends import get_upsampler
from .cleanup import cleanup_frame
from .codecs import UnknownCodecError, video_codec_args
from .log import log
from .media import (decode_one_frame, open_decoder, open_encoder,
                    open_gif_encoder, probe, probe_color, write_png)
from .pipeline import run_stream


def cmd_gif(args):
    """Upscale un GIF ANIMÉ → réécrit un GIF animé (préserve l'animation et le fps, contrairement à
    cmd_image qui ne lit qu'une frame). Transparence aplatie (pipeline bgr24)."""
    w, h, fps_str, _fps, nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("gif_dimensions", path=args.input)}

    log("STAGE:load")
    up = get_upsampler(args.model, args.tile, args.fp32, args.denoise,
                       getattr(args, "tile_pad", 10), getattr(args, "pre_pad", 0))
    log("STAGE:infer")
    ow, oh = w * args.outscale, h * args.outscale
    dec = open_decoder(args.input, None, None)
    enc = open_gif_encoder(args.out, ow, oh, fps_str)
    done, err = run_stream(dec, enc, up, w, h, args.outscale, nb, "ffmpeg gif interrompu",
                           args.cleanup_noise, args.cleanup_edges)

    if err:
        return {"ok": False, "error": err}
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        return {"ok": False, "error": t("empty_gif")}
    return {"ok": True, "output": args.out, "width": ow, "height": oh, "frames": done, "error": None}


def cmd_upscale(args):
    # Valide le codec AVANT de charger le modèle / lancer ffmpeg : un codec inconnu échoue
    # explicitement (plus de repli silencieux sur ProRes).
    if not getattr(args, "video_args", None):
        try:
            video_codec_args(args.codec, args.quality, args.preset, args.bitdepth, getattr(args, "profile", None))
        except UnknownCodecError as exc:
            return {"ok": False, "error": str(exc)}

    w, h, fps_str, _fps, nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("video_dimensions", detail=" : " + args.input)}

    log("STAGE:load")
    up = get_upsampler(args.model, args.tile, args.fp32, args.denoise,
                       getattr(args, "tile_pad", 10), getattr(args, "pre_pad", 0))
    log("STAGE:infer")

    # Colorimétrie source → round-trip YUV→RGB→YUV identité (sinon sortie plus foncée que l'aperçu).
    color = probe_color(args.input, w, h)
    ow, oh = w * args.outscale, h * args.outscale
    dec = open_decoder(args.input, args.start, args.end, color)
    enc = open_encoder(args.out, ow, oh, fps_str, args, color)
    done, err = run_stream(dec, enc, up, w, h, args.outscale, nb, t("encoder_stopped"),
                           args.cleanup_noise, args.cleanup_edges)

    if err:
        return {"ok": False, "error": err}
    if enc.returncode not in (0, None):
        return {"ok": False, "error": t("ffmpeg_code", code=enc.returncode)}
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        return {"ok": False, "error": t("empty_output")}
    return {"ok": True, "output": args.out, "width": ow, "height": oh, "frames": done, "error": None}


def cmd_frame(args):
    """Décode UNE frame à --time, l'upscale, écrit 2 PNG (orig + upscalée) pour comparaison."""
    import numpy as np

    w, h, _fps_str, _fps, _nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("video_dimensions", detail=" : " + args.input)}

    # Même matrice colorimétrique que le run → l'aperçu avant/après correspond à la vraie sortie.
    raw = decode_one_frame(args.input, args.time, w, h, probe_color(args.input, w, h))
    if raw is None:
        return {"ok": False, "error": t("frame_missing", time=args.time)}
    frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
    is_black = float(frame.mean()) < 4.0   # frame quasi noire (fondu) → on prévient l'UI

    if not write_png(frame, args.orig):
        return {"ok": False, "error": t("write_source_png")}

    log("STAGE:load")
    up = get_upsampler(args.model, args.tile, args.fp32, args.denoise,
                       getattr(args, "tile_pad", 10), getattr(args, "pre_pad", 0))
    log("STAGE:infer")
    output, _ = up.enhance(frame, outscale=args.outscale)
    output = cleanup_frame(output, args.cleanup_noise, args.cleanup_edges)
    if not write_png(output, args.out):
        return {"ok": False, "error": t("write_upscaled_png")}

    oh, ow = output.shape[:2]
    return {"ok": True, "orig": args.orig, "out": args.out, "width": ow, "height": oh, "black": is_black, "error": None}


def cmd_image(args):
    """Upscale un FICHIER image (board de référence) → écrit un fichier image. cv2 lit/écrit en BGR
    (même convention que .enhance). Sortie en PNG (sans perte) quelle que soit l'extension demandée.
    L'alpha n'est pas upscalable par le modèle (RGB) → on le lit séparément avec Pillow (gère aussi
    PNG palette/tRNS), on le redimensionne à la taille de sortie puis on le réattache (BGRA)."""
    import cv2
    import numpy as np
    from PIL import Image

    img = cv2.imread(args.input, cv2.IMREAD_UNCHANGED)
    if img is None:
        return {"ok": False, "error": t("image_unreadable_path", path=args.input)}

    # Alpha source, lu avec Pillow plutôt qu'OpenCV seul : certains PNG indexés stockent la
    # transparence en tRNS et peuvent arriver côté cv2 sans 4e canal.
    alpha = None
    try:
        pil = Image.open(args.input)
        has_alpha = pil.mode in ("RGBA", "LA") or "transparency" in pil.info
        if has_alpha:
            alpha = np.array(pil.convert("RGBA").getchannel("A"))
    except Exception:  # noqa: BLE001
        alpha = img[:, :, 3] if img.ndim == 3 and img.shape[2] == 4 else None

    # Canaux couleur (gris → BGR ; BGRA → BGR).
    if img.ndim == 2:
        bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        bgr = img[:, :, :3]
    else:
        bgr = img[:, :, :3]

    log("STAGE:load")
    up = get_upsampler(args.model, args.tile, args.fp32, args.denoise,
                       getattr(args, "tile_pad", 10), getattr(args, "pre_pad", 0))
    log("STAGE:infer")
    output, _ = up.enhance(bgr, outscale=args.outscale)
    output = cleanup_frame(output, args.cleanup_noise, args.cleanup_edges)
    oh, ow = output.shape[:2]
    if alpha is not None:
        a = cv2.resize(alpha, (ow, oh), interpolation=cv2.INTER_LINEAR)
        output = np.ascontiguousarray(output[:, :, :3])
        output = cv2.merge([output[:, :, 0], output[:, :, 1], output[:, :, 2], a.astype("uint8")])  # BGRA

    if not cv2.imwrite(args.out, output) or not os.path.exists(args.out):
        return {"ok": False, "error": t("write_upscaled_image")}
    return {"ok": True, "output": args.out, "width": ow, "height": oh, "error": None}


# Valeurs par défaut d'une requête worker (les clés absentes du JSON prennent celles-ci).
FRAME_DEFAULTS = {"time": 0.0, "model": "light", "outscale": 2, "denoise": None, "tile": 0,
                  "tile_pad": 10, "pre_pad": 0, "fp32": False,
                  "cleanup_noise": 0.0, "cleanup_edges": 0.0}
IMAGE_DEFAULTS = {"model": "light", "outscale": 2, "denoise": None, "tile": 0,
                  "tile_pad": 10, "pre_pad": 0, "fp32": False,
                  "cleanup_noise": 0.0, "cleanup_edges": 0.0}
GIF_DEFAULTS = dict(IMAGE_DEFAULTS)
UPSCALE_DEFAULTS = {"model": "light", "outscale": 4, "codec": "x264", "start": None, "end": None,
                    "denoise": None, "tile": 0, "tile_pad": 10, "pre_pad": 0, "fp32": False,
                    "cleanup_noise": 0.0, "cleanup_edges": 0.0,
                    "quality": 20, "preset": "medium", "bitdepth": 8, "profile": None,
                    "audio": "copy", "abr": 192, "atrack": 0}


class Req:
    """Accès attribut (a.input, a.codec…) depuis un dict JSON, avec valeurs par défaut."""
    def __init__(self, d, defaults):
        for k, v in defaults.items():
            setattr(self, k, v)
        for k, v in d.items():
            setattr(self, k, v)
