// @ts-check
// Lecture des effets xmeml portant les propriétés ANIMABLES d'un plan : Basic Motion, Opacity,
// Audio Levels, Audio Pan, Time Remap. Ce sont les seuls effets qu'un hôte de montage écrit dans un
// FCP7 XML avec leurs images clés — donc la seule source d'animation qu'on puisse extraire de
// Resolve, dont l'API de script n'expose aucune lecture de keyframe.
//
// Module PUR, en LECTURE seule : NetsuRush ne fabrique aucun XML. Le fichier sert uniquement de
// porteur de métadonnées, et c'est le script de l'hôte cible qui écrit le montage.

const { childNamed, childrenNamed, childText, childNumber } = require("./xmlText");

/** Niveau audio xmeml = gain LINÉAIRE (1 = 0 dB), plafonné à +12 dB par le format. */
const LEVEL_MAX = 3.98107;
const DECIBEL_FLOOR = -96;

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function levelToDecibel(level) {
  const linear = Math.max(0, num(level, 1));
  return linear <= 0 ? DECIBEL_FLOOR : 20 * Math.log10(linear);
}

function source(api) {
  return { host: "resolve", api: `FCP7 XML ${api}`, exactness: "exact" };
}

function readInterpolation(node) {
  const name = childText(childNamed(node, "interpolation"), "name").toLowerCase();
  if (name === "hold") return "hold";
  if (name === "bezier") return "bezier";
  if (name === "linear") return "linear";
  return "unknown";
}

/**
 * `center` et `anchorpoint` sont NORMALISÉS par les dimensions de l'image, origine au centre :
 * c'est la convention FCP7 que Premiere et Resolve appliquent tous deux. On les repasse en pixels,
 * la seule unité que le document d'échange connaisse.
 */
function decodePoint(node, scaleX, scaleY, offsetX, offsetY) {
  const value = childNamed(node, "value");
  if (!value || !childNamed(value, "horiz")) return null;
  return { x: childNumber(value, "horiz", 0) * scaleX + offsetX, y: childNumber(value, "vert", 0) * scaleY + offsetY };
}

function decodeScalar(node) {
  return childNamed(node, "value") ? childNumber(node, "value", 0) : null;
}

/**
 * `<parameter>` → propriété animée du document. `frame` reste EXPRIMÉ EN BASE FICHIER (`when`) :
 * seul l'appelant connaît les bornes du plan, donc la conversion en frames de timeline.
 */
function readParameter(node, decode, api) {
  if (!node) return undefined;
  const keys = childrenNamed(node, "keyframe");
  if (keys.length) {
    const keyframes = keys.map((key) => ({
      when: childNumber(key, "when", 0), value: decode(key), interpolation: readInterpolation(key),
    })).filter((key) => key.value !== null && key.value !== undefined);
    if (!keyframes.length) return undefined;
    return { value: keyframes[0].value, keyframes, source: source(api) };
  }
  const value = decode(node);
  return value === null || value === undefined ? undefined : { value, source: source(api) };
}

function parametersById(effect) {
  const map = new Map();
  for (const parameter of childrenNamed(effect, "parameter")) {
    const id = childText(parameter, "parameterid").toLowerCase();
    if (id) map.set(id, parameter);
  }
  return map;
}

function effectsById(clipItem) {
  const map = new Map();
  for (const filter of childrenNamed(clipItem, "filter")) {
    const effect = childNamed(filter, "effect");
    if (!effect) continue;
    const id = childText(effect, "effectid").toLowerCase();
    if (id) map.set(id, effect);
  }
  return map;
}

function readMotion(effects, ctx) {
  const effect = effects.get("basic");
  if (!effect) return {};
  const parameters = parametersById(effect);
  const width = Math.max(1, num(ctx.width, 1920));
  const height = Math.max(1, num(ctx.height, 1080));
  const sourceWidth = Math.max(1, num(ctx.sourceWidth, width));
  const sourceHeight = Math.max(1, num(ctx.sourceHeight, height));
  return {
    scale: readParameter(parameters.get("scale"), (node) => {
      const value = decodeScalar(node);
      return value === null ? null : { x: value / 100, y: value / 100 };
    }, "Basic Motion.Scale"),
    rotation: readParameter(parameters.get("rotation"), decodeScalar, "Basic Motion.Rotation"),
    position: readParameter(parameters.get("center"), (node) => decodePoint(node, width, height, 0, 0), "Basic Motion.Center"),
    anchor: readParameter(parameters.get("anchorpoint"),
      (node) => decodePoint(node, sourceWidth, sourceHeight, sourceWidth / 2, sourceHeight / 2), "Basic Motion.Anchor"),
  };
}

function readOpacity(effects) {
  const effect = effects.get("opacity");
  if (!effect) return undefined;
  return readParameter(parametersById(effect).get("opacity"), decodeScalar, "Opacity");
}

function readAudio(effects) {
  const level = effects.get("audiolevels");
  const pan = effects.get("audiopan") || effects.get("pan");
  const out = {};
  if (level) {
    out.gainDb = readParameter(parametersById(level).get("level"),
      (node) => (childNamed(node, "value") ? levelToDecibel(childNumber(node, "value", 1)) : null), "Audio Levels");
  }
  if (pan) out.pan = readParameter(parametersById(pan).get("pan"), decodeScalar, "Audio Pan");
  return out.gainDb || out.pan ? out : undefined;
}

/** Vitesse déclarée par Time Remap ; absente, elle se déduit ailleurs du rapport des bornes. */
function readTiming(effects) {
  const effect = effects.get("timeremap");
  if (!effect) return undefined;
  const parameters = parametersById(effect);
  const speedNode = parameters.get("speed");
  const reverseNode = parameters.get("reverse");
  return {
    percent: speedNode ? childNumber(speedNode, "value", 100) : 100,
    reverse: reverseNode ? childText(reverseNode, "value").toLowerCase() === "true" : false,
  };
}

function readClipFilters(clipItem, ctx) {
  const effects = effectsById(clipItem);
  if (!effects.size) return {};
  const opacity = readOpacity(effects);
  const transform = { ...readMotion(effects, ctx), ...(opacity ? { opacity } : {}) };
  const hasTransform = Object.keys(transform).some((key) => transform[key]);
  return {
    video: hasTransform ? { transform } : undefined,
    audio: readAudio(effects),
    timing: readTiming(effects),
  };
}

module.exports = { readClipFilters, levelToDecibel, LEVEL_MAX };
