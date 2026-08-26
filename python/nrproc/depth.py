"""Estimation de profondeur par frame (transformers depth-estimation). Depth relatif →
normalisation percentile p2/p98 → gris 8-bit (ou colormap cv2). Streamé, STAGE:prog:i/n.

Sortie : vidéo, image unique ou séquence d'images selon la demande du hub. Une sortie PNG 16-bit
est écrite en niveaux de gris VRAIMENT 16-bit (la depth map est le seul traitement du hub dont la
précision dépasse 8 bits) ; le colormap est alors sans objet."""
import os
from nri18n import t

from upscaler.imgout import image_spec, image_written, open_image_writer
from upscaler.log import log

from .dedup import DEAD_THR, run_perframe_dedup
from .media import open_decoder, open_encoder_video, probe

# Colormaps OpenCV par nom UI (gray = pas de colormap, niveaux de gris répliqués en 3 canaux).
_COLORMAPS = {
    "inferno": "COLORMAP_INFERNO",
    "magma": "COLORMAP_MAGMA",
    "viridis": "COLORMAP_VIRIDIS",
}


def _normalize_depth(depth_np):
    """Depth relatif (float) → gris 8-bit via étirement percentile p2/p98 (robuste aux extrêmes)."""
    import numpy as np
    d = depth_np.astype("float32")
    lo = float(np.percentile(d, 2))
    hi = float(np.percentile(d, 98))
    if hi - lo < 1e-6:
        hi = lo + 1e-6
    g = (d - lo) / (hi - lo)
    g = np.clip(g, 0.0, 1.0)
    return (g * 255.0).round().astype("uint8")


def _depth_to_bgr(gray8, colormap):
    """Gris 8-bit → bgr (colormap cv2 si demandée, sinon gris répliqué sur 3 canaux)."""
    import cv2
    import numpy as np
    name = _COLORMAPS.get(colormap)
    if name:
        return cv2.applyColorMap(gray8, getattr(cv2, name))
    return np.ascontiguousarray(np.repeat(gray8[:, :, None], 3, axis=2))


def _depth_gray_of(engine, bgr):
    """bgr → carte de profondeur 8-bit (gris) via le moteur (PIL RGB → depth PIL → np)."""
    import numpy as np
    from PIL import Image
    rgb = bgr[:, :, ::-1]  # bgr → rgb
    pil = Image.fromarray(rgb)
    depth_pil = engine.predict(pil)
    return _normalize_depth(np.asarray(depth_pil))


def cmd_depth(args):
    """Carte de profondeur d'un segment vidéo. Sortie = vidéo, image ou séquence d'images."""
    try:
        from .runner import get_depth
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("depth_unavailable", detail=" (transformers) : %s" % exc)}

    w, h, fps_str, _fps, nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("video_dimensions", detail=" : " + str(args.input))}

    bits = int(getattr(args, "bits", 8))
    colormap = getattr(args, "colormap", "gray") or "gray"
    dedup = bool(getattr(args, "dedup", False))
    thr = float(getattr(args, "dedup_thr", DEAD_THR) or DEAD_THR)

    log("STAGE:load")
    try:
        engine = get_depth(args.model)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("load_depth_failed", detail=" (%s) : %s" % (args.model, exc))}
    log("STAGE:infer")

    import numpy as np

    dec = open_decoder(args.input, getattr(args, "start", None), getattr(args, "end", None))

    spec = image_spec(args)
    images = spec["kind"] != "video"
    # Gris 16-bit : la profondeur est le seul traitement du hub dont la précision dépasse 8 bits, donc
    # on écrit chaque image nous-mêmes plutôt que de la faire transiter par un flux 8-bit.
    gray16 = images and spec["format"] == "png" and (bits >= 16 or spec["bits"] >= 16)
    enc = None
    if not images:
        enc = open_encoder_video(args.out, w, h, fps_str, args)
    elif not gray16:
        enc = open_image_writer(args.out, w, h, fps_str, spec)

    if gray16:
        import cv2

    # Modèle sur une frame bgr → gris 8-bit ; écriture d'une frame de sortie (image ou vidéo).
    def process_fn(frame):
        return _depth_gray_of(engine, frame)

    def write_fn(gray8, idx):
        if gray16:
            # Gris 8-bit ré-étiré sur 16 bits (×257 = réplication d'octet), une image par frame.
            g16 = (gray8.astype("uint16") * 257)  # 0..255 → 0..65535
            out = args.out if spec["kind"] == "image" else args.out % (spec["start"] + idx)
            cv2.imwrite(out, g16)
        else:
            bgr = _depth_to_bgr(gray8, colormap)
            enc.stdin.write(np.ascontiguousarray(bgr).tobytes())

    done = 0
    err = None
    try:
        if dedup:
            # Dedup transverse : ne calcule la profondeur que sur les frames uniques (frames mortes
            # reprises → même durée, moins d'appels modèle).
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
        err = t("encoder_stopped")
    finally:
        try:
            dec.stdout.close()
        except Exception:  # noqa: BLE001
            pass
        if enc is not None:
            try:
                enc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            enc.wait()
        dec.wait()

    if err:
        return {"ok": False, "error": err}
    if images:
        if not image_written(args.out, spec):
            return {"ok": False, "error": t("empty_depth")}
        return {"ok": True, "output": args.out, "width": w, "height": h, "frames": done, "error": None}
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        return {"ok": False, "error": t("empty_output")}
    return {"ok": True, "output": args.out, "width": w, "height": h, "frames": done, "error": None}
