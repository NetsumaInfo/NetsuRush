/*
 * host-aeft.jsx — lecture projet/compositions After Effects (2020+, ExtendScript).
 * AE travaille déjà en secondes : inPoint/outPoint = bornes visibles dans la comp,
 * startTime = position de la source sur la timeline -> trim source = inPoint - startTime.
 */
/* global $, app, File, ImportOptions, CompItem, FootageItem, NRJSON, GpuAccelType, PurgeTarget */

function nrAeftFrame(sec, fps) {
  if (sec === null || sec === undefined || !fps) return null;
  return Math.round(Number(sec) * fps);
}

/* Temps SOURCE d'un calque à un instant de COMP. `inPoint - startTime` ne suffit PAS : AE trime en
 * temps de comp, donc il faut défaire l'étirement, et passer par la courbe quand le remappage est
 * actif. Sans ça tout calque retimé ressort avec des bornes fausses — y compris les comps que
 * NetsuRush écrit lui-même en insertion « fit » (NR_aeft_build pose stretch = scale × 100 et
 * startTime = compIn − srcIn × scale). */
function nrAeftSourceTime(ly, compTime) {
  try {
    if (ly.timeRemapEnabled && ly.timeRemap) return Number(ly.timeRemap.valueAtTime(compTime, false));
  } catch (e0) {}
  var stretch = 100;
  try { if (typeof ly.stretch === "number" && ly.stretch !== 0) stretch = Number(ly.stretch); } catch (e1) {}
  return (Number(compTime) - Number(ly.startTime)) * (100 / stretch);
}

/* Descend jusqu'au MÉTRAGE. Un calque dont la source est une précomposition n'a pas de fichier :
 * sans cette descente il ressortait avec path null et disparaissait de Timeline Live. Le temps
 * source du calque EST le temps interne de la précomp, donc on reporte les bornes à chaque niveau.
 * Profondeur bornée : garde-fou contre une comp qui se contient (AE l'autorise via expressions). */
function nrAeftResolveFootage(ly, srcIn, srcOut, depth) {
  var source = null;
  try { source = ly.source; } catch (e0) { return null; }
  if (!source) return null;

  var file = null;
  try { if (source.mainSource && source.mainSource.file) file = source.mainSource.file.fsName; } catch (e1) {}
  if (file) {
    var fps = null, frames = null;
    try { fps = Number(source.frameRate) || null; } catch (e2) {}
    try { if (source.duration && fps) frames = Math.round(Number(source.duration) * fps); } catch (e3) {}
    return { path: file, srcIn: srcIn, srcOut: srcOut, fps: fps, frames: frames };
  }

  if (depth <= 0) return null;
  var numLayers = 0;
  try { numLayers = Number(source.numLayers) || 0; } catch (e4) {}
  if (!numLayers) return null; // solide, calque de forme/texte : rien à prévisualiser

  // Un plan précomposé = le calque actif à cet instant DANS la précomp. Si la précomp contient
  // elle-même un montage, seul le plan couvrant `srcIn` est remonté (voir limite documentée).
  var inner = nrAeftLayerAt(source, srcIn);
  if (!inner) return null;
  return nrAeftResolveFootage(inner, nrAeftSourceTime(inner, srcIn), nrAeftSourceTime(inner, srcOut), depth - 1);
}

var NR_AEFT_PRECOMP_DEPTH = 4;

function nrAeftLayerClip(ly, comp) {
  var srcIn = null, srcOut = null;
  try {
    srcIn = nrAeftSourceTime(ly, ly.inPoint);
    srcOut = nrAeftSourceTime(ly, ly.outPoint);
  } catch (e0) {}
  // Calque inversé (stretch négatif, remappage décroissant) : les bornes sortent à l'envers.
  if (srcIn !== null && srcOut !== null && srcOut < srcIn) { var swap = srcIn; srcIn = srcOut; srcOut = swap; }

  var resolved = null;
  try { resolved = nrAeftResolveFootage(ly, srcIn, srcOut, NR_AEFT_PRECOMP_DEPTH); } catch (e1) {}

  var path = resolved ? resolved.path : null;
  if (resolved) { srcIn = resolved.srcIn; srcOut = resolved.srcOut; }

  // fps de la SOURCE (le métrage peut tourner à une autre cadence que la comp) ; repli sur la comp.
  var srcFps = resolved ? resolved.fps : null;
  if (!srcFps) { try { srcFps = comp ? Number(comp.frameRate) : null; } catch (e2) {} }
  var outFrame = nrAeftFrame(srcOut, srcFps);
  return {
    name: ly.name,
    path: path,
    tlStart: ly.inPoint,
    tlEnd: ly.outPoint,
    srcIn: srcIn,
    srcOut: srcOut,
    srcFps: srcFps,
    srcInFrame: nrAeftFrame(srcIn, srcFps),
    // Bornes source INCLUSIVES côté NetsuRush ; l'outPoint AE est la borne de sortie (exclusive).
    srcOutFrame: outFrame === null ? null : outFrame - 1,
    srcFrames: resolved ? resolved.frames : null,
    tlStartFrame: nrAeftFrame(ly.inPoint, comp ? Number(comp.frameRate) : srcFps),
    // Borne de fin en frames : un transfert de timeline a besoin de l'OCCUPATION exacte du calque,
    // que les secondes ne rendent pas sur cadence non entière.
    tlEndFrame: nrAeftFrame(ly.outPoint, comp ? Number(comp.frameRate) : srcFps)
  };
}

/* Retrouve un footage déjà importé (par chemin), sinon l'importe. Doit rester le MIROIR de
 * `core/ae/jsx.js` : les deux écrivent le même ExtendScript, une correction ici en exige une
 * là-bas. `missing` (optionnel) collecte les chemins absents du disque. AE ouvre
 * une boîte MODALE sur un import impossible, ce qui bloque ExtendScript et rend le panneau muet
 * jusqu'au timeout du job. */
function NR_ae_import(p, missing) {
  var file, want;
  try { file = new File(p); want = file.fsName.toLowerCase(); } catch (e0) { return null; }
  for (var k = 1; k <= app.project.numItems; k++) {
    var it = app.project.item(k);
    if (it instanceof FootageItem && it.file) {
      try { if (it.file.fsName.toLowerCase() === want) return it; } catch (e1) {}
    }
  }
  var exists = false;
  try { exists = file.exists; } catch (e2) {}
  if (!exists) { if (missing) missing.push(p); return null; }
  try {
    var io = new ImportOptions();
    io.file = file;
    return app.project.importFile(io);
  } catch (e3) { return null; }
}

/* Composition portant ce nom (destination « timeline existante » du profil d'export). */
function nrAeftCompByName(name) {
  if (!name) return null;
  for (var i = 1; i <= app.project.numItems; i++) {
    try {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) return it;
    } catch (e) {}
  }
  return null;
}

function nrAeftContentEnd(comp) {
  var end = 0;
  for (var i = 1; i <= comp.numLayers; i++) {
    try { if (comp.layer(i).outPoint > end) end = comp.layer(i).outPoint; } catch (e) {}
  }
  return end;
}

function nrAeftLayerAt(comp, time) {
  for (var i = 1; i <= comp.numLayers; i++) {
    try {
      var layer = comp.layer(i);
      if (layer.hasVideo && layer.activeAtTime(time)) return layer;
    } catch (e) {}
  }
  return null;
}

function nrAeftSnapTime(comp, time) {
  var origin = 0;
  try { origin = Number(comp.displayStartTime) || 0; } catch (e0) {}
  var frameDuration = Number(comp.frameDuration) || (1 / (Number(comp.frameRate) || 25));
  return origin + Math.round((Number(time) - origin) / frameDuration) * frameDuration;
}

function nrAeftSnapDuration(comp, duration) {
  var frameDuration = Number(comp.frameDuration) || (1 / (Number(comp.frameRate) || 25));
  return Math.max(frameDuration, Math.round(Number(duration) / frameDuration) * frameDuration);
}

/* Montage After Effects : les modes sont exprimés avec les primitives natives de calques
 * (startTime/inPoint/outPoint/stretch), pas avec des noms de commandes NLE inexistantes dans AE. */
function NR_aeft_build(p) {
  if (!p || !p.input) return NRJSON.stringify({ ok: false, errorCode: "MISSING_SOURCE", error: "chemin source manquant" });
  app.beginUndoGroup("NetsuRush -> After Effects");
  try {
    var missing = [];
    var f = NR_ae_import(p.input, missing);
    if (!f) {
      app.endUndoGroup();
      var absent = missing.length > 0;
      return NRJSON.stringify({ ok: false, errorCode: absent ? "MEDIA_MISSING" : "IMPORT_FAILED", errorDetail: p.input,
        error: (absent ? "fichier introuvable sur le disque : " : "import échoué : ") + p.input });
    }
    var fps = f.frameRate || p.fps || 25;

    // Les frames source sont prioritaires : elles évitent tout arrondi des secondes du détecteur.
    // Un segment peut porter son propre `path` (Timeline Live enchaîne des sources DIFFÉRENTES) ;
    // sans lui on reste sur la source unique `p.input` (Derush, Recherche, Voix).
    var footageCache = {};
    footageCache[p.input] = f;
    function footageFor(mediaPath) {
      if (!mediaPath) return f;
      if (footageCache[mediaPath] === undefined) footageCache[mediaPath] = NR_ae_import(mediaPath, missing);
      return footageCache[mediaPath];
    }
    var ranges = [];
    if (p.whole) {
      ranges.push({ inSec: 0, outSec: f.duration, footage: f });
    } else {
      var segs = p.segments || [];
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        var segFootage = s.path ? footageFor(s.path) : f;
        if (!segFootage) continue;
        var segFps = segFootage.frameRate || fps;
        var hasFrames = segFps > 0 && typeof s.inFrame === "number" && typeof s.outFrame === "number";
        var inSec = hasFrames ? s.inFrame / segFps : ((typeof s["in"] === "number") ? s["in"] : null);
        var outSec = hasFrames ? (s.outFrame + 1) / segFps : ((typeof s.out === "number") ? s.out : null);
        if (inSec !== null && outSec !== null && outSec > inSec) ranges.push({ inSec: inSec, outSec: outSec, footage: segFootage });
      }
    }
    var total = 0;
    for (var t = 0; t < ranges.length; t++) total += (ranges[t].outSec - ranges[t].inSec);
    if (total <= 0) { app.endUndoGroup(); return NRJSON.stringify({ ok: false, errorCode: "NO_VALID_SHOTS", error: "aucun plan valide" }); }

    var insertion = p.insertion || "end";
    var comp = null, created = true;
    // Comp VISÉE par son nom (destination du profil d'export), sinon celle ouverte dans le viewer.
    if (p.mode === "append") {
      comp = nrAeftCompByName(p.timelineName);
      if (!comp && app.project.activeItem instanceof CompItem) comp = app.project.activeItem;
      if (comp) created = false;
    }
    if (!comp) comp = app.project.items.addComp(p.name || "NetsuRush", f.width, f.height, f.pixelAspect || 1, total, fps);

    var tlPos = nrAeftSnapTime(comp, insertion === "end" ? nrAeftContentEnd(comp) : comp.time);
    var scale = 1;
    if (!created && (insertion === "replace" || insertion === "fit")) {
      var target = nrAeftLayerAt(comp, tlPos);
      if (!target) { app.endUndoGroup(); return NRJSON.stringify({ ok: false, errorCode: "NO_LAYER_AT_PLAYHEAD", error: "aucun calque à remplacer sous la tête de lecture" }); }
      tlPos = nrAeftSnapTime(comp, target.inPoint);
      if (insertion === "fit") scale = (target.outPoint - target.inPoint) / total;
      try { target.remove(); } catch (e3) {}
    }
    var placedDuration = nrAeftSnapDuration(comp, total * scale);
    if (!created && insertion === "insert") {
      for (var li = 1; li <= comp.numLayers; li++) {
        try {
          var shifted = comp.layer(li);
          if (shifted.inPoint >= tlPos) shifted.startTime += placedDuration;
        } catch (e4) {}
      }
    }

    var count = 0;
    var elapsed = 0;
    for (var j = 0; j < ranges.length; j++) {
      var r = ranges[j];
      var dur = r.outSec - r.inSec;
      try {
        var lyr = comp.layers.add(r.footage || f);
        if (p.videoOnly) lyr.audioEnabled = false;
        if (scale !== 1) lyr.stretch = scale * 100;
        var layerIn = nrAeftSnapTime(comp, tlPos + elapsed * scale);
        var layerOut = nrAeftSnapTime(comp, tlPos + (elapsed + dur) * scale);
        if (layerOut <= layerIn) layerOut = layerIn + comp.frameDuration;
        lyr.startTime = layerIn - (r.inSec * scale);
        lyr.inPoint = layerIn;              // inPoint avant outPoint (le setter AE décale sinon)
        lyr.outPoint = layerOut;
        elapsed += dur;
        count++;
      } catch (e5) {}
    }
    var finalOut = nrAeftSnapTime(comp, tlPos + elapsed * scale);
    if (finalOut > comp.duration) comp.duration = finalOut;
    app.endUndoGroup();
    try { comp.openInViewer(); } catch (e6) {}
    if (!count && missing.length) {
      return NRJSON.stringify({ ok: false, errorCode: "MEDIA_MISSING", errorDetail: missing[0],
        error: "fichier introuvable sur le disque : " + missing[0] });
    }
    return NRJSON.stringify({ ok: count > 0, timeline: comp.name, count: count, created: created,
      skipped: missing.length || undefined,
      errorCode: count > 0 ? undefined : "NO_LAYERS_ADDED", error: count > 0 ? undefined : "aucun calque posé" });
  } catch (e) {
    app.endUndoGroup();
    return NRJSON.stringify({ ok: false, error: String(e) });
  }
}

/* Bornes source d'un plan du document d'échange, en secondes. Frames prioritaires (pas d'arrondi
 * des secondes) ; la borne de sortie est INCLUSIVE côté NetsuRush, exclusive côté AE. */
function nrAeftClipRange(c, fps) {
  var hasFrames = fps > 0 && typeof c.inFrame === "number" && typeof c.outFrame === "number";
  var inSec = hasFrames ? c.inFrame / fps : ((typeof c["in"] === "number") ? c["in"] : null);
  var outSec = hasFrames ? (c.outFrame + 1) / fps : ((typeof c.out === "number") ? c.out : null);
  if (inSec === null || outSec === null || !(outSec > inSec)) return null;
  return { inSec: inSec, outSec: outSec };
}

/* ---------------------------------------------------------------------------
 * Transform et images clés d'un plan du document d'échange → calque After Effects.
 * Conventions du document : `position` en pixels de TIMELINE depuis le centre (Y vers le bas),
 * `anchor` en pixels SOURCE depuis le coin haut-gauche, `scale` en facteur (1 = 100 %),
 * `rotation` en degrés, `opacity` de 0 à 100. AE compte la position depuis le coin haut-gauche de
 * la comp et l'ancrage en pixels source : seules ces deux-là demandent une conversion.
 * ------------------------------------------------------------------------ */

function nrAeftPoint(value, fallbackX, fallbackY) {
  if (value && typeof value.x === "number" && typeof value.y === "number") return { x: value.x, y: value.y };
  if (value && typeof value.length === "number" && value.length >= 2) return { x: Number(value[0]), y: Number(value[1]) };
  return { x: fallbackX, y: fallbackY };
}

function nrAeftInterpolation(name) {
  if (name === "hold") return KeyframeInterpolationType.HOLD;
  if (name === "bezier") return KeyframeInterpolationType.BEZIER;
  return KeyframeInterpolationType.LINEAR;
}

var NR_AEFT_EPSILON = 0.0001;

function nrAeftValuesClose(expected, actual) {
  if (expected && actual && typeof expected.length === "number" && typeof actual.length === "number") {
    if (expected.length !== actual.length) return false;
    for (var i = 0; i < expected.length; i++) {
      if (Math.abs(Number(expected[i]) - Number(actual[i])) > NR_AEFT_EPSILON) return false;
    }
    return true;
  }
  return Math.abs(Number(expected) - Number(actual)) <= NR_AEFT_EPSILON;
}

/* Relecture de la valeur RÉELLE du calque : AE clampe et réinterprète certaines propriétés
 * (l'opacité au-delà de 100, l'échelle d'un calque verrouillé). Sans ce contrôle, on annoncerait
 * une pose réussie que le rendu contredit. */
function nrAeftVerify(prop, expected, time) {
  try { return nrAeftValuesClose(expected, prop.valueAtTime(time, false)); } catch (e) { return false; }
}

/* Une propriété du document → une propriété AE. `convert` traduit la valeur du document dans
 * l'espace AE ; `timeOf` place une image clé du plan sur la ligne de temps de la comp.
 * Les images clés sont posées AVANT de fixer les interpolations : AE renumérote à chaque ajout. */
function nrAeftApplyProperty(prop, property, convert, timeOf) {
  var out = { applied: false, animated: false, verified: false };
  if (!prop || !property) return out;
  var keys = property.keyframes;
  if (!keys || !keys.length) {
    var value = convert(property.value);
    try { prop.setValue(value); } catch (e0) { return out; }
    out.applied = true;
    out.verified = nrAeftVerify(prop, value, 0);
    return out;
  }
  var posed = [];
  for (var i = 0; i < keys.length; i++) {
    try {
      var time = timeOf(Number(keys[i].frame) || 0);
      var keyValue = convert(keys[i].value);
      prop.setValueAtTime(time, keyValue);
      posed.push({ time: time, value: keyValue, interpolation: keys[i].interpolation });
    } catch (e1) {}
  }
  if (!posed.length) return out;
  out.applied = true;
  out.animated = true;
  var verified = true;
  for (var k = 0; k < posed.length; k++) {
    try {
      var index = prop.nearestKeyIndex(posed[k].time);
      var type = nrAeftInterpolation(posed[k].interpolation);
      prop.setInterpolationTypeAtKey(index, type, type);
    } catch (e2) {}
    if (!nrAeftVerify(prop, posed[k].value, posed[k].time)) verified = false;
  }
  out.verified = verified;
  return out;
}

function nrAeftReport(target, clipIndex, property, result) {
  if (!result.applied) {
    target.push({ clip: clipIndex, property: property, status: "unsupported", reason: "layerPropertyWriteUnavailable", readback: false });
    return;
  }
  target.push({
    clip: clipIndex, property: property,
    status: result.verified ? "applied" : "readbackMismatch", readback: true,
  });
  if (!result.animated) return;
  target.push({
    clip: clipIndex, property: property + ".keyframes",
    status: result.verified ? "applied" : "readbackMismatch", readback: true,
  });
}

/* Facteur d'ajustement source → comp, appliqué SELON L'HÔTE D'ORIGINE. Resolve AJUSTE la source à
 * l'image de la timeline avant d'appliquer son zoom (Zoom 1,0 = plein cadre) ; Premiere et After
 * Effects posent la source à sa taille NATIVE (Échelle 100 % = pixels d'origine). Appliquer ce
 * facteur au mauvais hôte redimensionne tout le montage — un rush 4K arriverait quatre fois trop
 * grand dans une comp 1080p, ou quatre fois trop petit. */
function nrAeftNativeScaleHost(clip) {
  var host = clip.identity && clip.identity.sourceHost;
  return host === "ppro" || host === "aeft";
}

function nrAeftFitScale(comp, footage, clip) {
  if (nrAeftNativeScaleHost(clip)) return 1;
  var width = Number(clip.srcWidth) || (footage ? Number(footage.width) : 0);
  var height = Number(clip.srcHeight) || (footage ? Number(footage.height) : 0);
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.min(comp.width / width, comp.height / height);
}

function nrAeftApplyTransform(comp, lyr, footage, clip, clipIndex, layerIn, compFps, report) {
  var transform = clip.video && clip.video.transform;
  if (!transform) return;
  var fit = nrAeftFitScale(comp, footage, clip);
  var srcWidth = Number(clip.srcWidth) || (footage ? Number(footage.width) : comp.width);
  var srcHeight = Number(clip.srcHeight) || (footage ? Number(footage.height) : comp.height);
  var flipX = transform.flipX && transform.flipX.value ? -1 : 1;
  var flipY = transform.flipY && transform.flipY.value ? -1 : 1;
  var timeOf = function (frame) { return layerIn + frame / (compFps || 25); };
  var group = lyr.transform;

  var position = function (value) {
    var point = nrAeftPoint(value, 0, 0);
    return [comp.width / 2 + point.x, comp.height / 2 + point.y];
  };
  // AE n'a pas de miroir : une échelle NÉGATIVE est le miroir, c'est la même chose au rendu.
  var scale = function (value) {
    var point = nrAeftPoint(value, 1, 1);
    return [fit * point.x * 100 * flipX, fit * point.y * 100 * flipY];
  };
  var anchor = function (value) {
    var point = nrAeftPoint(value, srcWidth / 2, srcHeight / 2);
    return [point.x, point.y];
  };
  var scalar = function (value) { return Number(value) || 0; };

  var pairs = [
    ["video.position", group.position, transform.position, position],
    ["video.scale", group.scale, transform.scale, scale],
    ["video.anchor", group.anchorPoint, transform.anchor, anchor],
    ["video.rotation", group.rotation, transform.rotation, scalar],
    ["video.opacity", group.opacity, transform.opacity, scalar]
  ];
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i][2]) continue;
    nrAeftReport(report, clipIndex, pairs[i][0], nrAeftApplyProperty(pairs[i][1], pairs[i][2], pairs[i][3], timeOf));
  }
  // Le miroir est CUIT dans le signe de l'échelle ci-dessus. Sans échelle déclarée, il faut quand
  // même la poser, sinon un plan simplement retourné arriverait à l'endroit.
  if (flipX < 0 || flipY < 0) {
    if (transform.scale) report.push({ clip: clipIndex, property: "video.flip", status: "applied", readback: true });
    else nrAeftReport(report, clipIndex, "video.flip",
      nrAeftApplyProperty(group.scale, { value: { x: 1, y: 1 } }, scale, timeOf));
  }
  if (transform.crop) {
    report.push({ clip: clipIndex, property: "video.crop", status: "unsupported", reason: "aeCropNeedsMask", readback: false });
  }
}

/* Niveau audio d'un plan. AE exprime les niveaux en dB par canal, comme le document. */
function nrAeftApplyAudio(lyr, clip, clipIndex, layerIn, compFps, report) {
  var audio = clip.audio;
  if (!audio) return;
  var group = null;
  try { group = lyr.property("ADBE Audio Group"); } catch (e0) { group = null; }
  var levels = null;
  try { levels = group ? group.property("ADBE Audio Levels") : null; } catch (e1) { levels = null; }
  if (audio.gainDb) {
    if (!levels) report.push({ clip: clipIndex, property: "audio.gain", status: "unsupported", reason: "layerPropertyWriteUnavailable", readback: false });
    else {
      var timeOf = function (frame) { return layerIn + frame / (compFps || 25); };
      var stereo = function (value) { var db = Number(value) || 0; return [db, db]; };
      nrAeftReport(report, clipIndex, "audio.gain", nrAeftApplyProperty(levels, audio.gainDb, stereo, timeOf));
    }
  }
  // AE n'a pas de panoramique de calque : le signaler vaut mieux que de le perdre en silence.
  if (audio.pan) report.push({ clip: clipIndex, property: "audio.pan", status: "unsupported", reason: "aeNoLayerPan", readback: false });
  if (audio.mute && audio.mute.value) {
    try { lyr.audioEnabled = false; report.push({ clip: clipIndex, property: "audio.mute", status: "applied", readback: true }); }
    catch (e2) { report.push({ clip: clipIndex, property: "audio.mute", status: "unsupported", reason: "layerPropertyWriteUnavailable", readback: false }); }
  }
}

/* Vitesse et inversion : une remise en temps (time remap) LINÉAIRE entre les bornes source du plan
 * et son occupation sur la timeline. Elle couvre d'un coup le ralenti, l'accéléré, la marche
 * arrière (valeurs décroissantes) et l'arrêt sur image (valeurs égales) — c'est le seul mécanisme
 * d'AE qui les exprime tous. Renvoie true quand le calque a été calé par ce chemin.  */
function nrAeftApplyTiming(lyr, clip, range, layerIn, layerOut, report, clipIndex) {
  var timing = clip.timing;
  if (!timing) return false;
  var ratio = (Number(timing.speed && timing.speed.numerator) || 1)
    / Math.max(1e-9, Number(timing.speed && timing.speed.denominator) || 1);
  var retimed = timing.reverse || timing.freeze || Math.abs(ratio - 1) > 1e-6;
  if (!retimed) return false;
  var from = timing.reverse ? range.outSec : range.inSec;
  var to = timing.reverse ? range.inSec : range.outSec;
  if (timing.freeze) { from = range.inSec; to = range.inSec; }
  try {
    lyr.timeRemapEnabled = true;
    var remap = lyr.property("ADBE Time Remapping");
    remap.setValueAtTime(layerIn, from);
    remap.setValueAtTime(layerOut, to);
    // setValueAtTime pose aussi les clés d'origine du time remap : hors de la plage, elles
    // rejoueraient le plan entier de part et d'autre du montage.
    for (var k = remap.numKeys; k >= 1; k--) {
      var time = remap.keyTime(k);
      if (time < layerIn - 1e-5 || time > layerOut + 1e-5) remap.removeKey(k);
    }
    for (var j = 1; j <= remap.numKeys; j++) {
      remap.setInterpolationTypeAtKey(j, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
    }
    lyr.inPoint = layerIn;
    lyr.outPoint = layerOut;
  } catch (e) {
    report.push({ clip: clipIndex, property: "timing.speed", status: "unsupported", reason: "timeRemapUnavailable", readback: false });
    return false;
  }
  if (Math.abs(ratio - 1) > 1e-6) report.push({ clip: clipIndex, property: "timing.speed", status: "applied", readback: true });
  if (timing.reverse) report.push({ clip: clipIndex, property: "timing.reverse", status: "applied", readback: true });
  if (timing.freeze) report.push({ clip: clipIndex, property: "timing.freeze", status: "applied", readback: true });
  return true;
}

/* Constat de pose relu sur le calque : AE recale silencieusement inPoint/outPoint quand ils
 * sortent de la durée de la comp. */
function nrAeftPlacementReport(report, clipIndex, lyr, layerIn, layerOut) {
  var placed = false;
  try { placed = Math.abs(lyr.inPoint - layerIn) < 1e-4 && Math.abs(lyr.outPoint - layerOut) < 1e-4; } catch (e) { placed = false; }
  var names = ["clip.media", "clip.trim", "clip.position", "clip.track"];
  for (var i = 0; i < names.length; i++) {
    report.push({
      clip: clipIndex, property: names[i],
      status: placed ? "applied" : "readbackMismatch", readback: true
    });
  }
}

/* Ordre d'AJOUT des calques. comp.layers.add() insère en tête : le DERNIER ajouté finit en haut.
 * On pose donc l'audio d'abord, puis la vidéo par piste croissante — la piste la plus haute de la
 * timeline source se retrouve au sommet de la pile, comme à la source. */
function nrAeftSortClips(clips) {
  var rank = function (c) { return c.kind === "audio" ? 0 : 1; };
  return clips.slice(0).sort(function (a, b) {
    return (rank(a) - rank(b))
      || ((Number(a.track) || 1) - (Number(b.track) || 1))
      || ((Number(a.tlStart) || 0) - (Number(b.tlStart) || 0));
  });
}

/* RECOPIE une timeline entière dans une composition : chaque plan garde sa position ABSOLUE.
 * NR_aeft_build enchaîne les plans bout-à-bout — bon pour une sélection de coupes, faux pour un
 * transfert de montage, dont les trous font partie de l'information.
 * payload = { name, mode, timelineName, fps, width, height, duration, videoOnly,
 *             clips:[{ path, kind, track, name, fps, inFrame, outFrame, in, out, tlStart, tlEnd }] }
 * (tlStart/tlEnd en secondes depuis le début du document). */
function NR_aeft_place(p) {
  if (!app.project) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" });
  var clips = (p && p.clips) || [];
  if (!clips.length) return NRJSON.stringify({ ok: false, errorCode: "NO_VALID_SHOTS", error: "aucun plan à poser" });

  app.beginUndoGroup("NetsuRush -> After Effects");
  try {
    var missing = [];
    var cache = {};
    function footageFor(mediaPath) {
      if (cache[mediaPath] === undefined) cache[mediaPath] = NR_ae_import(mediaPath, missing);
      return cache[mediaPath];
    }

    var compFps = Number(p.fps) || 25;
    var comp = null;
    var created = true;
    if (p.mode === "append") {
      comp = nrAeftCompByName(p.timelineName);
      if (!comp && app.project.activeItem instanceof CompItem) comp = app.project.activeItem;
      if (comp) created = false;
    }
    if (!comp) {
      var duration = Math.max(1 / compFps, Number(p.duration) || 0);
      comp = app.project.items.addComp(p.name || "NetsuRush",
        Number(p.width) || 1920, Number(p.height) || 1080, 1, duration, compFps);
    }

    // Le document part de 0 : sur une comp déjà montée, on le décale après le contenu existant.
    var origin = created ? 0 : nrAeftContentEnd(comp);
    // L'ordre de POSE n'est pas celui du document (les calques s'empilent), mais le rapport de
    // fidélité s'aligne sur les index du document : on les mémorise avant de trier.
    for (var n = 0; n < clips.length; n++) clips[n].nrIndex = n;
    var ordered = nrAeftSortClips(clips);
    var placed = 0;
    var failed = 0;
    var lastOut = origin;
    var reportItems = [];

    for (var i = 0; i < ordered.length; i++) {
      var c = ordered[i];
      var footage = footageFor(c.path);
      if (!footage) { failed++; continue; }
      var srcFps = Number(c.fps) || Number(footage.frameRate) || compFps;
      var range = nrAeftClipRange(c, srcFps);
      if (!range) { failed++; continue; }

      var layerIn = nrAeftSnapTime(comp, origin + (Number(c.tlStart) || 0));
      var layerOut = nrAeftSnapTime(comp, origin + (Number(c.tlEnd) || 0));
      if (layerOut <= layerIn) layerOut = nrAeftSnapTime(comp, layerIn + (range.outSec - range.inSec));
      if (layerOut <= layerIn) layerOut = layerIn + comp.frameDuration;

      var index = typeof c.nrIndex === "number" ? c.nrIndex : i;
      try {
        var lyr = comp.layers.add(footage);
        // AE n'a pas de pistes audio : un plan audio du document devient un calque au son seul.
        if (c.kind === "audio") { try { lyr.enabled = false; } catch (e0) {} }
        else if (p.videoOnly) { try { lyr.audioEnabled = false; } catch (e1) {} }
        if (!nrAeftApplyTiming(lyr, c, range, layerIn, layerOut, reportItems, index)) {
          lyr.startTime = layerIn - range.inSec;
          lyr.inPoint = layerIn;            // inPoint avant outPoint (le setter AE décale sinon)
          lyr.outPoint = layerOut;
        }
        nrAeftPlacementReport(reportItems, index, lyr, layerIn, layerOut);
        nrAeftApplyTransform(comp, lyr, footage, c, index, layerIn, compFps, reportItems);
        nrAeftApplyAudio(lyr, c, index, layerIn, compFps, reportItems);
        if (layerOut > lastOut) lastOut = layerOut;
        placed++;
      } catch (e2) { failed++; }
    }
    if (lastOut > comp.duration) comp.duration = nrAeftSnapDuration(comp, lastOut);
    app.endUndoGroup();
    try { comp.openInViewer(); } catch (e3) {}

    if (!placed && missing.length) {
      return NRJSON.stringify({ ok: false, errorCode: "MEDIA_MISSING", errorDetail: missing[0],
        error: "fichier introuvable sur le disque : " + missing[0] });
    }
    return NRJSON.stringify({ ok: placed > 0, timeline: comp.name, count: placed, created: created,
      failed: failed || undefined, skipped: missing.length || undefined,
      report: { items: reportItems },
      errorCode: placed > 0 ? undefined : "NO_LAYERS_ADDED",
      error: placed > 0 ? undefined : "aucun calque posé" });
  } catch (e) {
    app.endUndoGroup();
    return NRJSON.stringify({ ok: false, error: String(e) });
  }
}

/* Exécute dans l'After Effects OUVERT un script écrit par NetsuRush. L'export riche
 * (core/aeExport.js) produit déjà ce .jsx ; le lancer via « AfterFX.exe -r » suppose qu'AE tourne
 * DÉJÀ avec un projet prêt — sinon le script part avant le projet et l'import se perd. Passer par
 * le panneau supprime cette condition. Le script journalise lui-même ses erreurs dans son .log. */
function NR_aeft_runScript(p) {
  var scriptPath = p && p.path;
  if (!scriptPath) return NRJSON.stringify({ ok: false, errorCode: "MISSING_SOURCE", error: "chemin de script manquant" });
  var file = null;
  try { file = new File(scriptPath); } catch (e0) { file = null; }
  if (!file || !file.exists) {
    return NRJSON.stringify({ ok: false, errorCode: "SCRIPT_MISSING", error: "script introuvable : " + scriptPath });
  }
  try { $.evalFile(file); } catch (e1) {
    return NRJSON.stringify({ ok: false, errorCode: "SCRIPT_FAILED", error: String(e1) });
  }
  return NRJSON.stringify({ ok: true, count: 1 });
}

/* Importe des fichiers dans le projet After Effects (footages, dédup par chemin via NR_ae_import). */
function NR_aeft_import(p) {
  if (!app.project) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" });
  var paths = (p && p.paths) || [];
  if (!paths.length) return NRJSON.stringify({ ok: true, count: 0 });
  var count = 0;
  var missing = [];
  for (var i = 0; i < paths.length; i++) {
    try { if (NR_ae_import(paths[i], missing)) count++; } catch (e0) {}
  }
  return NRJSON.stringify({ ok: count > 0, count: count, skipped: missing.length || undefined,
    errorCode: count > 0 ? undefined : (missing.length ? "MEDIA_MISSING" : "IMPORT_FAILED"),
    error: count > 0 ? undefined : (missing.length ? "fichier introuvable sur le disque" : "import échoué") });
}

function NR_aeft_snapshot() {
  var proj = app.project;
  if (!proj) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "no project open" });

  var rushes = [];
  var sequences = [];
  var i, it, L, clips, f;

  for (i = 1; i <= proj.numItems; i++) {
    it = proj.item(i);
    try {
      if (it instanceof CompItem) {
        clips = [];
        for (L = 1; L <= it.numLayers; L++) {
          try { clips.push(nrAeftLayerClip(it.layer(L), it)); } catch (e0) {}
        }
        sequences.push({
          name: it.name,
          fps: it.frameRate,
          w: it.width,
          h: it.height,
          tracks: [{ kind: "video", index: 1, clips: clips }]
        });
      } else if (it instanceof FootageItem) {
        f = null;
        try { if (it.mainSource && it.mainSource.file) f = it.mainSource.file.fsName; } catch (e1) {}
        if (!f) continue; // solide / placeholder
        rushes.push({
          path: f,
          name: it.name,
          fps: it.frameRate || null,
          dur: it.duration || null,
          w: it.width || null,
          h: it.height || null
        });
      }
    } catch (e2) {}
  }

  // Comp OUVERTE dans le viewer = l'équivalent AE de la « timeline ouverte » : NetsuRush s'en sert
  // pour marquer la destination par défaut du montage.
  var activeSequence = null;
  try { if (proj.activeItem instanceof CompItem) activeSequence = proj.activeItem.name; } catch (e3) {}

  return NRJSON.stringify({
    ok: true,
    app: "aeft",
    appVersion: String(app.version),
    project: proj.file ? proj.file.name : "Sans titre",
    projectPath: proj.file ? proj.file.fsName : null,
    activeSequence: activeSequence,
    at: new Date().getTime(),
    rushes: rushes,
    sequences: sequences
  });
}

/* ---------------------------------------------------------------------------
 * NetsuBoost — optimisation After Effects.
 * AE est le plus scriptable des deux hôtes : purge de cache, allocation mémoire, GPU et profondeur
 * sont des API publiques. Un seul point d'entrée, dispatché sur p.op.
 * ------------------------------------------------------------------------ */

var NR_AEFT_GPU_NAMES = ["CUDA", "METAL", "OPENCL", "SOFTWARE"];

/* Les enums ExtendScript ne se stringifient pas en nom lisible : on compare aux membres de
   GpuAccelType pour retrouver le libellé. */
function nrAeftGpuName(value) {
  if (value === null || value === undefined) return null;
  try {
    if (typeof GpuAccelType === "undefined" || !GpuAccelType) return null;
    for (var i = 0; i < NR_AEFT_GPU_NAMES.length; i++) {
      var name = NR_AEFT_GPU_NAMES[i];
      if (GpuAccelType[name] !== undefined && value === GpuAccelType[name]) return name;
    }
  } catch (e) {}
  return null;
}

function nrAeftGpuValue(name) {
  try {
    if (typeof GpuAccelType !== "undefined" && GpuAccelType && GpuAccelType[name] !== undefined) return GpuAccelType[name];
  } catch (e) {}
  return null;
}

function nrAeftGpuAvailable() {
  var out = [];
  try {
    var list = app.availableGPUAccelTypes;
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      var name = nrAeftGpuName(list[i]);
      if (name) out.push(name);
    }
  } catch (e) {}
  return out;
}

function nrAeftMemoryInUse() {
  try { return Number(app.memoryInUse); } catch (e) { return null; }
}

function nrAeftStats() {
  var proj = app.project;
  var bpc = null;
  try { bpc = Number(proj.bitsPerChannel); } catch (e0) {}
  var items = 0;
  try { items = Number(proj.numItems); } catch (e1) {}
  return {
    ok: true,
    app: "aeft",
    appVersion: String(app.version),
    project: proj && proj.file ? proj.file.name : null,
    projectPath: proj && proj.file ? proj.file.fsName : null,
    items: items,
    bitsPerChannel: bpc,
    gpuAccelType: proj ? nrAeftGpuName(proj.gpuAccelType) : null,
    gpuAvailable: nrAeftGpuAvailable(),
    memoryInUse: nrAeftMemoryInUse()
  };
}

/* Cible de purge. ALL_MEMORY_CACHES (AE 24.3+) est le seul vidage SILENCIEUX : ALL_CACHES ouvre la
   boîte « Clear Disk Cache » quand il est appelé depuis un panneau. Sur une version antérieure, on
   RETOMBE sur les trois caches mémoire nommés — et on le DIT dans la réponse, sinon l'utilisateur
   croirait avoir vidé le cache disque. */
function nrAeftPurgeTargets(target) {
  if (typeof PurgeTarget === "undefined" || !PurgeTarget) return { targets: [], missing: true };
  if (target === "all") return { targets: [PurgeTarget.ALL_CACHES], dialog: true };
  if (target === "undo") return { targets: [PurgeTarget.UNDO_CACHES] };
  if (target === "snapshot") return { targets: [PurgeTarget.SNAPSHOT_CACHES] };
  if (target === "image") return { targets: [PurgeTarget.IMAGE_CACHES] };
  if (PurgeTarget.ALL_MEMORY_CACHES !== undefined) return { targets: [PurgeTarget.ALL_MEMORY_CACHES] };
  return {
    targets: [PurgeTarget.IMAGE_CACHES, PurgeTarget.UNDO_CACHES, PurgeTarget.SNAPSHOT_CACHES],
    downgraded: true
  };
}

function nrAeftPurge(target) {
  var plan = nrAeftPurgeTargets(target || "memory");
  if (plan.missing || !plan.targets.length) {
    return { ok: false, code: "UNSUPPORTED", error: "PurgeTarget indisponible dans cette version" };
  }
  var before = nrAeftMemoryInUse();
  // Le dialogue de purge disque bloquerait le job jusqu'au timeout du pont : on le neutralise.
  if (plan.dialog) { try { app.beginSuppressDialogs(); } catch (e0) {} }
  var done = 0;
  var lastError = null;
  for (var i = 0; i < plan.targets.length; i++) {
    try { app.purge(plan.targets[i]); done++; } catch (e1) { lastError = String(e1); }
  }
  if (plan.dialog) { try { app.endSuppressDialogs(false); } catch (e2) {} }
  var after = nrAeftMemoryInUse();
  return {
    ok: done > 0,
    target: target || "memory",
    purged: done,
    downgraded: !!plan.downgraded,
    memoryBefore: before,
    memoryAfter: after,
    freed: before !== null && after !== null ? before - after : null,
    error: done > 0 ? undefined : (lastError || "purge refusée")
  };
}

/* Hygiène projet : un projet qui traîne des métrages inutilisés ou dupliqués coûte en RAM et en
   temps d'ouverture. Les deux opérations sont annulables (undo group), jamais silencieuses. */
function nrAeftHygiene(mode) {
  var proj = app.project;
  if (!proj) return { ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" };
  if (mode !== "removeUnused" && mode !== "consolidate") {
    return { ok: false, error: "opération inconnue : " + String(mode) };
  }
  app.beginUndoGroup("NetsuRush — hygiène du projet");
  try {
    var removed = mode === "removeUnused" ? proj.removeUnusedFootage() : proj.consolidateFootage();
    app.endUndoGroup();
    return { ok: true, mode: mode, removed: Number(removed) || 0 };
  } catch (e) {
    app.endUndoGroup();
    return { ok: false, error: String(e) };
  }
}

/* Lecture des réglages. AE n'expose AUCUN accesseur pour les limites mémoire ni pour le
   multi-frame rendering (seulement des setters) : ces lignes sont déclarées écriture seule côté
   core plutôt que lues via des clés de préférences non documentées et version-dépendantes. */
function nrAeftPrefsRead() {
  var proj = app.project;
  var bpc = null;
  try { bpc = Number(proj.bitsPerChannel); } catch (e0) {}
  return {
    ok: true,
    gpuAccelType: proj ? nrAeftGpuName(proj.gpuAccelType) : null,
    gpuAvailable: nrAeftGpuAvailable(),
    bitsPerChannel: bpc
  };
}

function nrAeftPrefsApply(entries) {
  var proj = app.project;
  var list = entries || [];
  var applied = [];
  var skipped = [];
  var memory = { imageCachePct: null, maxMemPct: null };
  var mfr = { enabled: null, cpu: null };

  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    try {
      if (e.id === "gpuAccelType") {
        var value = nrAeftGpuValue(String(e.value));
        if (value === null) { skipped.push({ id: e.id, reason: "UNSUPPORTED" }); continue; }
        proj.gpuAccelType = value;
        applied.push(e.id);
      } else if (e.id === "bitsPerChannel") {
        proj.bitsPerChannel = Number(e.value);
        applied.push(e.id);
      } else if (e.id === "imageCachePct" || e.id === "maxMemPct") {
        memory[e.id] = Number(e.value);
      } else if (e.id === "mfrEnabled") {
        mfr.enabled = !!e.value;
      } else if (e.id === "mfrMaxCpuPct") {
        mfr.cpu = Number(e.value);
      } else {
        skipped.push({ id: e.id, reason: "UNKNOWN" });
      }
    } catch (e1) {
      skipped.push({ id: e.id, reason: String(e1) });
    }
  }

  // setMemoryUsageLimits prend les DEUX pourcentages : un seul réglé, l'autre doit être fourni tel
  // quel — sans getter, on refuse plutôt que d'écraser l'autre avec une valeur inventée.
  if (memory.imageCachePct !== null || memory.maxMemPct !== null) {
    if (memory.imageCachePct === null || memory.maxMemPct === null) {
      skipped.push({ id: "memory", reason: "NEEDS_BOTH" });
    } else {
      try {
        app.setMemoryUsageLimits(memory.imageCachePct, memory.maxMemPct);
        applied.push("imageCachePct");
        applied.push("maxMemPct");
      } catch (e2) {
        skipped.push({ id: "memory", reason: String(e2) });
      }
    }
  }

  // Le MFR posé par un script est remis à zéro à la fin de CE script (documenté par Adobe) : on
  // l'applique quand même — utile pour un rendu piloté dans la foulée — mais on le signale.
  if (mfr.enabled !== null || mfr.cpu !== null) {
    try {
      app.setMultiFrameRenderingConfig(mfr.enabled === null ? true : mfr.enabled, mfr.cpu === null ? 100 : mfr.cpu);
      if (mfr.enabled !== null) applied.push("mfrEnabled");
      if (mfr.cpu !== null) applied.push("mfrMaxCpuPct");
    } catch (e3) {
      skipped.push({ id: "mfr", reason: String(e3) });
    }
  }

  return { ok: applied.length > 0, applied: applied, skipped: skipped, volatileMfr: mfr.enabled !== null || mfr.cpu !== null };
}

function NR_aeft_boost(p) {
  var op = (p && p.op) || "";
  if (op === "stats") return NRJSON.stringify(nrAeftStats());
  if (op === "purge") return NRJSON.stringify(nrAeftPurge(p.target));
  if (op === "hygiene") return NRJSON.stringify(nrAeftHygiene(p.mode));
  if (op === "prefsRead") return NRJSON.stringify(nrAeftPrefsRead());
  if (op === "prefsApply") return NRJSON.stringify(nrAeftPrefsApply(p.entries));
  // Les proxies et les fichiers de rendu sont des notions Premiere : AE n'a pas d'équivalent.
  return NRJSON.stringify({ ok: false, code: "UNSUPPORTED_OP", error: "opération inconnue : " + String(op) });
}
