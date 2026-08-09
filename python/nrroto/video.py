"""Écriture vidéo des moteurs de suppression d'objet : ffmpeg en pipe rawvideo.

Les images sont encodées AU FIL DE L'EAU (RAM constante quelle que soit la longueur du plan) au
lieu d'être empilées en mémoire. Source unique pour les deux moteurs — LaMa et MiniMax doivent
sortir exactement le même fichier, une divergence de codec entre eux serait invisible en dev et
se paierait au montage.
"""
import os
import subprocess

from nri18n import t

FFMPEG = os.environ.get("NETSURUSH_FFMPEG", "ffmpeg")
STDERR_TAIL = 400            # ffmpeg est bavard : on ne remonte que la fin, là où est la cause


class Canceled(Exception):
    """Annulation demandée en cours de rendu — distincte d'une erreur : rien n'est écrit, pas de
    message rouge. Vit ici parce que tout moteur de suppression écrit par ce writer et peut être
    interrompu entre deux images."""


def open_writer(out_path, size, fps):
    """Processus ffmpeg attendant du rgb24 brut sur stdin, écrivant `out_path` en H.264."""
    args = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % size,
            "-r", str(int(round(fps)) or 24), "-i", "-",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart",
            out_path]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)


def finish(writer):
    """Ferme le flux et lève si ffmpeg a échoué, en remontant sa vraie erreur."""
    writer.stdin.close()
    err = writer.stderr.read().decode("utf-8", "replace")
    if writer.wait() != 0:
        raise RuntimeError((err or t("ffmpeg_failed")).strip()[-STDERR_TAIL:])


def abort(writer, out_path):
    """Annulation : arrêt d'ffmpeg et suppression du fichier partiel.

    Une vidéo tronquée laissée sur le disque est un piège — elle s'ouvre et paraît valide."""
    try:
        writer.stdin.close()
        writer.wait()
    except OSError:
        pass
    try:
        os.remove(out_path)
    except OSError:
        pass
