"""Aperçu d'UNE frame (orig + traité) pour les 3 modes du hub (interpolate/depth/removebg).

Écrit 2 PNG : l'original à `time`, et le résultat selon `mode` :
  depth      → carte de profondeur de cette frame.
  removebg   → détourage RGBA (PNG avec alpha).
  interpolate→ frame interpolée à mi-chemin (t=0.5) entre cette frame et la suivante."""
from nri18n import t
from upscaler.log import log

from .media import (decode_one_frame, probe, write_png, write_png_rgba)


def cmd_frame(args):
    """Décode la frame à --time, écrit l'orig, puis le résultat traité selon --mode."""
    import numpy as np

    w, h, _fps_str, fps, _nb = probe(args.input)
    if not w or not h:
        return {"ok": False, "error": t("video_dimensions", detail=" : " + str(args.input))}

    raw = decode_one_frame(args.input, args.time, w, h)
    if raw is None:
        return {"ok": False, "error": t("frame_missing", time=args.time)}
    frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)

    if not write_png(frame, args.orig):
        return {"ok": False, "error": t("write_source_png")}

    mode = getattr(args, "mode", "depth")

    if mode == "depth":
        return _frame_depth(args, frame, w, h)
    if mode == "removebg":
        return _frame_removebg(args, frame, w, h)
    if mode == "interpolate":
        return _frame_interpolate(args, frame, w, h, fps)
    return {"ok": False, "error": t("unknown_preview_mode", mode=mode)}


def _frame_depth(args, frame, w, h):
    try:
        from .depth import _depth_gray_of, _depth_to_bgr
        from .runner import get_depth
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("depth_unavailable", detail=" : %s" % exc), "orig": args.orig}
    log("STAGE:load")
    try:
        engine = get_depth(args.model)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("load_depth_failed", detail=" : %s" % exc), "orig": args.orig}
    log("STAGE:infer")
    gray8 = _depth_gray_of(engine, frame)
    bgr = _depth_to_bgr(gray8, getattr(args, "colormap", "gray") or "gray")
    if not write_png(bgr, args.out):
        return {"ok": False, "error": t("write_depth_png")}
    return {"ok": True, "orig": args.orig, "out": args.out, "width": w, "height": h, "error": None}


def _frame_removebg(args, frame, w, h):
    try:
        from .runner import get_seg
        from .seg import _cutout_rgba
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("removebg_unavailable", detail=" : %s" % exc), "orig": args.orig}
    log("STAGE:load")
    try:
        engine = get_seg(args.model)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("load_removebg_failed", detail=" : %s" % exc), "orig": args.orig}
    log("STAGE:infer")
    rgba = _cutout_rgba(engine, frame)
    from .matte import cleanup_rgba
    rgba = cleanup_rgba(
        rgba,
        getattr(args, "despeckle", 0),
        getattr(args, "edge_smoothing", 0),
        getattr(args, "edge_offset", 0),
    )
    if not write_png_rgba(rgba, args.out):
        return {"ok": False, "error": t("write_alpha_png")}
    return {"ok": True, "orig": args.orig, "out": args.out, "width": w, "height": h, "error": None}


def _frame_interpolate(args, frame, w, h, fps):
    import numpy as np
    try:
        from .runner import get_rife
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("interpolation_unavailable", detail=" : %s" % exc), "orig": args.orig}
    # Frame suivante (≈ 1 frame après `time`) pour interpoler à mi-chemin.
    dt = 1.0 / float(fps or 24.0)
    raw_next = decode_one_frame(args.input, float(args.time) + dt, w, h)
    if raw_next is None:
        # Pas de frame suivante (fin du clip) → l'aperçu interpolé = la frame elle-même.
        if not write_png(frame, args.out):
            return {"ok": False, "error": t("write_preview_png")}
        return {"ok": True, "orig": args.orig, "out": args.out, "width": w, "height": h, "error": None}
    nxt = np.frombuffer(raw_next, np.uint8).reshape(h, w, 3)
    log("STAGE:load")
    try:
        rife = get_rife(args.model)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": t("load_rife_failed", detail=" : %s" % exc), "orig": args.orig}
    log("STAGE:infer")
    mid = rife.process(frame, nxt, 0.5)
    if not write_png(np.ascontiguousarray(mid), args.out):
        return {"ok": False, "error": t("write_interpolated_png")}
    return {"ok": True, "orig": args.orig, "out": args.out, "width": w, "height": h, "error": None}
