"""Daemon Roto Studio (segmentation interactive SAM2 multi-objets + export alpha).

Lancé par core/roto.js comme `python roto.py serve` : worker persistant qui tient UNE RotoSession en
mémoire (état vidéo + points + masques entre les requêtes). Protocole JSON-lines identique à process.py
(1 requête/ligne stdin → 1 réponse/ligne stdout, même `id` ; progression sur stderr STAGE:*).

Une seule session à la fois (une vidéo ouverte à l'instant t) — suffisant pour l'UX click-then-wait."""
import json
import sys

# Rend le package nrroto importable quel que soit le cwd du spawn.
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))

from nrroto.session import RotoSession


def serve():
    session = RotoSession()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "open":
                res = session.open(req.get("video"), req.get("in"), req.get("out"),
                                   req.get("samDir"), req.get("samModel"))
            elif cmd == "addPoint":
                res = session.add_point(req.get("frame", 0), req.get("x", 0), req.get("y", 0),
                                        req.get("label", 1), req.get("obj", 1))
            elif cmd == "clearPoints":
                res = session.clear_points(req.get("frame"), req.get("obj"))
            elif cmd == "undoPoint":
                res = session.undo_point()
            elif cmd == "previewPoint":
                res = session.preview_point(req.get("frame", 0), req.get("x", 0), req.get("y", 0),
                                            req.get("label", 1), req.get("obj", 1))
            elif cmd == "mask":
                res = session.mask(req.get("frame", 0))
            elif cmd == "setPost":
                res = session.set_post(req.get("grow"), req.get("feather"),
                                       req.get("holes"), req.get("dots"),
                                       req.get("border"), req.get("smooth"), req.get("gamma"),
                                       req.get("harden"))
            elif cmd == "setView":
                res = session.set_view(req.get("mode"), req.get("outline"), req.get("bg"))
            elif cmd == "setObjects":
                res = session.set_objects(req.get("names"))
            elif cmd == "removePoint":
                res = session.remove_point(req.get("frame", 0), req.get("obj", 1), req.get("index", -1))
            elif cmd == "movePoint":
                res = session.move_point(req.get("frame", 0), req.get("obj", 1), req.get("index", -1),
                                         req.get("x", 0), req.get("y", 0))
            elif cmd == "clearTracking":
                res = session.clear_tracking()
            elif cmd == "dedupe":
                res = session.dedupe(req.get("threshold"), req.get("restore", False))
            elif cmd == "propagate":
                res = session.propagate(req.get("mode", "all"), req.get("frame"),
                                        req.get("inF"), req.get("outF"), req.get("count"))
            elif cmd == "refine":
                res = session.refine(req.get("engine", "matanyone"), obj=req.get("obj"),
                                     combined=req.get("combined", False),
                                     warmup=req.get("warmup"), max_size=req.get("maxSize"),
                                     batch=req.get("batch"), overlap=req.get("overlap"),
                                     frame=req.get("frame"))
            elif cmd == "testPreview":
                res = session.test_preview()
            elif cmd == "setRefined":
                res = session.set_refined(req.get("on", True))
            elif cmd == "export":
                res = session.export(req.get("format", "prores_4444"), req.get("out"),
                                     req.get("mode"), req.get("obj"), req.get("bg"))
            elif cmd == "objectRemove":
                res = session.object_remove(req.get("engine", "lama"), req.get("out"),
                                            req.get("steps"), req.get("grow"), req.get("frame"),
                                            req.get("plate"), req.get("harmonize"),
                                            req.get("grain"), req.get("quality"),
                                            req.get("seed"), req.get("window"),
                                            req.get("overlap"), req.get("vaeTiling"),
                                            req.get("cpuOffload"))
            else:
                res = {"ok": False, "error": "commande inconnue: %s" % cmd}
        except Exception as exc:  # noqa: BLE001
            res = {"ok": False, "error": str(exc)}
        if rid is not None:
            res["id"] = rid
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
    else:
        sys.stderr.write("usage: roto.py serve\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
