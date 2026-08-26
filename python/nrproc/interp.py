"""Interpolation de frames (RIFE ncnn-vulkan). Insère `factor-1` frames intermédiaires entre
chaque paire de frames source → fluidité (factor× fps) ou ralenti (slow-mo, même fps).

Streamé : on garde la frame précédente, et pour chaque nouvelle frame on émet d'abord la
précédente puis les intermédiaires RIFE, enfin la dernière frame. Progression STAGE:prog:i/n.

Mode « frames mortes » (dedup) : les dessins animés sont souvent « sur 2s / 3s » → images source dupliquées.
Interpoler entre deux doublons = RIFE gèle puis saute (saccade). Quand `dedup` est actif on ignore les frames
mortes (dupliquées) et on ré-échantillonne le mouvement des frames UNIQUES sur la grille de sortie, réparti
selon leur écart temporel réel → durée conservée, mouvement lisse, et moins d'appels RIFE (plus rapide)."""
import os
from nri18n import t

from upscaler.imgout import image_spec, image_written, open_image_writer
from upscaler.log import log

from .dedup import DEAD_THR, frames_differ as _frames_differ
from .media import open_decoder, open_encoder_video, probe


def _run_plain(dec, enc, rife, np, w, h, factor, nb):
    """Interpolation classique : entre chaque paire de frames source, insère factor-1 images."""
    frame_bytes = w * h * 3
    done = 0
    written = 0
    last_pct = -1
    prev = None
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            cur = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            if prev is not None:
                # Émet la frame précédente, puis factor-1 intermédiaires entre prev et cur.
                enc.stdin.write(np.ascontiguousarray(prev).tobytes())
                written += 1
                for k in range(1, factor):
                    mid = rife.process(prev, cur, k / float(factor))
                    enc.stdin.write(np.ascontiguousarray(mid).tobytes())
                    written += 1
            prev = cur
            done += 1
            if nb:
                pct = int(done * 100 / nb)
                if pct != last_pct:
                    last_pct = pct
                    log("STAGE:prog:%d/%d" % (done, nb))
        # Dernière frame source (pas d'intermédiaire après elle).
        if prev is not None:
            enc.stdin.write(np.ascontiguousarray(prev).tobytes())
            written += 1
    except BrokenPipeError:
        return written, t("encoder_stopped")
    return written, None


def _run_dedup(dec, enc, rife, np, w, h, fps_in, nb, out_fps, factor, thr):
    """Interpolation « frames mortes » : ignore les doublons, ré-échantillonne le mouvement des
    frames uniques sur la grille de sortie (out_fps). Chaque écart entre deux frames uniques
    (ua→ub, séparé de `t-ta` secondes) reçoit round((t-ta)*out_fps) images interpolées → la durée
    est conservée et les images gelées des doublons disparaissent."""
    frame_bytes = w * h * 3
    fps_in = fps_in or (out_fps / max(1, factor))
    written = 0
    done = 0
    last_pct = -1
    ua = None   # dernière frame unique gardée
    ta = 0.0    # son instant source (secondes)
    err = None
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            cur = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            t = done / fps_in
            if ua is None:
                ua = cur
                ta = t
            elif _frames_differ(cur, ua, np, thr):
                # Nouvelle frame unique → remplit la grille de sortie sur [ta, t) par ua→cur.
                span = max(1, int(round((t - ta) * out_fps)))
                for j in range(span):
                    out = ua if j == 0 else rife.process(ua, cur, j / float(span))
                    enc.stdin.write(np.ascontiguousarray(out).tobytes())
                    written += 1
                ua = cur
                ta = t
            # sinon : frame morte (dupliquée) → ignorée
            done += 1
            if nb:
                pct = int(done * 100 / nb)
                if pct != last_pct:
                    last_pct = pct
                    log("STAGE:prog:%d/%d" % (done, nb))
        # Dernière frame unique conservée.
        if ua is not None:
            enc.stdin.write(np.ascontiguousarray(ua).tobytes())
            written += 1
    except BrokenPipeError:
        err = t("encoder_stopped")
    return written, err


def _scaled_fps(fps_str, factor):
    """Cadence source × `factor`, en gardant la FRACTION exacte (« 24000/1001 » → « 48000/1001 »).

    Une cadence NTSC repassée en flottant (23.976) dériverait sur un plan long : ffmpeg arrondit,
    et l'audio remis en face décale. Repli sur le flottant si la chaîne n'est pas une fraction."""
    try:
        num, den = (str(fps_str).split("/") + ["1"])[:2]
        return "%d/%d" % (int(num) * int(factor), int(den))
    except (TypeError, ValueError):
        return None


def cmd_interpolate(args):
    """Interpole un segment vidéo. Sortie = vidéo (codec d'upscaler.codecs) ou séquence d'images."""
    # Le moteur RIFE est importé paresseusement : un wheel manquant donne une erreur propre.
    try:
        from .runner import get_rife
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("interpolation_unavailable", detail=" (rife) : %s" % exc)}

    w, h, fps_str, fps_in, nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("video_dimensions", detail=" : " + str(args.input))}

    factor = max(2, int(getattr(args, "factor", 2)))

    # fps de SORTIE :
    #  - target_fps fixé → on vise cette cadence (le facteur reste le nombre d'intermédiaires).
    #  - slow-mo → factor× frames à la MÊME cadence (durée allongée = ralenti).
    #  - sinon → fps source × factor (fluidité, durée inchangée).
    target_fps = getattr(args, "target_fps", None)
    slowmo = bool(getattr(args, "slowmo", False))
    dedup = bool(getattr(args, "dedup", False))
    thr = float(getattr(args, "dedup_thr", DEAD_THR) or DEAD_THR)
    # `out_fps` sert la MATH de la grille de sortie (flottant) ; `out_fps_str` sert ffmpeg, qui
    # accepte une fraction exacte — d'où les deux valeurs plutôt qu'une seule arrondie.
    if target_fps:
        out_fps = float(target_fps)
        out_fps_str = str(target_fps)
    elif slowmo:
        out_fps = fps_in
        out_fps_str = fps_str
    else:
        out_fps = fps_in * factor
        out_fps_str = _scaled_fps(fps_str, factor) or str(out_fps)

    log("STAGE:load")
    try:
        rife = get_rife(args.model)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("load_rife_failed", detail=" (%s) : %s" % (args.model, exc))}
    log("STAGE:infer")

    import numpy as np

    # Sortie image : les frames interpolées sont écrites une par une, à la cadence de SORTIE (elle
    # ne sert qu'à horodater le flux brut — une séquence n'a pas de cadence propre).
    spec = image_spec(args)
    images = spec["kind"] != "video"
    dec = open_decoder(args.input, getattr(args, "start", None), getattr(args, "end", None))
    enc = (open_image_writer(args.out, w, h, out_fps_str, spec) if images
           else open_encoder_video(args.out, w, h, fps_str, args, out_fps=out_fps_str))

    try:
        if dedup:
            written, err = _run_dedup(dec, enc, rife, np, w, h, fps_in, nb, out_fps, factor, thr)
        else:
            written, err = _run_plain(dec, enc, rife, np, w, h, factor, nb)
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

    if err:
        return {"ok": False, "error": err}
    if images:
        if not image_written(args.out, spec):
            return {"ok": False, "error": t("empty_output")}
    elif not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        return {"ok": False, "error": t("empty_output")}
    return {"ok": True, "output": args.out, "width": w, "height": h, "frames": written, "error": None}
