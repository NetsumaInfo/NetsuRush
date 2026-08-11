// @ts-check
// FCP7 XML (xmeml v5) → document d'échange. Sert à lire ce qu'un hôte a EXPORTÉ lui-même : c'est la
// seule voie par laquelle les images clés d'un montage Resolve sortent du logiciel, l'API de script
// n'exposant aucune lecture d'animation sur les propriétés d'un plan.

const { parseXml, childNamed, childrenNamed, childText, childNumber } = require("./xmlText");
const { readClipFilters } = require("./filters");

const DEFAULT_FPS = 24;

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `<rate>` xmeml → cadence réelle : le timebase est entier, le drapeau NTSC apporte le /1,001. */
function readRate(node, fallback) {
  const rate = childNamed(node, "rate");
  if (!rate) return fallback;
  const timebase = childNumber(rate, "timebase", 0);
  if (!(timebase > 0)) return fallback;
  return childText(rate, "ntsc").toUpperCase() === "TRUE" ? (timebase * 1000) / 1001 : timebase;
}

/**
 * `file://localhost/C:/…` → `C:/…`. Un chemin déjà local (certains émetteurs) traverse inchangé,
 * et le décodage échouant (séquence % invalide) rend la chaîne brute plutôt que de perdre le plan.
 */
function localPath(pathurl) {
  const raw = String(pathurl || "").trim();
  if (!raw) return "";
  const stripped = raw.replace(/^file:\/\/(localhost)?/i, "");
  let decoded = stripped;
  try { decoded = decodeURI(stripped); } catch (_) { decoded = stripped; }
  // Windows : `/C:/…` porte une barre parasite ; UNC (`//serveur/…`) doit la garder.
  if (/^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1);
  return decoded;
}

function readFileNode(node, registry) {
  const id = node && node.attrs ? node.attrs.id : "";
  const known = id ? registry.get(id) : null;
  const pathurl = childText(node, "pathurl");
  if (!pathurl) return known || null;
  const media = childNamed(node, "media");
  const video = media ? childNamed(media, "video") : null;
  const characteristics = video ? childNamed(video, "samplecharacteristics") : null;
  const entry = {
    path: localPath(pathurl),
    name: childText(node, "name"),
    fps: readRate(node, 0) || (characteristics ? readRate(characteristics, 0) : 0),
    frames: childNumber(node, "duration", 0),
    width: characteristics ? childNumber(characteristics, "width", 0) : 0,
    height: characteristics ? childNumber(characteristics, "height", 0) : 0,
  };
  if (id) registry.set(id, entry);
  return entry;
}

/** `when` (base fichier) → frame relative au début du plan, dans la base TIMELINE. */
function frameMapper(inFrame, sourceSpan, timelineSpan) {
  const ratio = sourceSpan > 0 ? timelineSpan / sourceSpan : 1;
  return (when) => Math.round((num(when, inFrame) - inFrame) * ratio);
}

function rebaseKeyframes(property, toFrame) {
  if (!property || !Array.isArray(property.keyframes)) return property;
  const keyframes = property.keyframes
    .map((key) => ({ frame: toFrame(key.when), value: key.value, interpolation: key.interpolation }))
    .sort((a, b) => a.frame - b.frame);
  return { ...property, keyframes, value: keyframes.length ? keyframes[0].value : property.value };
}

function rebaseGroup(group, toFrame) {
  if (!group) return undefined;
  const out = {};
  let any = false;
  for (const key of Object.keys(group)) {
    if (!group[key]) continue;
    out[key] = rebaseKeyframes(group[key], toFrame);
    any = true;
  }
  return any ? out : undefined;
}

function timingFrom(remap, sourceSpan, timelineSpan) {
  const derived = { numerator: Math.max(1, sourceSpan), denominator: Math.max(1, timelineSpan) };
  if (!remap) return { speed: derived, reverse: false, freeze: false };
  const percent = num(remap.percent, 100);
  return {
    speed: { numerator: Math.round(Math.abs(percent) * 100), denominator: 10000 },
    reverse: !!remap.reverse,
    freeze: Math.abs(percent) < 1e-6,
  };
}

/** @returns {import('../types').TransferClip | null} */
function readClipItem(node, kind, track, sequence, registry) {
  const file = readFileNode(childNamed(node, "file"), registry);
  if (!file || !file.path) return null;
  const start = childNumber(node, "start", -1);
  const end = childNumber(node, "end", -1);
  // -1 = plan dont la position est portée par une transition voisine : il n'a pas de place propre.
  if (start < 0 || end <= start) return null;
  const inFrame = Math.max(0, childNumber(node, "in", 0));
  const outFrame = Math.max(inFrame + 1, childNumber(node, "out", inFrame + 1));
  const sourceSpan = outFrame - inFrame;
  const timelineSpan = end - start;
  const toFrame = frameMapper(inFrame, sourceSpan, timelineSpan);
  const filters = readClipFilters(node, {
    width: sequence.width, height: sequence.height,
    sourceWidth: file.width || sequence.width, sourceHeight: file.height || sequence.height,
  });
  const transform = filters.video && filters.video.transform;
  return {
    kind,
    track,
    path: file.path,
    name: childText(node, "name") || file.name,
    fps: readRate(node, 0) || file.fps || sequence.fps,
    srcFrames: Math.max(0, Math.round(num(file.frames, 0))),
    srcIn: inFrame,
    srcOut: outFrame - 1,
    tlStart: start,
    tlEnd: end,
    srcWidth: file.width || undefined,
    srcHeight: file.height || undefined,
    identity: { sourceHost: sequence.host },
    video: transform ? { transform: rebaseGroup(transform, toFrame) } : undefined,
    audio: rebaseGroup(filters.audio, toFrame),
    timing: timingFrom(filters.timing, sourceSpan, timelineSpan),
  };
}

/**
 * `<generatoritem>` de texte → titre du document. C'est la SEULE sortie qui rende le contenu d'un
 * Text+ Resolve : l'API de script ne liste pas les éléments Fusion d'une timeline et n'expose ni
 * leur texte ni leur police, si bien qu'un titre disparaissait sans un mot du transfert.
 * @returns {import('../types').TransferGraphic | null}
 */
function readGeneratorItem(node, track) {
  const effect = childNamed(node, "effect");
  if (!effect) return null;
  if (childText(effect, "effecttype").toLowerCase() !== "generator") return null;
  const params = {};
  for (const parameter of childrenNamed(effect, "parameter")) {
    params[childText(parameter, "parameterid").toLowerCase()] = childText(parameter, "value");
  }
  // `str` est l'identifiant du paramètre porteur du texte dans le générateur Text FCP7.
  const text = String(params.str || params.text || "").replace(/\r/g, "\n").trim();
  if (!text) return null;
  const start = childNumber(node, "start", -1);
  const end = childNumber(node, "end", -1);
  if (start < 0 || end <= start) return null;
  const size = Number(params.fontsize);
  return {
    track,
    name: childText(node, "name") || "Texte",
    tlStart: start,
    tlEnd: end,
    text,
    font: params.fontname || undefined,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
  };
}

/**
 * `<sequence>` du document, quel que soit son emballage (`project`/`bin`/racine). Le nom est visé
 * quand on le connaît : un export Premiere embarque aussi les séquences IMBRIQUÉES, et prendre la
 * première venue donnerait l'animation d'un autre montage. Parcours en largeur, donc la séquence
 * de plus haut niveau gagne quand aucun nom n'est demandé.
 */
function findSequence(root, name) {
  const wanted = String(name || "").trim();
  const stack = [root];
  let first = null;
  while (stack.length) {
    const node = stack.shift();
    if (!node) continue;
    if (node.name === "sequence") {
      if (!wanted) return node;
      if (childText(node, "name") === wanted) return node;
      if (!first) first = node;
    }
    stack.push(...(node.children || []));
  }
  return first;
}

function sequenceDimensions(sequence, fallbackFps) {
  const media = childNamed(sequence, "media");
  const video = media ? childNamed(media, "video") : null;
  const format = video ? childNamed(video, "format") : null;
  const characteristics = format ? childNamed(format, "samplecharacteristics") : null;
  return {
    fps: readRate(sequence, characteristics ? readRate(characteristics, fallbackFps) : fallbackFps),
    width: characteristics ? childNumber(characteristics, "width", 1920) : 1920,
    height: characteristics ? childNumber(characteristics, "height", 1080) : 1080,
  };
}

function collectTracks(media, kind, sequence, registry, graphics) {
  const container = media ? childNamed(media, kind === "audio" ? "audio" : "video") : null;
  if (!container) return [];
  const clips = [];
  childrenNamed(container, "track").forEach((track, index) => {
    for (const item of childrenNamed(track, "clipitem")) {
      const clip = readClipItem(item, kind, index + 1, sequence, registry);
      if (clip) clips.push(clip);
    }
    if (!graphics) return;
    for (const item of childrenNamed(track, "generatoritem")) {
      const graphic = readGeneratorItem(item, index + 1);
      if (graphic) graphics.push(graphic);
    }
  });
  return clips;
}

/**
 * @param {string} source contenu du fichier XML
 * @param {{ host?: import('../types').TransferHost, sequenceName?: string }} [opts]
 * @returns {import('../types').TransferRead}
 */
function parseXmeml(source, opts = {}) {
  const root = parseXml(source);
  const sequenceNode = root ? findSequence(root, opts.sequenceName) : null;
  if (!sequenceNode) return { ok: false, error: "xmemlNoSequence" };
  const host = opts.host || "resolve";
  const dimensions = sequenceDimensions(sequenceNode, DEFAULT_FPS);
  const sequence = { ...dimensions, host };
  const registry = new Map();
  const media = childNamed(sequenceNode, "media");
  /** @type {import('../types').TransferGraphic[]} */
  const graphics = [];
  const clips = [
    ...collectTracks(media, "video", sequence, registry, graphics),
    ...collectTracks(media, "audio", sequence, registry, null),
  ];
  if (!clips.length) return { ok: false, error: "xmemlNoClips" };
  return {
    ok: true,
    version: 2,
    host,
    timeline: childText(sequenceNode, "name"),
    fps: dimensions.fps,
    width: dimensions.width,
    height: dimensions.height,
    startFrame: 0,
    endFrame: childNumber(sequenceNode, "duration", 0) || clips.reduce((max, clip) => Math.max(max, clip.tlEnd), 0),
    clips,
    graphics,
    missing: [],
  };
}

module.exports = { parseXmeml, localPath, readRate };
