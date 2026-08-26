"""Suppression de fond par frame (rembg) → sortie avec canal alpha. Streamé, STAGE:prog:i/n.

Formats : prores_4444 (.mov, import Resolve direct) / webm_alpha (.webm) / images PNG RGBA
(image unique quand la source est une image fixe, sinon séquence numérotée)."""
import os
from nri18n import t

from upscaler.imgout import image_spec, image_written, open_image_writer
from upscaler.log import log

from .dedup import DEAD_THR, run_perframe_dedup
from .media import open_decoder, open_encoder_alpha, probe
from .matte import cleanup_rgba


def _cutout_rgba(engine, bgr):
    """bgr (numpy HxWx3) → rgba (numpy HxWx4) via rembg (rgb in/out, alpha calculé)."""
    import numpy as np
    rgb = np.ascontiguousarray(bgr[:, :, ::-1])  # bgr → rgb
    out = engine.cutout(rgb)
    out = np.asarray(out)
    if out.ndim == 3 and out.shape[2] == 4:
        return np.ascontiguousarray(out)
    # Défensif : rembg renvoie normalement du RGBA ; sinon on ajoute un alpha opaque.
    if out.ndim == 3 and out.shape[2] == 3:
        h, w = out.shape[:2]
        a = np.full((h, w, 1), 255, np.uint8)
        return np.ascontiguousarray(np.concatenate([out, a], axis=2))
    raise RuntimeError(t("unexpected_rembg", shape=out.shape))


def cmd_removebg(args):
    """Détoure un segment vidéo (fond transparent). Sortie alpha : vidéo, image ou séquence."""
    try:
        from .runner import get_seg
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("removebg_unavailable", detail=" (rembg) : %s" % exc)}

    w, h, fps_str, _fps, nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("video_dimensions", detail=" : " + str(args.input))}

    fmt = getattr(args, "format", "prores_4444")
    dedup = bool(getattr(args, "dedup", False))
    thr = float(getattr(args, "dedup_thr", DEAD_THR) or DEAD_THR)

    log("STAGE:load")
    try:
        engine = get_seg(args.model)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("load_removebg_failed", detail=" (%s) : %s" % (args.model, exc))}
    log("STAGE:infer")

    import numpy as np

    # Sortie image : une image PNG RGBA, ou une séquence numérotée réglée par le hub. Le flux brut
    # est déjà en rgba (le détourage produit l'alpha), d'où `pix_in`.
    spec = image_spec(args, alpha=True)
    images = spec["kind"] != "video"
    dec = open_decoder(args.input, getattr(args, "start", None), getattr(args, "end", None))
    enc = (open_image_writer(args.out, w, h, fps_str, spec, pix_in="rgba") if images
           else open_encoder_alpha(args.out, w, h, fps_str, fmt, args))

    def process_fn(frame):
        return cleanup_rgba(
            _cutout_rgba(engine, frame),
            getattr(args, "despeckle", 0),
            getattr(args, "edge_smoothing", 0),
            getattr(args, "edge_offset", 0),
        )

    def write_fn(rgba, _idx):
        enc.stdin.write(np.ascontiguousarray(rgba).tobytes())

    done = 0
    err = None
    try:
        if dedup:
            # Dedup transverse : ne détoure que les frames uniques (frames mortes reprises).
            done, _computed, err = run_perframe_dedup(dec, np, w, h, nb, thr, process_fn, write_fn, log)
        else:
            frame_bytes = w * h * 3
            last_pct = -1
            while True:
                buf = dec.stdout.read(frame_bytes)
                if not buf or len(buf) < frame_bytes:
                    break
                frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                write_fn(process_fn(frame), done)
                done += 1
                if nb:
                    pct = int(done * 100 / nb)
                    if pct != last_pct:
                        last_pct = pct
                        log("STAGE:prog:%d/%d" % (done, nb))
    except BrokenPipeError:
        err = "ffmpeg encodeur alpha interrompu"
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

    # Une image UNIQUE fait sortir ffmpeg après sa première frame : le tuyau se ferme alors que le
    # décodeur en a encore. Ce n'est pas un échec tant que le fichier est écrit.
    if err and not (images and image_written(args.out, spec)):
        return {"ok": False, "error": err}
    if images:
        if not image_written(args.out, spec):
            return {"ok": False, "error": t("empty_alpha")}
    elif fmt == "png_seq":
        # Appel hérité (motif PNG sans réglage de sortie) : on vérifie la 1re image.
        if not os.path.exists(args.out % 1):
            return {"ok": False, "error": t("empty_alpha")}
    elif not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        return {"ok": False, "error": t("empty_output")}
    return {"ok": True, "output": args.out, "width": w, "height": h, "frames": done, "error": None}
