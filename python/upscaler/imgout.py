"""Ecriture d'images fixes et de sequences d'images (PNG / JPEG) pour tout le hub.

Meme contrat que `codecs.video_codec_args` pour la video : le core resout les arguments ffmpeg et
les passe dans la requete (`image_args`), et ce module sait aussi les reconstruire seul pour un
appel CLI direct. Une seule table cote Node (core/imageOutput.js) et une seule ici.

Le PNG est SANS PERTE quel que soit le niveau de compression : seuls le temps d'ecriture et le
poids changent. Le JPEG, lui, quantifie (et n'a pas d'alpha) : le detourage n'en propose pas.
"""
import os
import subprocess

from ffbin import ffmpeg_bin

IMAGE_EXT = {"png": "png", "jpeg": "jpg", "jpg": "jpg"}


def image_ext(fmt):
    return IMAGE_EXT.get(str(fmt or "png"), "png")


def jpeg_qscale(quality):
    """1..100 (familier) -> -q:v mjpeg 2..31 (2 = meilleur). Echelle inversee, bornee."""
    q = max(1, min(100, int(quality or 92)))
    return max(2, min(31, int(round(31 - ((q - 1) * 29) / 99.0))))


def image_encode_args(fmt="png", bits=8, compression=6, quality=92, alpha=False):
    """Arguments d'encodage d'UNE image. Repli local quand le core n'en fournit pas (appel CLI)."""
    if str(fmt) in ("jpeg", "jpg"):
        # Pas d'alpha en JPEG ; 4:4:4 pour ne pas cribler les aplats d'artefacts de chroma.
        return ["-c:v", "mjpeg", "-q:v", str(jpeg_qscale(quality)), "-pix_fmt", "yuvj444p"]
    pix = ("rgba64be" if alpha else "rgb48be") if int(bits or 8) >= 16 else ("rgba" if alpha else "rgb24")
    return ["-c:v", "png", "-compression_level", str(max(0, min(9, int(compression or 6)))), "-pix_fmt", pix]


def image_spec(a, alpha=False):
    """Reglages image d'une requete (Req worker ou namespace argparse).

    `kind` : "video" (defaut, rien ne change), "sequence" (motif numerote) ou "image" (fichier
    unique). `args` = arguments ffmpeg deja resolus par le core, sinon reconstruits ici."""
    kind = str(getattr(a, "out_kind", "video") or "video")
    if kind not in ("sequence", "image"):
        kind = "video"
    fmt = str(getattr(a, "img_format", "png") or "png")
    bits = int(getattr(a, "png_bits", 8) or 8)
    compression = int(getattr(a, "png_compression", 6) or 6)
    quality = int(getattr(a, "jpeg_quality", 92) or 92)
    args = getattr(a, "image_args", None)
    return {
        "kind": kind,
        "format": fmt,
        "ext": image_ext(fmt),
        "bits": bits,
        "compression": compression,
        "quality": quality,
        "start": int(getattr(a, "seq_start", 1) or 0),
        "alpha": bool(alpha),
        "args": list(args) if args else image_encode_args(fmt, bits, compression, quality, alpha),
    }


def open_image_writer(out_path, w, h, fps_str, spec, pix_in="bgr24"):
    """Entree rawvideo -> images ecrites par ffmpeg (une seule, ou une sequence numerotee).

    `out_path` est un motif `dir/base_%06d.png` pour une sequence, un chemin de fichier pour une
    image unique. Aucun audio : une image n'en porte pas."""
    args = [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", pix_in, "-s", "%dx%d" % (w, h), "-r", str(fps_str), "-i", "pipe:0",
            "-map", "0:v:0"]
    args += list(spec["args"])
    args += ["-an"]
    if spec["kind"] == "image":
        # -update 1 : ffmpeg accepte un chemin SANS motif de numerotation pour une image unique.
        args += ["-frames:v", "1", "-update", "1"]
    else:
        args += ["-start_number", str(spec["start"])]
    args += [out_path]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)


def sequence_first(out_path, spec):
    """Chemin de la PREMIERE image ecrite : sert a verifier qu'une sequence a bien demarre."""
    if spec["kind"] == "image":
        return out_path
    try:
        return out_path % spec["start"]
    except (TypeError, ValueError):
        return out_path


def image_written(out_path, spec):
    """La sortie image existe-t-elle et n'est-elle pas vide ?"""
    first = sequence_first(out_path, spec)
    return os.path.exists(first) and os.path.getsize(first) > 0


def cv_write_params(spec):
    """Parametres cv2.imwrite equivalents (chemin OpenCV de cmd_image, qui preserve l'alpha)."""
    import cv2
    if spec["format"] in ("jpeg", "jpg"):
        return [int(cv2.IMWRITE_JPEG_QUALITY), max(1, min(100, spec["quality"]))]
    return [int(cv2.IMWRITE_PNG_COMPRESSION), max(0, min(9, spec["compression"]))]
