#!/usr/bin/env python3
"""NetsuRush — point d'entrée du sidecar de recherche de plans (SigLIP 2 + cache SQLite).

Recherche sémantique par embeddings visuels : SigLIP 2 avec L2-normalisation des embeddings,
similarité cosinus via produit scalaire, top_k retrieval. On utilise la détection de plans
de NetsuRush (detect.py) et on embed 1 frame représentative par plan détecté.
La logique est découpée dans le package `nrsearch` (voir son docstring) ; ce fichier ne garde que
le dispatch des commandes, le daemon `serve` et le CLI.

Commandes :
  python search.py index <video>              -> embed 1 frame/plan, met en cache, JSON
  python search.py query <texte> [top_k]      -> recherche texte, JSON {hits:[...]}
  python search.py query-image <image> [top_k]-> recherche par image, JSON {hits:[...]}
  python search.py status                      -> {clips, frames, model}
  python search.py serve                       -> daemon JSON ligne-à-ligne (stdin → stdout)

Sortie stdout = 1 ligne JSON. Progression sur stderr (STAGE:load / STAGE:infer / STAGE:prog:i/n),
routée vers le core pour progression en UI.
"""
import json
import sys
from nri18n import t

from nrsearch.catalog import cmd_indexed, cmd_shots, cmd_status
from nrsearch.characters import (
    cmd_char_add_sample, cmd_char_create, cmd_char_delete, cmd_char_duplicates, cmd_char_identify,
    cmd_char_label_index, cmd_char_list, cmd_char_merge, cmd_char_remove_sample, cmd_char_samples,
    cmd_char_search, cmd_char_shots, cmd_char_update,
)
from nrsearch.faces import (
    cmd_face_detect, cmd_face_engines, cmd_face_gallery, cmd_face_index, cmd_face_indexed,
    cmd_face_search, cmd_face_status,
)
from nrsearch.index import cmd_index
from nrsearch.query import cmd_cluster, cmd_dedup, cmd_query, cmd_query_image, cmd_search, cmd_warm


def _dispatch(cmd, req):
    if cmd == "warm":
        return cmd_warm()
    if cmd == "index":
        return cmd_index(req.get("path", ""), bool(req.get("force")), req.get("frames"),
                         cut_model=req.get("model"), detect_options=req.get("options") or {})
    if cmd == "shots":
        return cmd_shots(req.get("path", ""))
    if cmd == "face-index":
        return cmd_face_index(req.get("path", ""), bool(req.get("force")), cut_model=req.get("model"), detect_options=req.get("options") or {})
    if cmd == "face-detect":
        return cmd_face_detect(req)
    if cmd == "face-search":
        return cmd_face_search(req)
    if cmd == "face-status":
        return cmd_face_status(req.get("file_paths") if "file_paths" in req else None)
    if cmd == "face-engines":
        return cmd_face_engines()
    if cmd == "face-indexed":
        return cmd_face_indexed()
    if cmd == "face-gallery":
        return cmd_face_gallery(req)
    if cmd == "char-list":
        return cmd_char_list(req.get("file_paths") if "file_paths" in req else None)
    if cmd == "char-create":
        return cmd_char_create(req)
    if cmd == "char-update":
        return cmd_char_update(req)
    if cmd == "char-delete":
        return cmd_char_delete(req)
    if cmd == "char-merge":
        return cmd_char_merge(req)
    if cmd == "char-duplicates":
        return cmd_char_duplicates(req)
    if cmd == "char-add-sample":
        return cmd_char_add_sample(req)
    if cmd == "char-remove-sample":
        return cmd_char_remove_sample(req)
    if cmd == "char-samples":
        return cmd_char_samples(req)
    if cmd == "char-identify":
        return cmd_char_identify(req)
    if cmd == "char-search":
        return cmd_char_search(req)
    if cmd == "char-label-index":
        return cmd_char_label_index(req)
    if cmd == "char-shots":
        return cmd_char_shots(req)
    if cmd == "search":
        return cmd_search(req)
    if cmd == "query":
        return cmd_query(req.get("text", ""), int(req.get("top_k", 60)))
    if cmd == "query-image":
        return cmd_query_image(req.get("path", ""), int(req.get("top_k", 60)))
    if cmd == "dedup":
        return cmd_dedup(req)
    if cmd == "cluster":
        return cmd_cluster(req)
    if cmd == "indexed":
        return cmd_indexed()
    return cmd_status(req.get("file_paths") if "file_paths" in req else None)


def serve():
    """Daemon : modèle chargé 1 fois, traite des commandes JSON {id,cmd,...} sur stdin,
    répond {id,result} sur stdout. stdout est protégé (tout print parasite → stderr) pour
    ne jamais casser le protocole ligne-JSON."""
    import contextlib
    # Windows : la locale console est cp1252 → JSON entrant (chemins accentués) mojibaké.
    # Force UTF-8 des deux côtés du protocole ligne-JSON.
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    real_out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        rid = req.get("id")
        try:
            with contextlib.redirect_stdout(sys.stderr):
                res = _dispatch(req.get("cmd"), req)
        except ImportError as exc:
            res = {"hits": [], "ok": False, "error": t("siglip_missing", error=exc)}
        except Exception as exc:  # noqa: BLE001
            res = {"hits": [], "ok": False, "error": str(exc)}
        real_out.write(json.dumps({"id": rid, "result": res}) + "\n")
        real_out.flush()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "serve":
        serve()
        return
    try:
        if cmd == "index":
            print(json.dumps(cmd_index(sys.argv[2])))
        elif cmd == "query":
            top_k = int(sys.argv[3]) if len(sys.argv) > 3 else 60
            print(json.dumps(cmd_query(sys.argv[2], top_k)))
        elif cmd == "query-image":
            top_k = int(sys.argv[3]) if len(sys.argv) > 3 else 60
            print(json.dumps(cmd_query_image(sys.argv[2], top_k)))
        elif cmd == "indexed":
            print(json.dumps(cmd_indexed()))
        else:
            print(json.dumps(cmd_status()))
    except ImportError as exc:
        print(json.dumps({"hits": [], "ok": False,
                          "error": t("siglip_missing", error=exc)}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"hits": [], "ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
