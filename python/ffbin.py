"""Binaires ffmpeg/ffprobe des sidecars Python. Source UNIQUE côté Python.

Le core Node injecte les chemins absolus via NETSURUSH_FFMPEG / NETSURUSH_FFPROBE
(cf. core/config.js : bundle = ffmpeg GPL provisionné hors PATH). Sans ces env (dev
avec ffmpeg dans le PATH), on retombe sur le nom nu résolu par le PATH.

À utiliser PARTOUT où un sidecar appelle ffmpeg/ffprobe : sinon, sur un build packagé
sans ffmpeg système, détection de plans + indexation/recherche échouent en silence.
"""
import os


def ffmpeg_bin():
    return os.environ.get("NETSURUSH_FFMPEG") or "ffmpeg"


def ffprobe_bin():
    return os.environ.get("NETSURUSH_FFPROBE") or "ffprobe"


def expose_on_path():
    """Put the configured ffmpeg/ffprobe folders first on PATH.

    Third-party packages (ffmpeg-python, used by OmniShotCut) spawn the bare `ffmpeg` /
    `ffprobe` names, so a bundled ffmpeg outside PATH must be made visible to them.
    """
    dirs = []
    for exe in (ffmpeg_bin(), ffprobe_bin()):
        d = os.path.dirname(exe)
        if d and d not in dirs:
            dirs.append(d)
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
