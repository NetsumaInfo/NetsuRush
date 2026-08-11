# core/resolve_helper.py
# Pont Resolve EXTERNE : pilote l'API scripting Resolve (DaVinciResolveScript) depuis un process
# Python persistant, piloté en JSON-lines sur stdin/stdout par core/resolve-bridge.js.
# Remplace WorkflowIntegration.node (in-process) pour l'app standalone.
#
# Protocole : entrée  {"id", "method", "params":{...}}
#             sortie  {"id", "ok":true, "result":...} | {"id", "ok":false, "error":"..."}
#
# Registre de handles : les objets Resolve (Project, MediaPool, MediaPoolItem, Timeline, Folder...)
# ne sont pas sérialisables → on renvoie {"__handle__": N, "__type__": "..."} et on les re-résout
# par id aux appels suivants (méthode "invoke"). Permet de garder la frame-math côté JS (timeline.js).

import sys
import hashlib
import json
import traceback

RESOLVE = None
REGISTRY = {}
_next = [1]


def connect():
    global RESOLVE
    # Idempotent : déjà connecté → ne pas ré-importer (coûteux), renvoyer l'état.
    if RESOLVE is not None:
        try:
            return {"connected": True, "version": RESOLVE.GetVersionString()}
        except Exception:
            # Le handle caché est MORT (Resolve fermé/rouvert depuis) → ne PAS mentir « connecté » :
            # on le jette et on retombe sur la réacquisition ci-dessous (scriptapp frais).
            RESOLVE = None
    # fusionscript.dll dépend d'autres DLL du dossier d'install Resolve. Depuis Python 3.8 il faut
    # os.add_dll_directory() (le PATH ne couvre plus les deps d'une extension chargée par chemin absolu)
    # sinon : "initialization of fusionscript failed without raising an exception".
    import os
    lib = os.environ.get(
        "RESOLVE_SCRIPT_LIB",
        r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll",
    )
    resolve_dir = os.path.dirname(lib)
    try:
        if hasattr(os, "add_dll_directory") and os.path.isdir(resolve_dir):
            os.add_dll_directory(resolve_dir)
    except Exception:
        pass
    try:
        import DaVinciResolveScript as dvr
    except Exception as e:
        return {"connected": False, "error": "DaVinciResolveScript introuvable: %s" % e}
    try:
        RESOLVE = dvr.scriptapp("Resolve")
    except Exception as e:
        RESOLVE = None
        return {"connected": False, "error": str(e)}
    if RESOLVE is None:
        return {"connected": False, "error": "Resolve non lancé ou scripting externe désactivé (Prefs > System > General > External Scripting Using = Local)"}
    try:
        ver = RESOLVE.GetVersionString()
    except Exception:
        ver = None
    return {"connected": True, "version": ver}


def register(obj):
    hid = _next[0]
    _next[0] += 1
    REGISTRY[hid] = obj
    return hid


def _scalar(v):
    return v is None or isinstance(v, (bool, int, float, str))


def wrap(v):
    if _scalar(v):
        return v
    if isinstance(v, (list, tuple)):
        return [wrap(x) for x in v]
    if isinstance(v, dict):
        return {k: wrap(x) for k, x in v.items()}
    # objet distant fusion → handle opaque
    return {"__handle__": register(v), "__type__": type(v).__name__}


def unwrap(a):
    if isinstance(a, dict) and "__handle__" in a:
        return REGISTRY.get(a["__handle__"])
    if isinstance(a, list):
        return [unwrap(x) for x in a]
    if isinstance(a, dict):
        return {k: unwrap(x) for k, x in a.items()}
    return a


def resolve_target(handle):
    """Resolve a call target, telling the two failure modes apart: no connection at all vs a handle
    the registry no longer holds (a concurrent `reset` purged it, or the helper respawned). The
    second one is a caller bug — bracket the operation (beginResolveOp) — and used to be reported
    as a connection failure, which sent debugging the wrong way."""
    if handle is None:
        if RESOLVE is None:
            raise RuntimeError("Resolve non connecté")
        return RESOLVE
    target = REGISTRY.get(handle)
    if target is None:
        raise RuntimeError(
            "handle %s périmé : registre purgé pendant l'opération (op Resolve non bracketée) "
            "ou helper relancé" % handle
        )
    return target


def do_attr(handle, name):
    """Lecture d'un ATTRIBUT (non appelable) : les constantes d'export de Resolve
    (EXPORT_FCP_7_XML, EXPORT_AAF...) ne sont pas des méthodes, et le proxy JS ne sait forwarder
    que des appels. Les coder en dur côté JS les figerait sur une version de Resolve."""
    return wrap(getattr(resolve_target(handle), name))


def do_invoke(handle, method, args):
    target = resolve_target(handle)
    fn = getattr(target, method)
    res = fn(*[unwrap(a) for a in (args or [])])
    return wrap(res)


# Agrégat : parcours récursif du Media Pool en UN appel (évite N round-trips de GetClipProperty).
PROPS = ["File Path", "FPS", "Frames", "Duration", "Resolution", "Format"]


def list_media_pool():
    if RESOLVE is None:
        raise RuntimeError("Resolve non connecté")
    pm = RESOLVE.GetProjectManager()
    proj = pm.GetCurrentProject() if pm else None
    if not proj:
        raise RuntimeError("aucun projet ouvert")
    mp = proj.GetMediaPool()
    out = []

    def walk(folder, prefix):
        for it in (folder.GetClipList() or []):
            props = {}
            for k in PROPS:
                try:
                    props[k] = it.GetClipProperty(k)
                except Exception:
                    props[k] = None
            out.append({"name": it.GetName(), "bin": prefix, "props": props})
        for sub in (folder.GetSubFolderList() or []):
            try:
                sub_name = sub.GetName() or ""
            except Exception:
                sub_name = ""
            walk(sub, (prefix + "/" + sub_name) if prefix else sub_name)

    walk(mp.GetRootFolder(), "")
    return {"project": proj.GetName(), "clips": out}


# Agrégat : lecture des items vidéo d'une timeline en UN appel (l'ouverture d'une timeline faisait
# ~5 round-trips PAR plan via le proxy JS). On collecte ici les propriétés BRUTES ; toute la
# frame-math (inclusif/exclusif, clamp, remap) reste côté JS (timeline.js).
def read_timeline(name=None):
    if RESOLVE is None:
        raise RuntimeError("Resolve non connecté")
    pm = RESOLVE.GetProjectManager()
    proj = pm.GetCurrentProject() if pm else None
    if not proj:
        raise RuntimeError("aucun projet ouvert")
    tl = None
    if name:
        count = int(proj.GetTimelineCount() or 0)
        for i in range(1, count + 1):
            t = proj.GetTimelineByIndex(i)
            if t and t.GetName() == name:
                tl = t
                break
        if tl is None:
            return {"found": False, "timeline": name, "items": []}
    else:
        tl = proj.GetCurrentTimeline()
        if tl is None:
            return {"found": False, "timeline": None, "items": []}
    tl_name = tl.GetName()
    items = []
    # Métadonnées source par chemin (FPS/Frames/Nom identiques pour tous les plans d'un même rush).
    prop_cache = {}
    v_count = int(tl.GetTrackCount("video") or 0)
    for t in range(1, v_count + 1):
        # Nom de la piste (« V2 », « Titres », « B-roll »…) : un seul appel par PISTE, pas par plan.
        # Resolve nomme « Video N » par défaut ; la normalisation vit côté JS (timeline.js).
        try:
            track_name = tl.GetTrackName("video", t) or ""
        except Exception:
            track_name = ""  # API absente sur une version ancienne : la piste garde son numéro
        for it in (tl.GetItemListInTrack("video", t) or []):
            try:
                mpi = it.GetMediaPoolItem()
                if not mpi:
                    continue  # titres / générateurs / Fusion : pas de média source
                fp = mpi.GetClipProperty("File Path")
                if not fp:
                    continue
                meta = prop_cache.get(fp)
                if meta is None:
                    props = mpi.GetClipProperty() or {}
                    meta = {
                        "fps": props.get("FPS"),
                        "frames": props.get("Frames"),
                        "clipName": props.get("Clip Name") or mpi.GetName(),
                    }
                    prop_cache[fp] = meta
                row = {"track": t, "trackName": track_name, "path": fp}
                row.update(meta)
                try:
                    row["ssf"] = it.GetSourceStartFrame()
                    row["sef"] = it.GetSourceEndFrame()
                except Exception:
                    row["ssf"] = None
                    row["sef"] = None
                if row["ssf"] is None or row["sef"] is None:
                    try:
                        row["lo"] = it.GetLeftOffset()
                        row["dur"] = it.GetDuration()
                    except Exception:
                        pass
                try:
                    row["start"] = it.GetStart()
                except Exception:
                    row["start"] = 0
                items.append(row)
            except Exception:
                continue  # item illisible : on saute
    return {"found": True, "timeline": tl_name, "items": items}


def timeline_fingerprint(tl):
    """Empreinte de la timeline courante, sans décoder ni lire les médias."""
    rows = []
    if tl:
        try:
            rows.append(["timeline", tl.GetName() or ""])
            tracks = int(tl.GetTrackCount("video") or 0)
        except Exception:
            tracks = 0
        for track in range(1, tracks + 1):
            for item in (tl.GetItemListInTrack("video", track) or []):
                try:
                    mpi = item.GetMediaPoolItem()
                    source = ""
                    if mpi:
                        try:
                            source = mpi.GetClipProperty("File Path") or mpi.GetName() or ""
                        except Exception:
                            source = ""
                    try:
                        source_start = item.GetSourceStartFrame()
                        source_end = item.GetSourceEndFrame()
                    except Exception:
                        source_start = item.GetLeftOffset()
                        source_end = source_start + item.GetDuration()
                    rows.append([
                        track, source, item.GetStart(), item.GetDuration(), source_start, source_end,
                    ])
                except Exception:
                    continue
    raw = repr(rows).encode("utf-8", errors="replace")
    return hashlib.sha1(raw).hexdigest()


# Signature LÉGÈRE de l'état Resolve pour le polling de synchro (renderer). Compte les clips SANS
# lire leurs propriétés (GetClipProperty = round-trips coûteux) → diff bon marché côté core/watch.
def resolve_sig():
    global RESOLVE
    if RESOLVE is None:
        return {"connected": False}
    try:
        pm = RESOLVE.GetProjectManager()
        proj = pm.GetCurrentProject() if pm else None
    except Exception as e:
        # Handle mort (Resolve fermé) → on le jette pour forcer une réacquisition au prochain connect().
        RESOLVE = None
        return {"connected": False, "error": str(e)}
    if not proj:
        return {"connected": True, "project": None, "timeline": None, "clipCount": 0, "tlCount": 0}
    tl = None
    try:
        tl = proj.GetCurrentTimeline()
        timeline = tl.GetName() if tl else None
    except Exception:
        timeline = None
    try:
        tl_count = int(proj.GetTimelineCount() or 0)
    except Exception:
        tl_count = 0
    try:
        tl_fingerprint = timeline_fingerprint(tl)
    except Exception:
        tl_fingerprint = None
    clip_count = 0
    try:
        mp = proj.GetMediaPool()

        def count(folder):
            n = len(folder.GetClipList() or [])
            for sub in (folder.GetSubFolderList() or []):
                n += count(sub)
            return n

        clip_count = count(mp.GetRootFolder())
    except Exception:
        clip_count = -1
    return {
        "connected": True,
        "project": proj.GetName(),
        "timeline": timeline,
        "clipCount": clip_count,
        "tlCount": tl_count,
        "tlFingerprint": tl_fingerprint,
    }


HANDLERS = {
    "connect": lambda p: connect(),
    "status": lambda p: {"connected": RESOLVE is not None},
    "reset": lambda p: (REGISTRY.clear(), {"ok": True})[1],
    "invoke": lambda p: do_invoke(p.get("handle"), p["method"], p.get("args")),
    "attr": lambda p: do_attr(p.get("handle"), p["name"]),
    "listMediaPool": lambda p: list_media_pool(),
    "readTimeline": lambda p: read_timeline(p.get("name")),
    "resolveSig": lambda p: resolve_sig(),
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        rid = msg.get("id")
        try:
            h = HANDLERS.get(msg.get("method"))
            if not h:
                raise RuntimeError("méthode inconnue: %s" % msg.get("method"))
            result = h(msg.get("params") or {})
            out = {"id": rid, "ok": True, "result": result}
        except Exception as e:
            out = {"id": rid, "ok": False, "error": "%s\n%s" % (e, traceback.format_exc())}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
