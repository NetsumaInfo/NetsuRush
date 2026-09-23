/*
 * host.jsx - ExtendScript entry point (loaded through the manifest's ScriptPath).
 * Dispatches per application: Premiere Pro (host-ppro.jsx) / After Effects (host-aeft.jsx).
 * Output contract: NR_getSnapshot(text) -> AdobeSnapshot JSON string
 *   { app, appVersion, project, at, rushes:[...], sequences:[{ name,fps,w,h,tracks:[{kind,index,clips:[...]}] }] }
 * Times ALWAYS in seconds (Premiere ticks are converted here).
 * Never a modal dialog: every error comes back as {ok:false,errorCode?,error}. `error` is English
 * developer text; the panel shows the user the text of `errorCode` in the interface language.
 * `text` / `payload.nrText` carry the few names these scripts write into the project, already in
 * the interface language (the panel knows it, the host scripts do not).
 */
/* global $, File, BridgeTalk, NRJSON, NR_ppro_snapshot, NR_aeft_snapshot, NR_ppro_place, NR_aeft_place, NR_aeft_runScript, NR_ppro_exportXml */

// Attempt to load the neighbours through $.fileName (often empty under CEP -> try/catch).
// The reliable loading is done by the panel (bootHost, known extension path).
(function () {
  try {
    var dir = File($.fileName).parent.fsName.replace(/\\/g, "/");
    $.evalFile(dir + "/nrjson.jsx");
    $.evalFile(dir + "/host-ppro.jsx");
    $.evalFile(dir + "/host-aeft.jsx");
  } catch (e) {}
})();

function NR_getSnapshot(text) {
  try {
    if (BridgeTalk.appName === "premierepro") return NR_ppro_snapshot(text);
    return NR_aeft_snapshot(text);
  } catch (e) {
    try {
      return NRJSON.stringify({ ok: false, error: String(e) });
    } catch (e2) {
      return '{"ok":false,"error":"snapshot failed"}';
    }
  }
}

/* Builds a sequence/comp from the cut shots. `payload` = a JS object already written as a literal
 * (the panel embeds the JSON in the eval'd code -> no JSON.parse in ES3).
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

/* Copies a WHOLE timeline (absolute positions, tracks kept) from the NetsuRush interchange
 * document. payload = { name, mode, timelineName, fps, width, height, duration,
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

/* Runs a script written by NetsuRush in the OPEN host. payload = { path }. After Effects only:
 * Premiere does not run an arbitrary .jsx from a panel. */
function NR_runScript(payload) {
  try {
    if (BridgeTalk.appName === "premierepro") {
      return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "host scripts are not supported by Premiere Pro" });
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

/* Exports the target sequence as FCP7 XML to the requested path. payload = { path, timelineName }.
 * The file is ONLY used to read the keyframes: the structure of the transfer comes from the API. */
function NR_exportXml(payload) {
  try {
    if (BridgeTalk.appName !== "premierepro") {
      return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "XML export is not supported by After Effects" });
    }
    // This dispatcher is the manifest's `ScriptPath`: Adobe only loads it when the application
    // starts, while its neighbours are reloaded by the panel. The two can therefore diverge - it
    // is NAMED here, instead of letting through a ReferenceError that nothing explains.
    if (typeof NR_ppro_exportXml !== "function") {
      return NRJSON.stringify({ ok: false, errorCode: "HOST_STALE", error: "NR_ppro_exportXml missing: stale host scripts" });
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

/* Imports an interchange timeline (FCP7 XML) as a sequence. payload = { path, name }. Premiere
 * only: its importer places the titles, which no API can create. */
function NR_importTimeline(payload) {
  try {
    if (BridgeTalk.appName !== "premierepro") {
      return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "timeline import is not supported by After Effects" });
    }
    // This dispatcher is the manifest's `ScriptPath`: it can diverge from its neighbours reloaded
    // by the panel. The missing function is NAMED rather than letting a ReferenceError through.
    if (typeof NR_ppro_importTimeline !== "function") {
      return NRJSON.stringify({ ok: false, errorCode: "HOST_STALE", error: "NR_ppro_importTimeline missing: stale host scripts" });
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

/* Imports files into the host project. payload = { paths:[...] }. */
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

/* NetsuBoost: cache purge, project hygiene, settings, proxies. payload = { op, ... } - each host only
 * implements the operations that make sense for it and returns UNSUPPORTED_OP for the others. */
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
