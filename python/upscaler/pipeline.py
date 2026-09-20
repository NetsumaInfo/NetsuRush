"""Boucle streamée décode→enhance→encode, factorisée (upscale vidéo ET gif la partageaient).

Lit les frames rawvideo bgr24 du décodeur, les passe au upsampler, écrit la sortie dans
l'encodeur, émet la progression (STAGE:prog:i/n). Le caller fournit ses process déjà ouverts
et valide le résultat (codes de retour, fichier non vide) selon la commande."""
import numpy as np

from .cleanup import cleanup_frame
from .log import log
from .plan import resize_to


def run_stream(dec, enc, up, w, h, out_size, nb, broken_msg, cleanup_noise=0.0, cleanup_edges=0.0):
    """dec/enc = open ffmpeg processes; up = upsampler. Returns (done, err|None).

    w×h = frames as decoded, already sized for the network. out_size = (w, h) the encoder expects:
    the network renders at its native factor and its result is reduced to that size.
    Pipes are closed and processes awaited in every case, errors included."""
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
            output, _ = up.enhance(frame)
            output = cleanup_frame(resize_to(output, out_size), cleanup_noise, cleanup_edges)
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
