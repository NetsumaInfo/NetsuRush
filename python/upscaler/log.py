"""Progression du sidecar : marqueurs STAGE:* sur stderr, parsés par core/sidecars.js
(STAGE:load / STAGE:infer / STAGE:prog:i/n → barre de progression réelle)."""
import sys


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()
