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
