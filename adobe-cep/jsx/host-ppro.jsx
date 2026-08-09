/*
 * host-ppro.jsx — lecture projet/séquences Premiere Pro (2020+, ExtendScript DOM).
 * Toutes les durées sorties en SECONDES : les Time Premiere exposent .seconds ;
 * repli ticks/254016000000 (254 016 000 000 ticks par seconde, constante Adobe).
 */
/* global app, NRJSON, File, Time, qe, ScratchDiskType, MediaType */

var NR_TICKS_PER_SEC = 254016000000;

function nrPproTimeSec(t) {
  if (t === null || t === undefined) return null;
  try {
    if (typeof t.seconds === "number") return t.seconds;
    if (t.ticks !== undefined) return Number(t.ticks) / NR_TICKS_PER_SEC;
  } catch (e) {}
  return null;
}

function nrPproTicks(seconds, seq) {
  var ticks = Math.round(Number(seconds) * NR_TICKS_PER_SEC);
  var frameTicks = 0;
  try { frameTicks = Number(seq.timebase); } catch (e) {}
  if (frameTicks > 0) ticks = Math.round(ticks / frameTicks) * frameTicks;
  return String(Math.round(ticks));
}

function nrPproSnapSec(seq, seconds) {
  return Number(nrPproTicks(seconds, seq)) / NR_TICKS_PER_SEC;
}

var NR_PPRO_COMPONENTS = {
  motion: ["ae.adbe motion", "adbe motion", "motion", "trajectoire"],
  // Titres et formes portent leur trajectoire dans un composant à part — « Trajectoire vectorielle »
  // sur les formes, « Graphic Group » sur les titres. Sans ce repli, un titre déplacé arrive centré.
  vectorMotion: ["ae.adbe vector motion", "adbe vector motion", "vector motion", "trajectoire vectorielle",
    "ae.adbe graphic group", "adbe graphic group", "graphic group", "groupe graphique"],
  // Le texte d'un titre vit dans ce composant. `getMGTComponent()` ne le rend PAS sur un titre
  // natif (mesuré : « absent » alors que `AE.ADBE Text` était bien dans la collection) — il ne
  // couvre que les modèles d'animation graphique venus d'After Effects.
  text: ["ae.adbe text", "adbe text", "text", "texte"],
  opacity: ["ae.adbe opacity", "adbe opacity", "opacity", "opacité"],
  // Le composant de niveau s'appelle « Volume » dans l'interface : ne lister que « Audio Levels »
  // le rendait introuvable, donc tout transfert partait sans le moindre niveau audio.
  audioLevel: ["ae.adbe audio levels", "adbe audio levels", "audio levels", "niveaux audio",
    "ae.adbe volume", "adbe volume", "volume", "volume level"],
  audioPan: ["ae.adbe panner", "adbe panner", "panner", "panoramique", "ae.adbe pan", "adbe pan", "pan", "balance"]
};
var NR_PPRO_PARAMS = {
  position: ["position", "adbe position"],
  scale: ["scale", "échelle", "adbe scale"],
  scaleWidth: ["scale width", "largeur d’échelle", "largeur d'echelle"],
  uniformScale: ["uniform scale", "echelle uniforme", "échelle uniforme"],
  rotation: ["rotation", "adbe rotate z"],
  anchor: ["anchor point", "anchor", "point d’ancrage", "point d'ancrage"],
  opacity: ["opacity", "opacité"],
  gainDb: ["level", "volume", "volume level", "niveau", "niveau de volume"],
  pan: ["balance", "pan", "panoramique"],
  mute: ["mute", "muet"],
  sourceText: ["source text", "texte source", "text", "texte"]
};
var NR_PPRO_EPSILON = 0.000001;

function nrPproName(value) {
  var s = String(value || "").toLowerCase();
  s = s.replace(/[àáâä]/g, "a").replace(/[èéêë]/g, "e").replace(/[ìíîï]/g, "i");
  s = s.replace(/[òóôö]/g, "o").replace(/[ùúûü]/g, "u").replace(/ç/g, "c");
  return s.replace(/[^a-z0-9]+/g, " ").replace(/^\s+|\s+$/g, "");
}

function nrPproCollectionLength(coll) {
  if (!coll) return 0;
  if (typeof coll.numItems === "number") return coll.numItems;
  if (typeof coll.length === "number") return coll.length;
  return 0;
}

function nrPproNamedItem(coll, aliases) {
  var count = nrPproCollectionLength(coll), i, item, wanted, match, display;
  for (i = 0; i < count; i++) {
    try {
      item = coll[i];
      match = nrPproName(item.matchName);
      for (wanted = 0; wanted < aliases.length; wanted++) {
        if (match && match === nrPproName(aliases[wanted])) return item;
      }
    } catch (e0) {}
  }
  var found = null;
  for (i = 0; i < count; i++) {
    try {
      item = coll[i];
      display = nrPproName(item.displayName || item.name);
      for (wanted = 0; wanted < aliases.length; wanted++) {
        if (display === nrPproName(aliases[wanted])) {
          if (found && found !== item) return null;
          found = item;
        }
      }
    } catch (e1) {}
  }
  return found;
}

function nrPproComponent(ti, aliases) {
  try { return nrPproNamedItem(ti.components, aliases); } catch (e) { return null; }
}

function nrPproParam(component, aliases) {
  try { return component ? nrPproNamedItem(component.properties, aliases) : null; } catch (e) { return null; }
}

function nrPproPoint(value) {
  if (value && typeof value.length === "number" && value.length >= 2) {
    return { x: Number(value[0]) || 0, y: Number(value[1]) || 0 };
  }
  if (value && typeof value.x === "number" && typeof value.y === "number") {
    return { x: Number(value.x), y: Number(value.y) };
  }
  return null;
}

/* Dimensions de l'image d'une séquence, avec un repli 1080p : une division par zéro transformerait
   toute la trajectoire en NaN, et un NaN posé chez la cible y reste. */
function nrPproFrameSize(seq) {
  var width = Number(seq && seq.frameSizeHorizontal) || 0;
  var height = Number(seq && seq.frameSizeVertical) || 0;
  return { width: width > 0 ? width : 1920, height: height > 0 ? height : 1080 };
}

/* Trajectoire Premiere (FRACTION de l'image, origine coin haut-gauche) → pixels depuis le CENTRE,
   convention du document d'échange. */
function nrPproPointToPixels(value, frame) {
  var p = nrPproPoint(value);
  if (!p) return { x: 0, y: 0 };
  return { x: (p.x - 0.5) * frame.width, y: (p.y - 0.5) * frame.height };
}

/* Conversion inverse, pour l'écriture. Premiere attend un tableau [x, y]. */
function nrPproPointFromPixels(point, frame) {
  var p = nrPproPoint(point) || { x: 0, y: 0 };
  return [p.x / frame.width + 0.5, p.y / frame.height + 0.5];
}

/* Le paramètre « Niveau » de Premiere n'est PAS en décibels : `getValue()` rend un flottant 0..1
   dont l'échelle porte un décalage de 15 dB (le fader monte jusqu'à +15). Mesuré en vrai : 0,0216
   se lit −18,3 dB, et le passer tel quel pour un gain donnait un niveau absurde chez la cible.
   ExtendScript n'a pas `Math.log10` — d'où la division par `Math.LN10`. */
var NR_PPRO_LEVEL_OFFSET_DB = 15;

function nrPproLevelToDb(value) {
  var level = Number(value);
  // 0 = silence : le logarithme y diverge, et −∞ ne traverse aucun format d'échange.
  if (!(level > 0)) return -96;
  return 20 * (Math.log(level) / Math.LN10) + NR_PPRO_LEVEL_OFFSET_DB;
}

function nrPproDbToLevel(db) {
  var value = Number(db);
  if (!isFinite(value)) return 0;
  return Math.pow(10, (value - NR_PPRO_LEVEL_OFFSET_DB) / 20);
}

function nrPproParamValue(param) {
  if (!param || !param.getValue) return undefined;
  try { return param.getValue(); } catch (e) { return undefined; }
}

function nrPproSupportsKeyframes(param) {
  if (!param || !param.areKeyframesSupported) return false;
  try { return param.areKeyframesSupported() === true; } catch (e) { return false; }
}

function nrPproIsTimeVarying(param) {
  if (!nrPproSupportsKeyframes(param) || !param.isTimeVarying) return false;
  try { return param.isTimeVarying() === true; } catch (e) { return false; }
}

function nrPproAnimatedValue(param, ti) {
  if (!nrPproIsTimeVarying(param)) return nrPproParamValue(param);
  if (param.getValueAtTime) {
    try { return param.getValueAtTime(ti.start); } catch (e0) {}
  }
  if (!param.getKeys || !param.getValueAtKey) return undefined;
  try {
    var keys = param.getKeys();
    if (keys && typeof keys.length === "number" && keys.length) return param.getValueAtKey(keys[0]);
  } catch (e1) {}
  return undefined;
}

function nrPproKeySeconds(key) {
  var seconds = nrPproTimeSec(key);
  if (seconds !== null) return seconds;
  if (typeof key === "number") return key;
  return null;
}

function nrPproKeyframes(param, ti, seqFps, convert) {
  if (!nrPproIsTimeVarying(param) || !param.getKeys || !param.getValueAtKey) return undefined;
  var keys;
  try { keys = param.getKeys(); } catch (e1) { return undefined; }
  if (!keys || typeof keys.length !== "number") return undefined;
  var start = nrPproTimeSec(ti.start) || 0;
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var sec = nrPproKeySeconds(keys[i]);
    if (sec === null) continue;
    try {
      out.push({ frame: Math.round((sec - start) * seqFps), value: convert(param.getValueAtKey(keys[i])), interpolation: "unknown" });
    } catch (e2) {}
  }
  return out.length ? out : undefined;
}

function nrPproAnimated(param, ti, seqFps, convert, api) {
  var raw = nrPproAnimatedValue(param, ti);
  if (raw === undefined) return undefined;
  var property = {
    value: convert(raw),
    source: { host: "ppro", api: api, exactness: "exact" }
  };
  var keys = nrPproKeyframes(param, ti, seqFps, convert);
  if (keys) property.keyframes = keys;
  return property;
}

function nrPproParamAtFrame(param, ti, seqFps, frame, fallback) {
  if (!param || !param.getValueAtTime || !(seqFps > 0)) return fallback;
  var start = nrPproTimeSec(ti.start) || 0;
  var time = nrPproTime(start + frame / seqFps);
  if (!time) return fallback;
  try {
    var value = param.getValueAtTime(time);
    return value === undefined ? fallback : value;
  } catch (e) { return fallback; }
}

function nrPproMergeScaleWidth(scale, width, scaleParam, widthParam, ti, seqFps) {
  if (!scale || !width) return scale;
  scale.value.x = Number(width.value) / 100 || 0;
  var scaleKeys = scale.keyframes || [];
  var widthKeys = width.keyframes || [];
  if (!scaleKeys.length && !widthKeys.length) return scale;
  var frames = {}, i, frame;
  for (i = 0; i < scaleKeys.length; i++) frames[String(scaleKeys[i].frame)] = true;
  for (i = 0; i < widthKeys.length; i++) frames[String(widthKeys[i].frame)] = true;
  var merged = [];
  for (frame in frames) {
    if (!frames.hasOwnProperty(frame)) continue;
    var frameNumber = Number(frame);
    var rawX = nrPproParamAtFrame(widthParam, ti, seqFps, frameNumber, scale.value.x * 100);
    var rawY = nrPproParamAtFrame(scaleParam, ti, seqFps, frameNumber, scale.value.y * 100);
    merged.push({ frame: frameNumber, value: { x: (Number(rawX) || 0) / 100, y: (Number(rawY) || 0) / 100 }, interpolation: "unknown" });
  }
  merged.sort(function (a, b) { return a.frame - b.frame; });
  scale.keyframes = merged;
  return scale;
}

/* Paramètre d'un composant par son nom d'affichage. `getParamForDisplayName` est l'API prévue pour
   ça, mais elle est absente des versions anciennes ET sensible à la langue de l'interface : on
   retombe donc sur le parcours de la collection, qui teste tous les alias connus. */
function nrPproParamNamed(component, displayName, aliases) {
  var param = null;
  try {
    if (component && component.properties && component.properties.getParamForDisplayName) {
      param = component.properties.getParamForDisplayName(displayName);
    }
  } catch (e) { param = null; }
  return param || nrPproParam(component, aliases);
}

/* Champ d'un JSON de paramètre, lu par MOTIF plutôt que par analyse. Deux raisons : ExtendScript
   n'a pas de `JSON.parse` (ES3) et `eval` exécuterait le contenu d'un projet tiers pour en tirer
   une chaîne. On ne cherche que des littéraux, ce qu'un motif fait sans rien exécuter. */
function nrPproJsonString(source, names) {
  var i, match;
  for (i = 0; i < names.length; i++) {
    match = String(source).match(new RegExp('"' + names[i] + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
    if (match) {
      return match[1]
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return undefined;
}

function nrPproJsonNumber(source, names) {
  var i, match;
  for (i = 0; i < names.length; i++) {
    match = String(source).match(new RegExp('"' + names[i] + '"\\s*:\\s*(-?[0-9.]+)'));
    if (match) return Number(match[1]);
  }
  return undefined;
}

/* Couleur en composantes 0..1, écrite en tableau dans le JSON du paramètre. */
function nrPproJsonColor(source, names) {
  var i, match, parts;
  for (i = 0; i < names.length; i++) {
    match = String(source).match(new RegExp('"' + names[i] + '"\\s*:\\s*\\[([^\\]]*)\\]'));
    if (!match) continue;
    parts = match[1].split(",");
    if (parts.length < 3) continue;
    return { r: Number(parts[0]) || 0, g: Number(parts[1]) || 0, b: Number(parts[2]) || 0 };
  }
  return undefined;
}

/* Texte, police, corps et couleur d'un titre. Un titre n'a AUCUN fichier média : sans cette lecture
   il traverse le pont en simple trou de la timeline. `getMGTComponent` couvre les titres natifs
   comme les modèles d'animation graphique — les deux sont des Essential Graphics. */
/* Relevé de ce qu'un titre a rendu, quand il n'a rien rendu. Un élément sans média qui n'expose
   ni composant graphique ni paramètre de texte se lit exactement comme un cache de couleur : sans
   ce constat, « le texte n'est pas transféré » n'a aucune cause observable. */
function nrPproGraphicProbe(ti) {
  var probe = { mgt: "absent", params: [] }, component = null, count, i;
  try { component = ti.getMGTComponent ? ti.getMGTComponent() : null; } catch (e0) { probe.mgt = "erreur"; }
  if (!component) {
    if (probe.mgt === "absent" && !ti.getMGTComponent) probe.mgt = "getMGTComponent indisponible";
    probe.components = nrPproComponentNames(ti);
    return probe;
  }
  probe.mgt = String(component.matchName || component.displayName || "?");
  try {
    count = nrPproCollectionLength(component.properties);
    for (i = 0; i < count && i < 12; i++) {
      try { probe.params.push(String(component.properties[i].displayName)); } catch (e1) {}
    }
  } catch (e2) {}
  return probe;
}

function nrPproGraphic(ti) {
  var component = null, param, raw, out, font, size, color;
  // `getMGTComponent` d'abord (modèles venus d'After Effects), puis le composant texte de la
  // collection : un titre NATIF de Premiere n'est rendu que par la seconde voie.
  try { component = ti.getMGTComponent ? ti.getMGTComponent() : null; } catch (e0) { component = null; }
  if (!component) component = nrPproComponent(ti, NR_PPRO_COMPONENTS.text);
  if (!component) return undefined;
  param = nrPproParamNamed(component, "Source Text", NR_PPRO_PARAMS.sourceText);
  if (!param) return undefined;
  try { raw = param.getValue(); } catch (e1) { return undefined; }
  if (raw === undefined || raw === null) return undefined;
  raw = String(raw);
  // La valeur est une CHAÎNE JSON, pas un nombre : c'est la seule forme qui porte le style avec le
  // texte. Un contenu illisible reste le texte brut plutôt qu'une perte sèche.
  out = { text: nrPproJsonString(raw, ["textEditValue", "text", "value"]) };
  if (out.text === undefined) return raw.indexOf("{") === 0 ? undefined : { text: raw };
  font = nrPproJsonString(raw, ["fontEditValue", "fontName", "font"]);
  size = nrPproJsonNumber(raw, ["fontSizeEditValue", "fontSize", "size"]);
  color = nrPproJsonColor(raw, ["fillColorEditValue", "fillColor", "color"]);
  if (font) out.font = font;
  if (size > 0) out.size = size;
  if (color) out.color = color;
  return out;
}

/* Relevé des composants d'un plan et de leurs paramètres, pour le seul diagnostic. Borné : un plan
   chargé d'effets rendrait un snapshot illisible, et seuls les intrinsèques nous intéressent. */
function nrPproComponentNames(ti) {
  var names = [], count, i, component, label, params, p, limit;
  try { count = nrPproCollectionLength(ti.components); } catch (e0) { return ["<components inaccessible>"]; }
  if (!count) return ["<aucun composant>"];
  for (i = 0; i < count && i < 6; i++) {
    try {
      component = ti.components[i];
      label = String(component.matchName || component.displayName || "?");
      params = [];
      limit = nrPproCollectionLength(component.properties);
      for (p = 0; p < limit && p < 8; p++) {
        try { params.push(String(component.properties[p].displayName)); } catch (e1) {}
      }
      names.push(label + "(" + params.join(",") + ")");
    } catch (e2) { names.push("<lecture refusée>"); }
  }
  return names;
}

function nrPproReadProperties(ti, seq, seqFps, kind) {
  var out = {};
  if (kind === "video") {
    // « Trajectoire vectorielle » est la trajectoire des titres et formes : sans ce repli, un titre
    // déplacé arrive au centre de l'image.
    var motion = nrPproComponent(ti, NR_PPRO_COMPONENTS.motion)
      || nrPproComponent(ti, NR_PPRO_COMPONENTS.vectorMotion);
    var opacityComp = nrPproComponent(ti, NR_PPRO_COMPONENTS.opacity);
    var tr = {};
    var positionParam = nrPproParam(motion, NR_PPRO_PARAMS.position);
    var scaleParam = nrPproParam(motion, NR_PPRO_PARAMS.scale);
    var scaleWidthParam = nrPproParam(motion, NR_PPRO_PARAMS.scaleWidth);
    var anchorParam = nrPproParam(motion, NR_PPRO_PARAMS.anchor);
    var rotationParam = nrPproParam(motion, NR_PPRO_PARAMS.rotation);
    var opacityParam = nrPproParam(opacityComp, NR_PPRO_PARAMS.opacity);
    var frame = nrPproFrameSize(seq);
    var source = nrPproSrcSize(ti) || frame;
    // Premiere compte sa trajectoire en FRACTION de l'image (0 = bord gauche/haut, 1 = bord
    // droit/bas), pas en pixels. Traiter 0,5 comme un pixel donnait un décalage de la moitié d'une
    // image — les transformations arrivaient énormes dans la cible.
    var pointFromCenter = function (value) { return nrPproPointToPixels(value, frame); };
    // L'ancre est normalisée elle aussi, mais sur la taille de la SOURCE : c'est la convention du
    // document (pixels source, origine coin haut-gauche).
    var pointRaw = function (value) {
      var p = nrPproPoint(value) || { x: 0, y: 0 };
      return { x: p.x * source.width, y: p.y * source.height };
    };
    var scale = function (value) { var n = Number(value) || 0; return { x: n / 100, y: n / 100 }; };
    var number = function (value) { return Number(value) || 0; };
    tr.position = nrPproAnimated(positionParam, ti, seqFps, pointFromCenter, "TrackItem Motion.Position");
    tr.scale = nrPproAnimated(scaleParam, ti, seqFps, scale, "TrackItem Motion.Scale");
    tr.anchor = nrPproAnimated(anchorParam, ti, seqFps, pointRaw, "TrackItem Motion.Anchor");
    tr.rotation = nrPproAnimated(rotationParam, ti, seqFps, number, "TrackItem Motion.Rotation");
    tr.opacity = nrPproAnimated(opacityParam, ti, seqFps, number, "TrackItem Opacity.Opacity");
    if (tr.scale && scaleWidthParam) {
      var width = nrPproAnimated(scaleWidthParam, ti, seqFps, number, "TrackItem Motion.ScaleWidth");
      tr.scale = nrPproMergeScaleWidth(tr.scale, width, scaleParam, scaleWidthParam, ti, seqFps);
    }
    if (tr.position || tr.scale || tr.anchor || tr.rotation || tr.opacity) out.video = { transform: tr };
    out.graphic = nrPproGraphic(ti);
    // Un plan SANS média est un titre, un cache ou un calque d'effet. Si on n'a pas su en lire le
    // texte, on rapporte ce que l'hôte a exposé — c'est la seule façon de distinguer les trois.
    if (!out.graphic) {
      var hasMedia = true;
      try { hasMedia = !!(ti.projectItem && ti.projectItem.getMediaPath()); } catch (eMedia) { hasMedia = false; }
      if (!hasMedia) out.graphicProbe = nrPproGraphicProbe(ti);
    }
  } else {
    var levelComp = nrPproComponent(ti, NR_PPRO_COMPONENTS.audioLevel);
    var panComp = nrPproComponent(ti, NR_PPRO_COMPONENTS.audioPan);
    var numberAudio = function (value) { return Number(value) || 0; };
    var boolAudio = function (value) { return value === true || value === 1 || String(value).toLowerCase() === "true"; };
    var audio = {};
    audio.gainDb = nrPproAnimated(nrPproParam(levelComp, NR_PPRO_PARAMS.gainDb), ti, seqFps, nrPproLevelToDb, "TrackItem AudioLevels.Level");
    audio.pan = nrPproAnimated(nrPproParam(panComp, NR_PPRO_PARAMS.pan), ti, seqFps, numberAudio, "TrackItem Panner.Balance");
    audio.mute = nrPproAnimated(nrPproParam(levelComp, NR_PPRO_PARAMS.mute), ti, seqFps, boolAudio, "TrackItem AudioLevels.Mute");
    if (audio.gainDb || audio.pan || audio.mute) out.audio = audio;
  }
  // Rien de lu alors qu'un plan porte TOUJOURS ses composants intrinsèques : on rapporte ce que la
  // collection contient réellement. Sans ce relevé, un composant renommé ou une collection vide se
  // lisent pareil côté NetsuRush — un transfert sans la moindre transformation, et aucune trace.
  if (!out.video && !out.audio) out.components = nrPproComponentNames(ti);
  try { out.nodeId = String(ti.nodeId || "") || undefined; } catch (eNode) {}
  try {
    var speed = Number(ti.getSpeed());
    var reversed = !!ti.isSpeedReversed();
    if (speed > 0 || reversed) out.speed = speed;
    out.reverse = reversed;
  } catch (eSpeed) {}
  return out;
}

/* Clé de comparaison d'un chemin média : Windows ne distingue pas la casse et Premiere rend ses
   chemins avec des antislashs, alors que NetsuRush (bibliothèque, recherche, board) peut porter la
   même source avec des barres obliques. Comparer les chaînes brutes faisait manquer le clip. */
function nrPproNormPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function nrPproFileExists(p) {
  try { return new File(p).exists; } catch (e) { return false; }
}

function nrPproRushes(root) {
  var rushes = [];
  function walk(item) {
    var i, it, p, fps, interp;
    for (i = 0; i < item.children.numItems; i++) {
      it = item.children[i];
      try {
        // ProjectItemType : CLIP=1, BIN=2, ROOT=3, FILE=4
        if (it.type === 2) { walk(it); continue; }
        p = null;
        try { p = it.getMediaPath(); } catch (e0) {}
        if (!p) continue; // item synthétique (barres, titres…)
        fps = null;
        try {
          interp = it.getFootageInterpretation();
          if (interp && interp.frameRate) fps = Number(interp.frameRate);
        } catch (e1) {}
        rushes.push({ path: p, name: it.name, fps: fps, dur: null, w: null, h: null });
      } catch (e2) {}
    }
  }
  walk(root);
  return rushes;
}

/* Cadences hors desquelles une valeur n'est pas une cadence. Sur un élément AUDIO SEUL, Premiere
   rend un `frameRate` aberrant — mesuré 2,754e-8 sur un .wav — qui écrase toute la frame-math à
   zéro : les bornes source sortaient en 0/0, Resolve refusait le plan d'une frame ainsi obtenu, et
   l'audio disparaissait du transfert sans un mot. Une cadence invraisemblable doit être REFUSÉE,
   jamais propagée. */
var NR_PPRO_FPS_MIN = 1;
var NR_PPRO_FPS_MAX = 1000;

/* fps de la SOURCE du clip (≠ fps de la séquence) : les bornes in/out d'un TrackItem sont en temps
   source, donc leur conversion en frames se fait dans l'espace de la source, pas de la timeline. */
function nrPproSrcFps(ti) {
  var interp, rate;
  try {
    if (ti.projectItem) {
      interp = ti.projectItem.getFootageInterpretation();
      rate = interp ? Number(interp.frameRate) : 0;
      if (rate >= NR_PPRO_FPS_MIN && rate <= NR_PPRO_FPS_MAX) return rate;
    }
  } catch (e) {}
  return null;
}

/* Dimensions de la SOURCE d'un plan. Aucune API ne les expose directement ; les métadonnées de
   projet portent la colonne intrinsèque « Video Info » sous la forme « 1920 x 1080 ». Le point
   d'ancrage se compte en pixels source : sans ces dimensions, il ne peut pas être traduit vers
   Resolve, qui le compte depuis le centre de l'image. */
function nrPproSrcSize(ti) {
  var meta = null;
  try { meta = ti.projectItem ? String(ti.projectItem.getProjectMetadata()) : null; } catch (e0) { meta = null; }
  if (!meta) return null;
  var m = /VideoInfo[^>]*>\s*(\d+)\s*[xX×]\s*(\d+)/.exec(meta);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/* Ticks -> numéro de frame. Les ticks sont la représentation ENTIÈRE et exacte du temps chez
   Premiere (254 016 000 000 par seconde, et un multiple exact de la durée d'une frame) ; `.seconds`
   en est un quotient flottant. Partir des ticks retire donc un arrondi de la chaîne, ce qui compte
   sur les cadences non entières (23,976 / 29,97). Repli sur les secondes si l'objet n'a pas .ticks. */
function nrPproFrame(t, fps) {
  if (t === null || t === undefined || !fps) return null;
  var ticks = null;
  try { if (t.ticks !== undefined) ticks = Number(t.ticks); } catch (e0) {}
  if (ticks === null || isNaN(ticks)) {
    var sec = nrPproTimeSec(t);
    if (sec === null) return null;
    ticks = sec * NR_TICKS_PER_SEC;
  }
  return Math.round(ticks * fps / NR_TICKS_PER_SEC);
}

/* Séquence correspondant à un ProjectItem — c'est-à-dire une séquence IMBRIQUÉE posée sur la
   timeline. Aucune API ne fait le lien directement : on apparie par nodeId. */
function nrPproSequenceFor(proj, pitem) {
  var wanted = null;
  try { wanted = pitem.nodeId; } catch (e0) {}
  if (!wanted) return null;
  for (var s = 0; s < proj.sequences.numSequences; s++) {
    try {
      var candidate = proj.sequences[s];
      if (candidate.projectItem && candidate.projectItem.nodeId === wanted) return candidate;
    } catch (e1) {}
  }
  return null;
}

/* Plan VISIBLE d'une séquence à un instant donné : on part de la piste du HAUT (index le plus
   grand), qui masque celles du dessous. */
function nrPproTopClipAt(seq, time) {
  for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
    var found = nrPproClipAt(seq.videoTracks[t], time);
    if (found) return found;
  }
  return null;
}

var NR_PPRO_NEST_DEPTH = 4;

/* Descend jusqu'au MÉTRAGE. Une séquence imbriquée n'a PAS de chemin média (getMediaPath vide) :
   sans cette descente le plan sortait sans `path` et disparaissait de Timeline Live — exactement le
   même trou que les précompositions côté After Effects. Le temps SOURCE d'un plan imbriqué EST le
   temps de la séquence imbriquée, donc les bornes se reportent niveau par niveau.
   `direct` distingue le cas nominal (aucune imbrication), seul à conserver l'exactitude des ticks. */
function nrPproResolveMedia(proj, ti, inSec, outSec, depth, direct) {
  var pitem = null;
  try { pitem = ti.projectItem; } catch (e0) {}
  if (!pitem) return null;

  var mediaPath = null;
  try { mediaPath = pitem.getMediaPath(); } catch (e1) {}
  if (mediaPath) {
    return { path: mediaPath, item: ti, inSec: inSec, outSec: outSec, fps: nrPproSrcFps(ti), direct: direct };
  }

  if (depth <= 0) return null;
  var nested = nrPproSequenceFor(proj, pitem);
  if (!nested) return null; // titre, cache de couleur, calque d'effet : rien à prévisualiser

  var inner = nrPproTopClipAt(nested, inSec);
  if (!inner) return null;
  var innerStart = nrPproTimeSec(inner.start);
  var innerIn = nrPproTimeSec(inner.inPoint);
  if (innerStart === null || innerIn === null) return null;
  return nrPproResolveMedia(
    proj, inner,
    innerIn + (inSec - innerStart),
    innerIn + (outSec - innerStart),
    depth - 1, false
  );
}

/* Bornes SOURCE d'un TrackItem, avec replis. Sur un plan audio posé depuis un fichier son,
   `inPoint`/`outPoint` peuvent être illisibles (constaté : deux .wav dont les deux bornes sortaient
   nulles, ce qui donnait un plan d'UNE frame que Resolve refusait de poser). Les bornes du
   ProjectItem, puis la durée du plan, disent la même chose autrement. `mediaType` 1 = vidéo, 2 = audio. */
function nrPproSourceBounds(ti, mediaType) {
  var inSec = nrPproTimeSec(ti.inPoint);
  var outSec = nrPproTimeSec(ti.outPoint);
  if (inSec !== null && outSec !== null && outSec > inSec) {
    return { inSec: inSec, outSec: outSec, exact: true };
  }
  var pitem = null;
  try { pitem = ti.projectItem; } catch (e0) { pitem = null; }
  if (pitem && pitem.getInPoint) {
    var pIn = null, pOut = null;
    try { pIn = nrPproTimeSec(pitem.getInPoint(mediaType)); } catch (e1) {}
    try { pOut = nrPproTimeSec(pitem.getOutPoint(mediaType)); } catch (e2) {}
    if (pIn !== null && pOut !== null && pOut > pIn) return { inSec: pIn, outSec: pOut, exact: false };
  }
  // Dernier repli : la DURÉE du plan. Elle ne dit pas où commence la portion utilisée, mais un plan
  // posé depuis le début de son média est le cas courant — et une longueur juste vaut mieux qu'une
  // borne de sortie écrasée sur l'entrée.
  var dur = nrPproTimeSec(ti.duration);
  if (dur === null) {
    var start = nrPproTimeSec(ti.start);
    var end = nrPproTimeSec(ti.end);
    dur = start !== null && end !== null ? end - start : null;
  }
  if (dur !== null && dur > 0) {
    var base = inSec !== null ? inSec : 0;
    return { inSec: base, outSec: base + dur, exact: false };
  }
  return { inSec: inSec, outSec: outSec, exact: false };
}

/* Nom d'une piste (« V2 », « B-roll »…). `Track.name` est en lecture seule et absent des hôtes les
 * plus anciens : un échec rend la chaîne vide, la piste garde alors son seul numéro. */
function nrPproTrackName(tr) {
  try { return tr && tr.name ? String(tr.name) : ""; } catch (e) { return ""; }
}

function nrPproTracks(proj, seq, seqFps) {
  var tracks = [];
  function readTracks(coll, kind) {
    var t, c, tr, ti, clips, srcFps, inFrame, outFrame, resolved, bounds;
    if (!coll) return;
    for (t = 0; t < coll.numTracks; t++) {
      tr = coll[t];
      clips = [];
      for (c = 0; c < tr.clips.numItems; c++) {
        ti = tr.clips[c];
        try {
          bounds = nrPproSourceBounds(ti, kind === "audio" ? 2 : 1);
          resolved = nrPproResolveMedia(
            proj, ti, bounds.inSec, bounds.outSec, NR_PPRO_NEST_DEPTH, true
          );
          // Un média audio n'a AUCUNE cadence propre : ses bornes se comptent dans celle de la
          // séquence. C'est déjà ce que fait le lecteur Resolve pour ses pistes son (timelineRead).
          srcFps = kind === "audio" ? (seqFps || null) : ((resolved && resolved.fps) || seqFps || null);
          if (resolved && resolved.direct && bounds.exact) {
            // Cas nominal : les ticks du TrackItem sont la vérité entière, on ne passe pas par
            // les secondes (cf. nrPproFrame).
            inFrame = nrPproFrame(ti.inPoint, srcFps);
            outFrame = nrPproFrame(ti.outPoint, srcFps);
          } else if (resolved && resolved.direct) {
            // Bornes reconstituées : elles sont en secondes, l'exactitude des ticks n'existe pas.
            inFrame = nrPproFrame({ seconds: bounds.inSec }, srcFps);
            outFrame = nrPproFrame({ seconds: bounds.outSec }, srcFps);
          } else {
            // Imbriqué : le report de bornes s'est fait en secondes, l'exactitude des ticks est perdue.
            inFrame = resolved ? nrPproFrame({ seconds: resolved.inSec }, srcFps) : null;
            outFrame = resolved ? nrPproFrame({ seconds: resolved.outSec }, srcFps) : null;
          }
          var properties = nrPproReadProperties(ti, seq, seqFps, kind);
          var size = kind === "video" ? nrPproSrcSize(ti) : null;
          clips.push({
            name: ti.name,
            path: resolved ? resolved.path : null,
            srcWidth: size ? size.width : null,
            srcHeight: size ? size.height : null,
            nodeId: properties.nodeId,
            ticks: {
              start: ti.start && ti.start.ticks !== undefined ? String(ti.start.ticks) : undefined,
              end: ti.end && ti.end.ticks !== undefined ? String(ti.end.ticks) : undefined,
              // `in` est un MOT RÉSERVÉ ES3 : non quoté, il rend le fichier entier illisible pour
              // ExtendScript, qui garde alors en mémoire sa dernière version valide — un fichier à
              // jour sur le disque et un hôte qui n'en sait rien.
              "in": ti.inPoint && ti.inPoint.ticks !== undefined ? String(ti.inPoint.ticks) : undefined,
              out: ti.outPoint && ti.outPoint.ticks !== undefined ? String(ti.outPoint.ticks) : undefined
            },
            tlStart: nrPproTimeSec(ti.start),
            tlEnd: nrPproTimeSec(ti.end),
            srcIn: resolved ? resolved.inSec : bounds.inSec,
            srcOut: resolved ? resolved.outSec : bounds.outSec,
            srcFps: srcFps,
            direct: !!(resolved && resolved.direct && bounds.exact),
            srcInFrame: inFrame,
            // Convention NetsuRush : bornes source INCLUSIVES. L'outPoint Premiere est exclusif —
            // c'est la même frontière que NR_ppro_build repose en (outFrame + 1) / fps.
            srcOutFrame: outFrame === null ? null : outFrame - 1,
            tlStartFrame: nrPproFrame(ti.start, seqFps),
            // Borne de fin en frames : un transfert de timeline a besoin de l'OCCUPATION exacte du
            // plan, que les secondes ne rendent pas sur cadence non entière.
            tlEndFrame: nrPproFrame(ti.end, seqFps),
            video: properties.video,
            audio: properties.audio,
            graphic: properties.graphic,
            graphicProbe: properties.graphicProbe,
            components: properties.components,
            speed: properties.speed,
            reverse: properties.reverse
          });
        } catch (e2) {}
      }
      tracks.push({ kind: kind, index: t + 1, name: nrPproTrackName(tr), clips: clips });
    }
  }
  readTracks(seq.videoTracks, "video");
  readTracks(seq.audioTracks, "audio");
  return tracks;
}

function nrPproTrackEnd(seq) {
  var end = 0;
  function readTracks(tracks) {
    if (!tracks) return;
    for (var t = 0; t < tracks.numTracks; t++) {
      var clips = tracks[t].clips;
      for (var c = 0; c < clips.numItems; c++) {
        var value = nrPproTimeSec(clips[c].end);
        if (value !== null && value > end) end = value;
      }
    }
  }
  readTracks(seq.videoTracks);
  readTracks(seq.audioTracks);
  return end;
}

function nrPproClipAt(track, time) {
  for (var i = 0; i < track.clips.numItems; i++) {
    var clip = track.clips[i];
    var start = nrPproTimeSec(clip.start);
    var end = nrPproTimeSec(clip.end);
    if (start !== null && end !== null && start <= time && end > time) return clip;
  }
  return null;
}

function nrPproTrackFree(track, start, end) {
  for (var i = 0; i < track.clips.numItems; i++) {
    var a = nrPproTimeSec(track.clips[i].start);
    var b = nrPproTimeSec(track.clips[i].end);
    if (a !== null && b !== null && start < b && a < end) return false;
  }
  return true;
}

function nrPproTrackList(seq, kind) {
  return kind === "audio" ? seq.audioTracks : seq.videoTracks;
}

/* Porte la collection de pistes à `index` + 1 pistes. TrackCollection n'a pas de addTrack dans
   l'API publique. QE est le seul pont disponible dans CEP ; il reste gardé et son résultat est
   vérifié par le nombre réel de pistes. Renvoie true si l'index demandé est utilisable. */
function nrPproAddTracks(seq, kind, index) {
  var have = nrPproTrackList(seq, kind).numTracks;
  if (have > index) return true;
  try {
    var active = app.project.activeSequence;
    if (!active || String(active.sequenceID) !== String(seq.sequenceID)) return false;
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var targetName = "";
    var qeName = "";
    try { targetName = String(seq.name || ""); } catch (eName0) {}
    try { qeName = String(qseq && qseq.name || ""); } catch (eName1) {}
    if (qseq && targetName && qeName === targetName) {
      var need = index + 1 - have;
      var at = Math.max(0, have - 1);
      if (kind === "audio") qseq.addTracks(0, 0, need, at);
      else qseq.addTracks(need, at, 0);
    }
  } catch (e) {}
  // Relecture depuis la séquence : rien ne garantit que la collection renvoyée plus haut reflète
  // les pistes que QE vient d'ajouter.
  return nrPproTrackList(seq, kind).numTracks > index;
}

function nrPproEnsureVideoTrack(seq, index) {
  return nrPproAddTracks(seq, "video", index) ? index : -1;
}

function nrPproAboveTrack(seq, start, end) {
  var first = 0;
  for (var i = 0; i < seq.videoTracks.numTracks; i++) {
    if (nrPproClipAt(seq.videoTracks[i], start)) first = i + 1;
  }
  for (var t = first; t < seq.videoTracks.numTracks; t++) {
    if (nrPproTrackFree(seq.videoTracks[t], start, end)) return t;
  }
  return nrPproEnsureVideoTrack(seq, seq.videoTracks.numTracks);
}

function nrPproNodeId(item) {
  try { return String(item.nodeId || ""); } catch (e) { return ""; }
}

function nrPproTrackSnapshot(track) {
  var out = [], count = nrPproCollectionLength(track && track.clips);
  for (var i = 0; i < count; i++) {
    try {
      var item = track.clips[i];
      out.push({
        ref: item,
        nodeId: nrPproNodeId(item),
        projectItem: item.projectItem || null,
        start: nrPproTimeSec(item.start),
        end: nrPproTimeSec(item.end),
        inPoint: nrPproTimeSec(item.inPoint),
        outPoint: nrPproTimeSec(item.outPoint)
      });
    } catch (e) {}
  }
  return out;
}

function nrPproCloseTime(a, b, seq) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  var frameSec = 0;
  try { frameSec = Number(seq.timebase) / NR_TICKS_PER_SEC; } catch (e) {}
  return Math.abs(Number(a) - Number(b)) <= Math.max(NR_PPRO_EPSILON, frameSec > 0 ? frameSec / 4 : 0);
}

function nrPproNewMethod(entry, before) {
  var seenId = false, seenRef = false;
  for (var i = 0; i < before.length; i++) {
    if (entry.nodeId && before[i].nodeId && entry.nodeId === before[i].nodeId) seenId = true;
    if (entry.ref === before[i].ref) seenRef = true;
  }
  if (entry.nodeId && !seenId) return "nodeId";
  if (!seenRef) return "newReference";
  return null;
}

function nrPproSourceMatches(entry, source) {
  if (entry.projectItem === source) return true;
  var actual = null, expected = null;
  try { actual = entry.projectItem && entry.projectItem.getMediaPath(); } catch (e0) {}
  try { expected = source && source.getMediaPath(); } catch (e1) {}
  return actual && expected && nrPproNormPath(actual) === nrPproNormPath(expected);
}

/* overwriteClip ne rend qu'un booléen. La propriété ne peut être appliquée qu'après réconciliation
 * exacte du TrackItem créé ; une ambiguïté laisse le plan posé mais interdit toute mutation au hasard. */
function nrPproLocateOverwrite(track, before, source, start, range, seq) {
  var after = nrPproTrackSnapshot(track), candidates = [], i, entry, method;
  for (i = 0; i < after.length; i++) {
    entry = after[i];
    if (!nrPproSourceMatches(entry, source) || !nrPproCloseTime(entry.start, start, seq)) continue;
    if (range && entry.inPoint !== null && !nrPproCloseTime(entry.inPoint, range.inSec, seq)) continue;
    if (range && entry.outPoint !== null && !nrPproCloseTime(entry.outPoint, range.outSec, seq)) continue;
    method = nrPproNewMethod(entry, before) || "reconciled";
    entry.method = method;
    candidates.push(entry);
  }
  if (candidates.length === 1) {
    entry = candidates[0];
    return {
      item: entry.ref,
      method: entry.method,
      nodeId: entry.nodeId || undefined,
      mediaReadback: nrPproSourceMatches(entry, source),
      positionReadback: nrPproCloseTime(entry.start, start, seq),
      trimReadback: !!range && entry.inPoint !== null && entry.outPoint !== null
        && nrPproCloseTime(entry.inPoint, range.inSec, seq)
        && nrPproCloseTime(entry.outPoint, range.outSec, seq),
      actual: entry
    };
  }
  return { item: null, method: "unresolved", ambiguous: candidates.length > 1 };
}

/* Pose ÉCRASANTE à une position absolue, sur une piste vidéo ou audio quelconque. */
function nrPproOverwriteLocated(seq, kind, index, item, time, range) {
  var track = nrPproTrackList(seq, kind)[index];
  if (!track) return { ok: false, item: null, locate: { method: "trackMissing" } };
  var before = nrPproTrackSnapshot(track), result = null;
  try { result = track.overwriteClip(item, nrPproTicks(time, seq)); } catch (e) {
    return { ok: false, item: null, locate: { method: "overwriteFailed" } };
  }
  var located = nrPproLocateOverwrite(track, before, item, time, range, seq);
  if (!located.item && result === false) {
    return { ok: false, item: null, locate: { method: "overwriteRejected" } };
  }
  return { ok: result !== false || !!located.item, item: located.item, locate: located };
}

function nrPproOverwriteOn(seq, kind, index, item, time) {
  return nrPproOverwriteLocated(seq, kind, index, item, time, null).ok;
}

function nrPproReport(clip, property, status, reason, readback, expected, actual) {
  var out = { clip: clip, property: property, status: status, readback: readback === true };
  if (reason) out.reason = reason;
  if (expected !== undefined) out.expected = expected;
  if (actual !== undefined) out.actual = actual;
  return out;
}

function nrPproTime(seconds) {
  try {
    var value = new Time();
    if (!value.setSecondsAsFraction) return null;
    value.setSecondsAsFraction(Math.round(Number(seconds) * NR_TICKS_PER_SEC), NR_TICKS_PER_SEC);
    return value;
  } catch (e) { return null; }
}

function nrPproValuesClose(expected, actual) {
  if (expected && actual && typeof expected.length === "number" && typeof actual.length === "number") {
    if (expected.length !== actual.length) return false;
    for (var i = 0; i < expected.length; i++) if (Math.abs(Number(expected[i]) - Number(actual[i])) > NR_PPRO_EPSILON) return false;
    return true;
  }
  var a = nrPproPoint(expected), b = nrPproPoint(actual);
  if (a && b) return Math.abs(a.x - b.x) <= NR_PPRO_EPSILON && Math.abs(a.y - b.y) <= NR_PPRO_EPSILON;
  if (typeof expected === "boolean") return (actual === true || actual === 1 || String(actual).toLowerCase() === "true") === expected;
  var x = Number(expected), y = Number(actual);
  return isFinite(x) && isFinite(y) && Math.abs(x - y) <= NR_PPRO_EPSILON;
}

function nrPproReadParam(param, time) {
  try {
    if (time && param.getValueAtTime) return param.getValueAtTime(time);
    if (param.getValue) return param.getValue();
  } catch (e) {}
  return undefined;
}

function nrPproWriteStatic(param, value) {
  if (!param || !param.setValue) return false;
  try {
    if (param.setTimeVarying) param.setTimeVarying(false);
    return param.setValue(value, 1) !== false;
  } catch (e) { return false; }
}

function nrPproClearKeys(param) {
  if (!param.getKeys) return true;
  var keys;
  try { keys = param.getKeys(); } catch (e0) { return false; }
  if (!keys || !keys.length) return true;
  if (!param.removeKey) return false;
  for (var i = keys.length - 1; i >= 0; i--) {
    try { if (param.removeKey(keys[i]) === false) return false; } catch (e1) { return false; }
  }
  return true;
}

function nrPproKeyTime(clipStart, frame, fps) {
  if (!(fps > 0)) return null;
  return nrPproTime(clipStart + (Number(frame) || 0) / fps);
}

function nrPproWriteKeys(param, property, convert, clipStart, fps) {
  if (!nrPproSupportsKeyframes(param) || !param.setTimeVarying || !param.addKey || !param.setValueAtKey) return false;
  if (!nrPproClearKeys(param)) return false;
  try {
    if (param.setValue && param.setValue(convert(property.value), 1) === false) return false;
    if (param.setTimeVarying(true) === false) return false;
  } catch (e0) { return false; }
  for (var i = 0; i < property.keyframes.length; i++) {
    var key = property.keyframes[i];
    var time = nrPproKeyTime(clipStart, key.frame, fps);
    if (!time) return false;
    try {
      if (param.addKey(time) === false) return false;
      if (param.setValueAtKey(time, convert(key.value), 1) === false) return false;
    } catch (e1) { return false; }
  }
  return true;
}

function nrPproReadKeys(param, property, convert, clipStart, fps) {
  if (!param || !param.getValueAtTime) return undefined;
  var out = [];
  for (var i = 0; i < property.keyframes.length; i++) {
    var key = property.keyframes[i];
    var time = nrPproKeyTime(clipStart, key.frame, fps);
    if (!time) return undefined;
    var value;
    try { value = param.getValueAtTime(time); } catch (e) { return undefined; }
    out.push({ expected: convert(key.value), actual: value });
  }
  return out;
}

function nrPproApplyProperty(param, property, convert, clipStart, fps, clipIndex, name, keyframeName, readConvert) {
  var expected = convert(property.value), wrote = false;
  if (property.keyframes && property.keyframes.length) wrote = nrPproWriteKeys(param, property, convert, clipStart, fps);
  else wrote = nrPproWriteStatic(param, expected);
  if (!wrote) return [nrPproReport(clipIndex, name, "unsupported", "componentParamWriteUnavailable", false, expected)];

  var out = [], startTime = property.keyframes && property.keyframes.length ? nrPproTime(clipStart) : null;
  var actual = nrPproReadParam(param, startTime);
  if (actual !== undefined && readConvert) actual = readConvert(actual);
  if (actual === undefined) out.push(nrPproReport(clipIndex, name, "unsupported", "readbackUnavailable", false, expected));
  else out.push(nrPproReport(clipIndex, name, nrPproValuesClose(expected, actual) ? "applied" : "readbackMismatch", null, true, expected, actual));

  if (property.keyframes && property.keyframes.length) {
    var keys = nrPproReadKeys(param, property, convert, clipStart, fps), match = !!keys;
    if (keys) for (var i = 0; i < keys.length; i++) {
      if (readConvert) keys[i].actual = readConvert(keys[i].actual);
      if (!nrPproValuesClose(keys[i].expected, keys[i].actual)) match = false;
    }
    out.push(nrPproReport(clipIndex, keyframeName, keys ? (match ? "applied" : "readbackMismatch") : "unsupported",
      keys ? null : "keyframeReadbackUnavailable", !!keys, property.keyframes, keys));
  }
  return out;
}

function nrPproPushReports(target, reports) {
  for (var i = 0; i < reports.length; i++) target.push(reports[i]);
}

function nrPproApplyVideo(ti, seq, clip, clipIndex, fps, report) {
  var transform = clip.video && clip.video.transform;
  if (!transform) return;
  // Même repli qu'à la lecture : un titre ou une forme n'a pas de « Trajectoire », mais une
  // « Trajectoire vectorielle » — sans ce repli, il reçoit ses transformations dans le vide.
  var motion = nrPproComponent(ti, NR_PPRO_COMPONENTS.motion)
    || nrPproComponent(ti, NR_PPRO_COMPONENTS.vectorMotion);
  var opacity = nrPproComponent(ti, NR_PPRO_COMPONENTS.opacity);
  // Mêmes unités qu'à la lecture, dans l'autre sens : Premiere veut des FRACTIONS de l'image, le
  // document porte des pixels depuis le centre. Poser les pixels tels quels envoyait le plan très
  // loin hors cadre.
  var frame = nrPproFrameSize(seq);
  var source = nrPproSrcSize(ti) || frame;
  var pointFromCenter = function (value) { return nrPproPointFromPixels(value, frame); };
  var pointRaw = function (value) {
    var p = nrPproPoint(value) || { x: 0, y: 0 };
    return [p.x / source.width, p.y / source.height];
  };
  var number = function (value) { return Number(value) || 0; };
  var uniformScale = function (value) { var p = nrPproPoint(value) || { x: 1, y: 1 }; return p.y * 100; };
  var widthScale = function (value) { var p = nrPproPoint(value) || { x: 1, y: 1 }; return p.x * 100; };
  var start = nrPproTimeSec(ti.start) || 0;

  if (transform.position) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(motion, NR_PPRO_PARAMS.position), transform.position, pointFromCenter, start, fps, clipIndex, "video.position", "video.position.keyframes"));
  if (transform.anchor) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(motion, NR_PPRO_PARAMS.anchor), transform.anchor, pointRaw, start, fps, clipIndex, "video.anchor", "video.anchor.keyframes"));
  if (transform.rotation) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(motion, NR_PPRO_PARAMS.rotation), transform.rotation, number, start, fps, clipIndex, "video.rotation", "video.rotation.keyframes"));
  if (transform.opacity) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(opacity, NR_PPRO_PARAMS.opacity), transform.opacity, number, start, fps, clipIndex, "video.opacity", "video.opacity.keyframes"));
  if (transform.scale) {
    var scale = nrPproParam(motion, NR_PPRO_PARAMS.scale);
    var scaleWidth = nrPproParam(motion, NR_PPRO_PARAMS.scaleWidth);
    var value = nrPproPoint(transform.scale.value) || { x: 1, y: 1 };
    if (scaleWidth && Math.abs(value.x - value.y) > NR_PPRO_EPSILON) {
      nrPproWriteStatic(nrPproParam(motion, NR_PPRO_PARAMS.uniformScale), false);
      nrPproPushReports(report, nrPproApplyProperty(scale, transform.scale, uniformScale, start, fps, clipIndex, "video.scale", "video.scale.keyframes"));
      nrPproPushReports(report, nrPproApplyProperty(scaleWidth, transform.scale, widthScale, start, fps, clipIndex, "video.scale", "video.scale.keyframes"));
    } else {
      nrPproPushReports(report, nrPproApplyProperty(scale, transform.scale, uniformScale, start, fps, clipIndex, "video.scale", "video.scale.keyframes"));
    }
  }
}

function nrPproApplyAudio(ti, clip, clipIndex, fps, report) {
  var audio = clip.audio;
  if (!audio) return;
  var level = nrPproComponent(ti, NR_PPRO_COMPONENTS.audioLevel);
  var pan = nrPproComponent(ti, NR_PPRO_COMPONENTS.audioPan);
  var start = nrPproTimeSec(ti.start) || 0;
  var number = function (value) { return Number(value) || 0; };
  var bool = function (value) { return !!value; };
  // Le document parle en dB, Premiere veut son niveau normalisé. Pas de conversion à la RELECTURE :
  // la valeur attendue est déjà le niveau normalisé, et repasser l'une des deux en dB comparerait
  // deux grandeurs différentes — le rapport annoncerait un écart là où la pose est exacte.
  if (audio.gainDb) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(level, NR_PPRO_PARAMS.gainDb), audio.gainDb, nrPproDbToLevel, start, fps, clipIndex, "audio.gain", "audio.gain.keyframes"));
  if (audio.volume) report.push(nrPproReport(clipIndex, "audio.volume", "unsupported", "premiereLinearVolumeMappingUnknown", false));
  if (audio.pan) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(pan, NR_PPRO_PARAMS.pan), audio.pan, number, start, fps, clipIndex, "audio.pan", "audio.pan.keyframes"));
  if (audio.mute) nrPproPushReports(report, nrPproApplyProperty(nrPproParam(level, NR_PPRO_PARAMS.mute), audio.mute, bool, start, fps, clipIndex, "audio.mute", "audio.mute.keyframes"));
}

function nrPproReportTiming(clip, clipIndex, report) {
  var timing = clip.timing;
  if (!timing) return;
  if (timing.speed && timing.speed.numerator !== timing.speed.denominator) report.push(nrPproReport(clipIndex, "timing.speed", "unsupported", "premiereRetimeWriteUnavailable", false));
  if (timing.reverse) report.push(nrPproReport(clipIndex, "timing.reverse", "unsupported", "premiereRetimeWriteUnavailable", false));
  if (timing.freeze) report.push(nrPproReport(clipIndex, "timing.freeze", "unsupported", "premiereRetimeWriteUnavailable", false));
  if (timing.timeMap && timing.timeMap.length) report.push(nrPproReport(clipIndex, "timing.timeMap", "unsupported", "premiereRetimeWriteUnavailable", false));
}

function nrPproApplyClip(ti, seq, clip, clipIndex, fps, report) {
  if (clip.kind === "audio") nrPproApplyAudio(ti, clip, clipIndex, fps, report);
  else nrPproApplyVideo(ti, seq, clip, clipIndex, fps, report);
  nrPproReportTiming(clip, clipIndex, report);
}

function nrPproPlace(seq, trackIndex, item, time, ripple) {
  if (!ripple) return nrPproOverwriteOn(seq, "video", trackIndex, item, time);
  var track = seq.videoTracks[trackIndex];
  var before = track.clips.numItems;
  try {
    var audioIndex = seq.audioTracks.numTracks > trackIndex ? trackIndex : 0;
    track.insertClip(item, nrPproTicks(time, seq), trackIndex, audioIndex);
  } catch (e) { return false; }
  // insertClip retourne undefined même en cas de succès : seul le compte fait foi.
  return track.clips.numItems > before;
}

/* insertClip exige une piste audio et pose donc l'audio d'un ProjectItem AV. Pour une
 * insertion vidéo seule, la primitive publique sûre est un subclip takeAudio=0/takeVideo=1. */
function nrPproVideoOnlySubclip(item, inSec, outSec, suffix) {
  if (!(outSec > inSec) || !item.createSubClip) return null;
  try {
    var label = String(item.name || "NetsuRush") + " — vidéo " + suffix;
    return item.createSubClip(label, nrPproTicks(inSec), nrPproTicks(outSec), 0, 1, 0) || null;
  } catch (e) { return null; }
}

var NR_PPRO_BIN_DEPTH = 12;

/* Index chemin normalisé -> ProjectItem, construit du même parcours que le snapshot.
   `findItemsMatchingMediaPath` est la voie officielle mais elle rend une liste VIDE sur des projets
   où le média est pourtant présent (casse/séparateurs, sources rangées en sous-bins) : c'était LA
   cause du « clip introuvable ou import échoué » alors que le rush était bien dans le projet. */
function nrPproIndexProject(proj) {
  var index = {};
  function walk(item, depth) {
    var children = null;
    try { children = item.children; } catch (e0) { return; }
    if (!children) return;
    for (var i = 0; i < children.numItems; i++) {
      try {
        var it = children[i];
        if (it.type === 2) { if (depth > 0) walk(it, depth - 1); continue; }
        var p = null;
        try { p = it.getMediaPath(); } catch (e1) {}
        if (!p) continue;
        var key = nrPproNormPath(p);
        if (index[key] === undefined) index[key] = it;
      } catch (e2) {}
    }
  }
  try { walk(proj.rootItem, NR_PPRO_BIN_DEPTH); } catch (e3) {}
  return index;
}

/* Résolveur de sources d'un job : chemin média -> ProjectItem, import si le projet ne l'a pas.
 * Mémoïsé par appel (un montage Timeline Live enchaîne des dizaines de plans sur une poignée de
 * sources) et l'index n'est construit qu'à la première recherche infructueuse. */
function nrPproResolver(proj) {
  var cache = {};
  var index = null;
  var missing = [];

  function find(mediaPath) {
    var item = null;
    try {
      var found = proj.findItemsMatchingMediaPath(mediaPath, false);
      if (found && found.length) item = found[0];
    } catch (e0) {}
    if (item) return item;
    if (index === null) index = nrPproIndexProject(proj);
    return index[nrPproNormPath(mediaPath)] || null;
  }

  return {
    /** Chemins refusés faute de fichier sur le disque (distingue le média absent du clip introuvable). */
    missing: missing,
    get: function (mediaPath) {
      if (!mediaPath) return null;
      var key = nrPproNormPath(mediaPath);
      if (cache[key] !== undefined) return cache[key];
      var item = find(mediaPath);
      if (!item) {
        // Importer un fichier absent ouvre une boîte de dialogue MODALE côté Premiere (suppressUI ne
        // la couvre pas) : ExtendScript reste bloqué et le panneau ne répond plus jusqu'au timeout du
        // job. On refuse donc en amont plutôt que de figer l'hôte.
        if (!nrPproFileExists(mediaPath)) {
          missing.push(mediaPath);
          cache[key] = null;
          return null;
        }
        try {
          var bin = proj.getInsertionBin ? proj.getInsertionBin() : proj.rootItem;
          proj.importFiles([mediaPath], true, bin, false);
        } catch (e1) {}
        index = null; // le projet a changé : l'index est périmé
        item = find(mediaPath);
      }
      cache[key] = item;
      return item;
    }
  };
}

/* Export FCP7 XML de la séquence visée, vers le chemin demandé par NetsuRush.
   Pourquoi passer par un fichier alors que `ComponentParam` expose `getKeys()` : les composants
   intrinsèques ne sont pas atteignables sur toutes les configurations (un scan qui rend les bornes
   exactes peut malgré tout rendre `components` vide), et le XML porte en plus la vitesse et le
   niveau audio dans une forme unique. C'est la MÊME source d'animation que celle déjà lue côté
   Resolve, donc un seul analyseur et un seul greffon des deux côtés du pont.
   Le XML ne monte jamais rien : il n'apporte que les images clés. */
function NR_ppro_exportXml(p) {
  var proj = app.project, seq, ok;
  if (!proj) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" });
  if (!p || !p.path) return NRJSON.stringify({ ok: false, errorCode: "MISSING_PATH", error: "chemin de sortie manquant" });
  seq = nrPproSequenceByName(proj, p.timelineName) || proj.activeSequence;
  if (!seq) return NRJSON.stringify({ ok: false, errorCode: "NO_SEQUENCE", error: "aucune séquence" });
  if (!seq.exportAsFinalCutProXML) {
    return NRJSON.stringify({ ok: false, errorCode: "UNSUPPORTED_OP", error: "exportAsFinalCutProXML absent" });
  }
  try {
    // suppressUI = 1 : sans lui, un avertissement modal gèle ExtendScript et le job part en timeout.
    ok = seq.exportAsFinalCutProXML(String(p.path), 1);
  } catch (e) {
    return NRJSON.stringify({ ok: false, error: String(e) });
  }
  // La méthode rend `true` en cas de succès sur les versions récentes et `0` sur les anciennes :
  // seul le fichier écrit prouve quelque chose.
  if (!nrPproFileExists(p.path)) {
    return NRJSON.stringify({ ok: false, errorCode: "EXPORT_EMPTY", error: "aucun fichier écrit", returned: String(ok) });
  }
  return NRJSON.stringify({ ok: true, path: String(p.path), sequence: seq.name });
}

/* Séquence du projet portant ce nom (destination « timeline existante » du profil d'export). */
function nrPproSequenceByName(proj, name) {
  if (!name) return null;
  for (var s = 0; s < proj.sequences.numSequences; s++) {
    try { if (proj.sequences[s].name === name) return proj.sequences[s]; } catch (e) {}
  }
  return null;
}

/* Ouvre la séquence visée : l'insertion à la tête de lecture lit le player de la séquence ACTIVE, et
 * l'utilisateur doit voir le montage qu'il vient de demander. */
function nrPproActivate(proj, seq) {
  try {
    var active = proj.activeSequence;
    if (active && active.sequenceID === seq.sequenceID) return;
    if (proj.openSequence) proj.openSequence(seq.sequenceID);
  } catch (e) { /* version sans openSequence : on monte dans la séquence sans l'ouvrir */ }
}

function nrPproItemFps(item, fallback) {
  try {
    var interp = item.getFootageInterpretation();
    if (interp && Number(interp.frameRate) > 0) return Number(interp.frameRate);
  } catch (e) {}
  return fallback;
}

/* Poser un trim écrase les In/Out du ProjectItem : on note les valeurs d'origine de CHAQUE source
 * touchée pour les rendre au projet à la fin (sinon les clips restent tronqués dans le Media Pool). */
function nrPproRemember(touched, item, mediaType) {
  for (var k = 0; k < touched.length; k++) {
    if (touched[k].item === item && touched[k].mediaType === mediaType) return;
  }
  var rec = { item: item, mediaType: mediaType, inPoint: null, outPoint: null };
  try { rec.inPoint = nrPproTimeSec(item.getInPoint(mediaType)); } catch (e0) {}
  try { rec.outPoint = nrPproTimeSec(item.getOutPoint(mediaType)); } catch (e1) {}
  touched.push(rec);
}

function nrPproRestore(touched) {
  for (var k = 0; k < touched.length; k++) {
    try { if (touched[k].inPoint !== null) touched[k].item.setInPoint(touched[k].inPoint, touched[k].mediaType); } catch (e0) {}
    try { if (touched[k].outPoint !== null) touched[k].item.setOutPoint(touched[k].outPoint, touched[k].mediaType); } catch (e1) {}
  }
}

/* Monte une séquence Premiere depuis les plans découpés (frame-accurate côté SOURCE).
 * Trim source via setInPoint/setOutPoint (secondes du détecteur, déjà au vrai fps),
 * clips posés bout-à-bout (insertClip en secondes). Limite connue : createNewSequence
 * n'expose PAS le fps → la fps de séquence peut différer du clip (pas d'API pour la forcer). */
function NR_ppro_build(p) {
  var proj = app.project;
  if (!proj) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" });
  if (!p || !p.input) return NRJSON.stringify({ ok: false, errorCode: "MISSING_SOURCE", error: "chemin source manquant" });

  // Retrouver le clip dans le projet ; l'importer si absent.
  var sources = nrPproResolver(proj);
  var pitem = sources.get(p.input);
  if (!pitem) {
    var missingMedia = sources.missing.length > 0;
    return NRJSON.stringify({
      ok: false,
      errorCode: missingMedia ? "MEDIA_MISSING" : "CLIP_NOT_FOUND",
      errorDetail: p.input,
      error: (missingMedia ? "fichier introuvable sur le disque : " : "clip introuvable ou import échoué : ") + p.input
    });
  }

  // Séquence : celle VISÉE par son nom (destination du profil d'export), sinon l'active en mode
  // append, sinon une neuve. Sans le ciblage par nom, choisir une séquence existante dans NetsuRush
  // n'avait aucun effet : tout tombait dans la séquence active.
  var seq = null;
  var created = true;
  if (p.mode === "append") {
    seq = nrPproSequenceByName(proj, p.timelineName);
    if (!seq) { try { seq = proj.activeSequence || null; } catch (eSeq) { seq = null; } }
    if (seq) {
      created = false;
      nrPproActivate(proj, seq);
    }
  }
  if (!seq) {
    try { seq = proj.createNewSequence(p.name || "NetsuRush", "nr_" + (new Date().getTime())); } catch (e2) { seq = null; }
    if (!seq || seq === 0) return NRJSON.stringify({ ok: false, errorCode: "SEQUENCE_CREATE_FAILED", error: "création de séquence échouée" });
  }

  var insertion = p.insertion || "end";
  var trackIndex = 0;
  var tlPos = insertion === "end" ? nrPproTrackEnd(seq) : 0;
  if (!created && insertion !== "end") {
    try { tlPos = seq.getPlayerPosition().seconds; } catch (e3) {}
  }
  tlPos = nrPproSnapSec(seq, tlPos);

  var fallbackFps = Number(p.fps) || 0;
  var sourceFps = nrPproItemFps(pitem, fallbackFps);

  var ranges = [];
  if (!p.whole) {
    var sourceSegs = p.segments || [];
    for (var ri = 0; ri < sourceSegs.length; ri++) {
      var rs = sourceSegs[ri];
      // Timeline Live enchaîne des plans de sources DIFFÉRENTES : un segment peut porter son propre
      // chemin. Sans `path`, on reste sur la source unique `p.input` (Derush, Recherche, Voix).
      var segItem = rs.path ? sources.get(rs.path) : pitem;
      if (!segItem) continue;
      var segFps = segItem === pitem ? sourceFps : nrPproItemFps(segItem, fallbackFps);
      var hasFrames = segFps > 0 && typeof rs.inFrame === "number" && typeof rs.outFrame === "number";
      var rin = hasFrames ? rs.inFrame / segFps : ((typeof rs["in"] === "number") ? rs["in"] : null);
      var rout = hasFrames ? (rs.outFrame + 1) / segFps : ((typeof rs.out === "number") ? rs.out : null);
      if (rin !== null && rout !== null && rout > rin) ranges.push({ inSec: rin, outSec: rout, item: segItem });
    }
  }
  var incomingDuration = 1;
  if (ranges.length) {
    incomingDuration = 0;
    for (var rd = 0; rd < ranges.length; rd++) incomingDuration += ranges[rd].outSec - ranges[rd].inSec;
  } else {
    try { incomingDuration = pitem.getOutPoint().seconds - pitem.getInPoint().seconds; } catch (e5) {}
  }
  if (!(incomingDuration > 0)) incomingDuration = 1;

  if (insertion === "above") {
    trackIndex = nrPproAboveTrack(seq, tlPos, tlPos + incomingDuration);
    if (trackIndex < 0) return NRJSON.stringify({ ok: false, errorCode: "TRACK_CREATE_FAILED", error: "impossible de créer une piste vidéo supérieure" });
  }
  var vt = seq.videoTracks[trackIndex];

  if (insertion === "replace" || insertion === "ripple_overwrite") {
    var replaced = nrPproClipAt(vt, tlPos);
    if (!replaced) return NRJSON.stringify({ ok: false, errorCode: "NO_CLIP_AT_PLAYHEAD", error: "aucun plan à remplacer sous la tête de lecture" });
    var replaceStart = nrPproTimeSec(replaced.start);
    if (replaceStart !== null) tlPos = replaceStart;
    try { replaced.remove(insertion === "ripple_overwrite", true); } catch (e6) {
      return NRJSON.stringify({ ok: false, errorCode: "REMOVE_FAILED", error: "suppression du plan remplacé échouée" });
    }
  }

  // Rush entier : neutraliser tout In/Out laissé par un montage précédent, puis le restaurer.
  // (Le chemin par plages a son propre suivi, par source touchée : cf. nrPproRemember.)
  if (p.whole) {
    var originalIn = null;
    var originalOut = null;
    try { originalIn = nrPproTimeSec(pitem.getInPoint()); } catch (e7) {}
    try { originalOut = nrPproTimeSec(pitem.getOutPoint()); } catch (e8) {}
    var mediaType = p.videoOnly ? 1 : 4;
    try { pitem.clearInPoint(mediaType); } catch (e9) {}
    try { pitem.clearOutPoint(mediaType); } catch (e10) {}
    var wholeItem = pitem;
    var wholeRipple = insertion === "insert" || insertion === "ripple_overwrite";
    if (p.videoOnly && wholeRipple) {
      var wholeIn = 0, wholeOut = 0;
      try { wholeIn = nrPproTimeSec(pitem.getInPoint(1)) || 0; } catch (e11) {}
      try { wholeOut = nrPproTimeSec(pitem.getOutPoint(1)) || 0; } catch (e12) {}
      wholeItem = nrPproVideoOnlySubclip(pitem, wholeIn, wholeOut, "entière");
      if (!wholeItem) {
        try { if (originalIn !== null) pitem.setInPoint(originalIn, mediaType); } catch (e13) {}
        try { if (originalOut !== null) pitem.setOutPoint(originalOut, mediaType); } catch (e14) {}
        return NRJSON.stringify({ ok: false, errorCode: "VIDEO_ONLY_SUBCLIP_FAILED", error: "impossible de préparer une insertion vidéo seule" });
      }
    }
    var okw = nrPproPlace(seq, trackIndex, wholeItem, tlPos, wholeRipple);
    try { if (originalIn !== null) pitem.setInPoint(originalIn, mediaType); } catch (e15) {}
    try { if (originalOut !== null) pitem.setOutPoint(originalOut, mediaType); } catch (e16) {}
    return NRJSON.stringify({ ok: okw, timeline: seq.name, count: okw ? 1 : 0, created: created,
      errorCode: okw ? undefined : "INSERT_FAILED", error: okw ? undefined : "insertion échouée" });
  }

  var count = 0;
  var elapsed = 0;
  var touched = [];
  var rangeMediaType = p.videoOnly ? 1 : 4;
  for (var i = 0; i < ranges.length; i++) {
    var inSec = ranges[i].inSec;
    var outSec = ranges[i].outSec;
    var sourceItem = ranges[i].item;
    var ripple = insertion === "insert" || insertion === "ripple_overwrite";
    var placedItem = sourceItem;
    if (p.videoOnly && ripple) {
      placedItem = nrPproVideoOnlySubclip(sourceItem, inSec, outSec, String(i + 1));
      if (!placedItem) continue;
    } else {
      nrPproRemember(touched, sourceItem, rangeMediaType);
      try {
        sourceItem.setInPoint(inSec, rangeMediaType);
        sourceItem.setOutPoint(outSec, rangeMediaType);
      } catch (e17) {}
    }
    var recordPos = nrPproSnapSec(seq, tlPos + elapsed);
    var ok = nrPproPlace(seq, trackIndex, placedItem, recordPos, ripple);
    if (ok) { count++; elapsed += (outSec - inSec); }
  }
  nrPproRestore(touched);

  // Sources hors ligne : le dire, sinon un montage multi-sources dont les fichiers ont bougé
  // ressortait « aucun plan inséré » sans indiquer lequel manquait.
  if (!count && sources.missing.length) {
    return NRJSON.stringify({ ok: false, errorCode: "MEDIA_MISSING", errorDetail: sources.missing[0],
      error: "fichier introuvable sur le disque : " + sources.missing[0] });
  }
  return NRJSON.stringify({ ok: count > 0, timeline: seq.name, count: count, created: created,
    skipped: sources.missing.length || undefined,
    errorCode: count > 0 ? undefined : "NO_SHOTS_INSERTED", error: count > 0 ? undefined : "aucun plan inséré" });
}

/* Bornes source d'un plan du document d'échange, en secondes. Les frames sont prioritaires (elles
 * évitent l'arrondi des secondes) et la borne de sortie est INCLUSIVE côté NetsuRush, exclusive
 * côté Premiere — d'où le +1, comme dans NR_ppro_build. */
function nrPproClipRange(c, fallbackFps) {
  var fps = Number(c.fps) || Number(fallbackFps) || 0;
  var hasFrames = fps > 0 && typeof c.inFrame === "number" && typeof c.outFrame === "number";
  var inSec = hasFrames ? c.inFrame / fps : ((typeof c["in"] === "number") ? c["in"] : null);
  var outSec = hasFrames ? (c.outFrame + 1) / fps : ((typeof c.out === "number") ? c.out : null);
  if (inSec === null || outSec === null || !(outSec > inSec)) return null;
  return { inSec: inSec, outSec: outSec };
}

/* RECOPIE une timeline entière : chaque plan est posé à sa position ABSOLUE, sur sa piste.
 * NR_ppro_build enchaîne les plans bout-à-bout sur une seule piste — c'est ce qu'il faut pour une
 * sélection de coupes, mais un transfert de montage y perdrait ses trous et son empilement.
 * payload = { name, mode, timelineName, clips:[{ path, kind, track, name, fps,
 *             inFrame, outFrame, in, out, tlStart (secondes depuis le début du document) }] }. */
function NR_ppro_place(p) {
  var proj = app.project;
  if (!proj) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" });
  var clips = (p && p.clips) || [];
  if (!clips.length) return NRJSON.stringify({ ok: false, errorCode: "NO_VALID_SHOTS", error: "aucun plan à poser" });

  var sources = nrPproResolver(proj);
  var seq = null;
  var created = true;
  if (p.mode === "append") {
    seq = nrPproSequenceByName(proj, p.timelineName);
    if (!seq) { try { seq = proj.activeSequence || null; } catch (e0) { seq = null; } }
    if (seq) created = false;
  }
  if (!seq) {
    try { seq = proj.createNewSequence(p.name || "NetsuRush", "nr_" + (new Date().getTime())); } catch (e1) { seq = null; }
    if (!seq || seq === 0) return NRJSON.stringify({ ok: false, errorCode: "SEQUENCE_CREATE_FAILED", error: "création de séquence échouée" });
  }
  nrPproActivate(proj, seq);

  // Le document part de 0 : sur une séquence déjà montée, on le décale après le contenu existant.
  var origin = created ? 0 : nrPproTrackEnd(seq);
  var touched = [];
  var placed = 0;
  var failed = 0;
  var clamped = false;
  var reportItems = [];
  var seqFps = Number(p.fps) || 25;
  try { if (Number(seq.timebase) > 0) seqFps = NR_TICKS_PER_SEC / Number(seq.timebase); } catch (eFps) {}

  for (var i = 0; i < clips.length; i++) {
    var c = clips[i];
    var range = nrPproClipRange(c, p.fps);
    if (!range) { failed++; continue; }
    var item = sources.get(c.path);
    if (!item) { failed++; continue; }

    var kind = c.kind === "audio" ? "audio" : "video";
    var wanted = Math.max(1, Number(c.track) || 1) - 1; // pistes 0-based côté Premiere
    var index = wanted;
    if (!nrPproAddTracks(seq, kind, wanted)) {
      index = nrPproTrackList(seq, kind).numTracks - 1;
      clamped = true;
    }
    if (index < 0) { failed++; continue; }

    // MediaType 1 = vidéo seule, 2 = audio seule : le plan vidéo ne repose pas son audio lié, que
    // le document porte déjà comme plan audio distinct quand il existe.
    var mediaType = kind === "audio" ? 2 : 1;
    nrPproRemember(touched, item, mediaType);
    try {
      item.setInPoint(range.inSec, mediaType);
      item.setOutPoint(range.outSec, mediaType);
    } catch (e2) {}

    var at = nrPproSnapSec(seq, origin + (Number(c.tlStart) || 0));
    var placement = nrPproOverwriteLocated(seq, kind, index, item, at, range);
    if (!placement.ok) { failed++; continue; }
    placed++;
    if (!placement.item) {
      reportItems.push(nrPproReport(i, "clip.media", "unsupported",
        placement.locate.ambiguous ? "trackItemAmbiguous" : "trackItemNotLocated", false));
      nrPproReportTiming(c, i, reportItems);
      continue;
    }
    var mediaReadback = placement.locate.mediaReadback === true;
    var trimReadback = placement.locate.trimReadback === true;
    var positionReadback = placement.locate.positionReadback === true;
    reportItems.push(nrPproReport(i, "clip.media", mediaReadback ? "applied" : "unsupported",
      mediaReadback ? null : "mediaReadbackUnavailable", mediaReadback));
    reportItems.push(nrPproReport(i, "clip.trim", trimReadback ? "applied" : "unsupported",
      trimReadback ? null : "trimReadbackUnavailable", trimReadback, range,
      placement.locate.actual ? { inSec: placement.locate.actual.inPoint, outSec: placement.locate.actual.outPoint } : undefined));
    reportItems.push(nrPproReport(i, "clip.position", positionReadback ? "applied" : "unsupported",
      positionReadback ? null : "positionReadbackUnavailable", positionReadback, at,
      placement.locate.actual ? placement.locate.actual.start : undefined));
    var trackExact = index === wanted;
    reportItems.push(nrPproReport(i, "clip.track", trackExact ? "applied" : "approximated",
      trackExact ? null : "trackClamped", true, wanted + 1, index + 1));
    nrPproApplyClip(placement.item, seq, c, i, Number(c.timelineFps) || Number(p.fps) || seqFps, reportItems);
  }
  nrPproRestore(touched);

  if (!placed && sources.missing.length) {
    return NRJSON.stringify({ ok: false, errorCode: "MEDIA_MISSING", errorDetail: sources.missing[0],
      error: "fichier introuvable sur le disque : " + sources.missing[0] });
  }
  return NRJSON.stringify({ ok: placed > 0, timeline: seq.name, count: placed, created: created,
    failed: failed || undefined, skipped: sources.missing.length || undefined,
    tracksClamped: clamped || undefined, report: { items: reportItems },
    errorCode: placed > 0 ? undefined : "NO_SHOTS_INSERTED",
    error: placed > 0 ? undefined : "aucun plan posé" });
}

/* Importe des fichiers dans le projet Premiere (bin d'insertion courant). */
function NR_ppro_import(p) {
  var proj = app.project;
  if (!proj) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" });
  var paths = (p && p.paths) || [];
  if (!paths.length) return NRJSON.stringify({ ok: true, count: 0 });
  var count = 0;
  var missing = 0;
  try {
    var bin = proj.getInsertionBin ? proj.getInsertionBin() : proj.rootItem;
    for (var i = 0; i < paths.length; i++) {
      // Fichier absent = boîte modale Premiere (cf. nrPproResolver) → on ne l'envoie jamais à l'import.
      if (!nrPproFileExists(paths[i])) { missing++; continue; }
      try { if (proj.importFiles([paths[i]], true, bin, false)) count++; } catch (e0) {}
    }
  } catch (e1) {
    return NRJSON.stringify({ ok: false, error: String(e1) });
  }
  return NRJSON.stringify({ ok: count > 0, count: count, skipped: missing || undefined,
    errorCode: count > 0 ? undefined : (missing ? "MEDIA_MISSING" : "IMPORT_FAILED"),
    error: count > 0 ? undefined : (missing ? "fichier introuvable sur le disque" : "import échoué") });
}

function NR_ppro_snapshot() {
  var proj = app.project;
  if (!proj) return NRJSON.stringify({ ok: false, errorCode: "NO_PROJECT", error: "no project open" });

  var sequences = [];
  var s, seq, fps, w, h, st;
  for (s = 0; s < proj.sequences.numSequences; s++) {
    seq = proj.sequences[s];
    try {
      // timebase = ticks par frame -> fps exact (gère 23.976 etc.)
      fps = null;
      try { fps = NR_TICKS_PER_SEC / Number(seq.timebase); } catch (e0) {}
      w = null; h = null;
      try { w = Number(seq.frameSizeHorizontal); h = Number(seq.frameSizeVertical); } catch (e1) {}
      if ((!w || !h) && seq.getSettings) {
        try {
          st = seq.getSettings();
          if (st) { w = w || Number(st.videoFrameWidth); h = h || Number(st.videoFrameHeight); }
        } catch (e2) {}
      }
      sequences.push({ name: seq.name, fps: fps, w: w, h: h, tracks: nrPproTracks(proj, seq, fps) });
    } catch (e3) {}
  }

  // Séquence OUVERTE : aucune API ne l'expose dans la liste, mais NetsuRush en a besoin pour
  // marquer « (ouverte) » et pour que la destination par défaut du montage soit la bonne.
  var activeSequence = null;
  try { if (proj.activeSequence) activeSequence = proj.activeSequence.name; } catch (e4) {}

  return NRJSON.stringify({
    ok: true,
    app: "ppro",
    appVersion: String(app.version),
    project: proj.name,
    projectPath: proj.path || null,
    activeSequence: activeSequence,
    at: new Date().getTime(),
    rushes: nrPproRushes(proj.rootItem),
    sequences: sequences
  });
}

/* ---------------------------------------------------------------------------
 * NetsuBoost — optimisation Premiere Pro.
 * Un seul point d'entrée, dispatché sur p.op, pour n'ajouter qu'UNE commande au panneau.
 * ------------------------------------------------------------------------ */

/* Parcourt tous les clips du projet (bins compris). Même parcours que nrPproIndexProject, mais sans
   dédoublonnage : deux ProjectItems peuvent pointer le même média et chacun a son propre proxy. */
function nrPproWalkClips(proj, visit) {
  function walk(item, depth) {
    var children = null;
    try { children = item.children; } catch (e0) { return; }
    if (!children) return;
    for (var i = 0; i < children.numItems; i++) {
      try {
        var it = children[i];
        if (it.type === 2) { if (depth > 0) walk(it, depth - 1); continue; }
        visit(it);
      } catch (e1) {}
    }
  }
  try { walk(proj.rootItem, NR_PPRO_BIN_DEPTH); } catch (e2) {}
}

/* Emplacements des fichiers de travail. Adobe documente setScratchDiskPath mais AUCUN getter : selon
   la version l'accesseur existe ou non. Absent → null, et la ligne disparaît de l'UI (mergeRead
   omet les valeurs nulles) plutôt que d'afficher un chemin inventé. */
function nrPproScratch(proj) {
  var out = { videoPreviews: null, audioPreviews: null, autoSave: null };
  var keys = [["videoPreviews", "FirstVideoPreviewFolder"], ["audioPreviews", "FirstAudioPreviewFolder"], ["autoSave", "FirstAutoSaveFolder"]];
  for (var i = 0; i < keys.length; i++) {
    var type = nrPproScratchType(keys[i][1]);
    if (type === null) continue;
    try {
      if (proj.getScratchDiskPath) out[keys[i][0]] = String(proj.getScratchDiskPath(type));
      else if (app.getScratchDiskPath) out[keys[i][0]] = String(app.getScratchDiskPath(type));
    } catch (e) {}
  }
  return out;
}

function nrPproScratchType(name) {
  try {
    if (typeof ScratchDiskType !== "undefined" && ScratchDiskType && ScratchDiskType[name] !== undefined) {
      return ScratchDiskType[name];
    }
  } catch (e) {}
  return null;
}

function nrPproProxyCounts(proj) {
  var counts = { total: 0, withProxy: 0, without: 0 };
  nrPproWalkClips(proj, function (it) {
    var media = null;
    try { media = it.getMediaPath(); } catch (e0) {}
    if (!media) return;
    counts.total++;
    var has = false;
    try { has = !!(it.hasProxy && it.hasProxy()); } catch (e1) {}
    if (has) counts.withProxy++; else counts.without++;
  });
  return counts;
}

function nrPproStats() {
  var proj = app.project;
  if (!proj) return { ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" };
  var items = 0;
  nrPproWalkClips(proj, function () { items++; });
  var enableProxies = null;
  try { enableProxies = app.getEnableProxies() === 1; } catch (e0) {}
  var sequences = 0;
  try { sequences = Number(proj.sequences.numSequences); } catch (e1) {}
  return {
    ok: true,
    app: "ppro",
    appVersion: String(app.version),
    project: proj.name,
    projectPath: proj.path || null,
    items: items,
    sequences: sequences,
    enableProxies: enableProxies,
    proxies: nrPproProxyCounts(proj),
    scratch: nrPproScratch(proj)
  };
}

/* Supprime les fichiers de rendu de la séquence (équivalent Séquence ▸ Supprimer les fichiers de
   rendu). Passe par le QE DOM : c'est la SEULE voie, et Adobe ne le supporte pas — il change d'un
   build à l'autre. D'où la détection préalable et la signature d'appel tentée dans plusieurs formes
   plutôt qu'une erreur opaque. */
function nrPproDeletePreviews() {
  try { app.enableQE(); } catch (e0) {}
  if (typeof qe === "undefined" || !qe || !qe.project) {
    return { ok: false, code: "QE_UNAVAILABLE", error: "QE DOM indisponible dans cette version" };
  }
  if (!qe.project.deletePreviewFiles) {
    return { ok: false, code: "QE_UNAVAILABLE", error: "deletePreviewFiles absent de ce build" };
  }
  var attempts = [];
  try {
    if (typeof MediaType !== "undefined" && MediaType && MediaType.ANY !== undefined) attempts.push(MediaType.ANY);
  } catch (e1) {}
  attempts.push("ANY");
  attempts.push(undefined);
  var lastError = null;
  for (var i = 0; i < attempts.length; i++) {
    try {
      qe.project.deletePreviewFiles(attempts[i]);
      return { ok: true, experimental: true };
    } catch (e2) { lastError = String(e2); }
  }
  return { ok: false, code: "QE_CALL_FAILED", error: lastError || "appel QE refusé" };
}

function nrPproHygiene(mode) {
  var proj = app.project;
  if (!proj) return { ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" };
  if (mode !== "consolidateDuplicates") return { ok: false, error: "opération inconnue : " + String(mode) };
  if (!proj.consolidateDuplicates) return { ok: false, code: "UNSUPPORTED", error: "consolidateDuplicates absent de ce build" };
  try {
    proj.consolidateDuplicates();
    return { ok: true, mode: mode };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function nrPproPrefsRead() {
  var proj = app.project;
  var enableProxies = null;
  try { enableProxies = app.getEnableProxies() === 1; } catch (e0) {}
  return {
    ok: true,
    enableProxies: enableProxies,
    scratch: proj ? nrPproScratch(proj) : { videoPreviews: null, audioPreviews: null, autoSave: null }
  };
}

/* Applique un lot de réglages. Chaque entrée est indépendante : une propriété en lecture seule est
   SAUTÉE avec sa raison, elle ne fait pas échouer les autres. */
function nrPproPrefsApply(entries) {
  var proj = app.project;
  var list = entries || [];
  var applied = [];
  var skipped = [];
  var scratchChanged = false;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    try {
      if (e.id === "enableProxies") {
        app.setEnableProxies(e.value ? 1 : 0);
        applied.push(e.id);
        continue;
      }
      if (e.kind === "path") {
        var type = nrPproScratchType(e.scratchType);
        if (type === null) { skipped.push({ id: e.id, reason: "UNSUPPORTED" }); continue; }
        if (proj && proj.setScratchDiskPath) proj.setScratchDiskPath(String(e.value), type);
        else app.setScratchDiskPath(String(e.value), type);
        scratchChanged = true;
        applied.push(e.id);
        continue;
      }
      if (!app.properties || !app.properties.setProperty) { skipped.push({ id: e.id, reason: "UNSUPPORTED" }); continue; }
      if (app.properties.isPropertyReadOnly && app.properties.isPropertyReadOnly(e.key)) {
        skipped.push({ id: e.id, reason: "READ_ONLY" });
        continue;
      }
      app.properties.setProperty(e.key, String(e.value), true, true);
      applied.push(e.id);
    } catch (e1) {
      skipped.push({ id: e.id, reason: String(e1) });
    }
  }
  // Premiere ne relit ses emplacements de travail que sur notification explicite.
  if (scratchChanged) { try { app.broadcastPrefsChanged("BE::PreferencesScratchDisksChanged"); } catch (e2) {} }
  return { ok: applied.length > 0, applied: applied, skipped: skipped };
}

function nrPproProxyAudit() {
  var proj = app.project;
  if (!proj) return { ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" };
  var items = [];
  nrPproWalkClips(proj, function (it) {
    var media = null;
    try { media = it.getMediaPath(); } catch (e0) {}
    if (!media) return;
    var can = false, has = false;
    try { can = !!(it.canProxy && it.canProxy()); } catch (e1) {}
    try { has = !!(it.hasProxy && it.hasProxy()); } catch (e2) {}
    items.push({ name: it.name, path: media, canProxy: can, hasProxy: has });
  });
  var enableProxies = null;
  try { enableProxies = app.getEnableProxies() === 1; } catch (e3) {}
  return { ok: true, items: items, enableProxies: enableProxies };
}

/* Attache des proxies déjà encodés. On n'importe JAMAIS ici : un chemin absent du projet est signalé,
   pas importé en douce (l'import d'un fichier manquant ouvre une modale qui fige l'hôte, cf.
   nrPproResolver). Les proxies sont activés une seule fois pour tout le lot. */
function nrPproAttachProxy(pairs) {
  var proj = app.project;
  if (!proj) return { ok: false, errorCode: "NO_PROJECT", error: "aucun projet ouvert" };
  var list = pairs || [];
  if (!list.length) return { ok: false, error: "aucune paire à attacher" };
  var index = nrPproIndexProject(proj);
  try { app.setEnableProxies(1); } catch (e0) {}
  var attached = 0;
  var failed = [];
  for (var i = 0; i < list.length; i++) {
    var pair = list[i];
    var item = index[nrPproNormPath(pair.path)] || null;
    if (!item || !item.attachProxy) { failed.push(pair.path); continue; }
    if (!nrPproFileExists(pair.proxy)) { failed.push(pair.path); continue; }
    try {
      // attachProxy(mediaPath, isHiRes) : 0 = média proxy, et 0 en retour = succès.
      if (item.attachProxy(pair.proxy, 0) === 0) attached++;
      else failed.push(pair.path);
    } catch (e1) {
      failed.push(pair.path);
    }
  }
  return { ok: attached > 0, attached: attached, failed: failed, total: list.length };
}

function NR_ppro_boost(p) {
  var op = (p && p.op) || "";
  if (op === "stats") return NRJSON.stringify(nrPproStats());
  if (op === "deletePreviews") return NRJSON.stringify(nrPproDeletePreviews());
  if (op === "hygiene") return NRJSON.stringify(nrPproHygiene(p.mode));
  if (op === "prefsRead") return NRJSON.stringify(nrPproPrefsRead());
  if (op === "prefsApply") return NRJSON.stringify(nrPproPrefsApply(p.entries));
  if (op === "proxyAudit") return NRJSON.stringify(nrPproProxyAudit());
  if (op === "attachProxy") return NRJSON.stringify(nrPproAttachProxy(p.pairs));
  if (op === "setEnableProxies") {
    try {
      app.setEnableProxies(p.on ? 1 : 0);
      return NRJSON.stringify({ ok: true, enableProxies: !!p.on });
    } catch (e) {
      return NRJSON.stringify({ ok: false, error: String(e) });
    }
  }
  // purge : After Effects seul expose une API de purge de cache ; Premiere n'a rien d'équivalent.
  return NRJSON.stringify({ ok: false, code: "UNSUPPORTED_OP", error: "opération inconnue : " + String(op) });
}
