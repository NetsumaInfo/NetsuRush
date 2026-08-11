/*
 * host.jsx — point d'entrée ExtendScript (chargé par ScriptPath du manifest).
 * Dispatch par application : Premiere Pro (host-ppro.jsx) / After Effects (host-aeft.jsx).
 * Contrat de sortie : NR_getSnapshot() -> chaîne JSON AdobeSnapshot
 *   { app, appVersion, project, at, rushes:[…], sequences:[{ name,fps,w,h,tracks:[{kind,index,clips:[…]}] }] }
 * Temps TOUJOURS en secondes (les ticks Premiere sont convertis ici).
 * Jamais de dialogue modal : toute erreur revient en {ok:false,error}.
 */
/* global $, File, BridgeTalk, NRJSON, NR_ppro_snapshot, NR_aeft_snapshot, NR_ppro_place, NR_aeft_place, NR_aeft_runScript, NR_ppro_exportXml */

// Tentative de chargement des voisins via $.fileName (souvent vide sous CEP → try/catch).
// Le vrai chargement fiable est fait par le panneau (bootHost, chemin d'extension connu).
(function () {
  try {
    var dir = File($.fileName).parent.fsName.replace(/\\/g, "/");
    $.evalFile(dir + "/nrjson.jsx");
    $.evalFile(dir + "/host-ppro.jsx");
    $.evalFile(dir + "/host-aeft.jsx");
  } catch (e) {}
})();

function NR_getSnapshot() {
  try {
    if (BridgeTalk.appName === "premierepro") return NR_ppro_snapshot();
    return NR_aeft_snapshot();
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"snapshot failed"}';
    }
  }
}

/* Construit une séquence/comp depuis les plans découpés. `payload` = objet JS déjà littéral
 * (le panneau embarque le JSON dans le code eval → pas de JSON.parse en ES3).
 * payload = { name, input, segments:[{in,out,inFrame,outFrame}], fps?, mode?, whole? }. */
function NR_buildTimeline(payload) {
  try {
    if (BridgeTalk.appName === "premierepro") return NR_ppro_build(payload);
    return NR_aeft_build(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"build failed"}';
    }
  }
}

/* Recopie une timeline ENTIÈRE (positions absolues, pistes conservées) depuis le document
 * d'échange de NetsuRush. payload = { name, mode, timelineName, fps, width, height, duration,
 * clips:[{ path, kind, track, fps, inFrame, outFrame, tlStart, tlEnd }] }. */
function NR_placeTimeline(payload) {
  try {
    if (BridgeTalk.appName === "premierepro") return NR_ppro_place(payload);
    return NR_aeft_place(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"place failed"}';
    }
  }
}

/* Exécute un script écrit par NetsuRush dans l'hôte OUVERT. payload = { path }. After Effects
 * seulement : Premiere n'exécute pas de .jsx arbitraire depuis un panneau. */
function NR_runScript(payload) {
  try {
    if (BridgeTalk.appName === "premierepro") {
      return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "script hôte non supporté par Premiere Pro" });
    }
    return NR_aeft_runScript(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"script failed"}';
    }
  }
}

/* Exporte la séquence visée en FCP7 XML vers le chemin demandé. payload = { path, timelineName }.
 * Le fichier ne sert QU'À lire les images clés : la structure du transfert vient de l'API. */
function NR_exportXml(payload) {
  try {
    if (BridgeTalk.appName !== "premierepro") {
      return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "export XML non supporté par After Effects" });
    }
    // Ce dispatcher est le `ScriptPath` du manifeste : Adobe ne le charge qu'au démarrage de
    // l'application, alors que ses voisins sont rechargés par le panneau. Les deux peuvent donc
    // diverger — on le NOMME, au lieu de laisser filer une ReferenceError que rien n'explique.
    if (typeof NR_ppro_exportXml !== "function") {
      return NRJSON.stringify({ ok: false, errorCode: "HOST_STALE", error: "NR_ppro_exportXml absent : scripts hôtes périmés" });
    }
    return NR_ppro_exportXml(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"export xml failed"}';
    }
  }
}

/* Importe une timeline d'échange (FCP7 XML) comme séquence. payload = { path, name }. Premiere
 * seulement : c'est son importeur qui pose les titres, qu'aucune API ne sait créer. */
function NR_importTimeline(payload) {
  try {
    if (BridgeTalk.appName !== "premierepro") {
      return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "import de timeline non supporté par After Effects" });
    }
    // Ce dispatcher est le `ScriptPath` du manifeste : il peut diverger de ses voisins rechargés par
    // le panneau. On NOMME la fonction absente plutôt que de laisser filer une ReferenceError.
    if (typeof NR_ppro_importTimeline !== "function") {
      return NRJSON.stringify({ ok: false, errorCode: "HOST_STALE", error: "NR_ppro_importTimeline absent : scripts hôtes périmés" });
    }
    return NR_ppro_importTimeline(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"import timeline failed"}';
    }
  }
}

/* Importe des fichiers dans le projet de l'hôte. payload = { paths:[...] }. */
function NR_import(payload) {
  try {
    if (BridgeTalk.appName === "premierepro") return NR_ppro_import(payload);
    return NR_aeft_import(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"import failed"}';
    }
  }
}

/* NetsuBoost : purge de cache, hygiène projet, réglages, proxies. payload = { op, … } — chaque hôte
 * n'implémente que les opérations qui ont un sens chez lui et renvoie UNSUPPORTED_OP pour les autres. */
function NR_boost(payload) {
  try {
    if (BridgeTalk.appName === "premierepro") return NR_ppro_boost(payload);
    return NR_aeft_boost(payload);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"boost failed"}';
    }
  }
}
