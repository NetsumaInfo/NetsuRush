"""Boucle streamée décode→enhance→encode, factorisée (upscale vidéo ET gif la partageaient).

Lit les frames rawvideo bgr24 du décodeur, les passe au upsampler, écrit la sortie dans
l'encodeur, émet la progression (STAGE:prog:i/n). Le caller fournit ses process déjà ouverts
et valide le résultat (codes de retour, fichier non vide) selon la commande."""
import numpy as np

from .cleanup import cleanup_frame
from .log import log


def run_stream(dec, enc, up, w, h, outscale, nb, broken_msg, cleanup_noise=0.0, cleanup_edges=0.0):
    """dec/enc = process ffmpeg ouverts ; up = upsampler. Retourne (done, err|None).
    Ferme les pipes et attend les process dans tous les cas (même sur erreur)."""
    frame_bytes = w * h * 3
    done = 0
    last_pct = -1
    err = None
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            output, _ = up.enhance(frame, outscale=outscale)
            output = cleanup_frame(output, cleanup_noise, cleanup_edges)
            enc.stdin.write(np.ascontiguousarray(output).tobytes())
            done += 1
            if nb:
                pct = int(done * 100 / nb)
                if pct != last_pct:
                    last_pct = pct
                    log("STAGE:prog:%d/%d" % (done, nb))
    except BrokenPipeError:
        err = broken_msg
    finally:
        try:
            dec.stdout.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            enc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        dec.wait()
        enc.wait()
    return done, err
