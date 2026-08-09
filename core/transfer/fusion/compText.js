// @ts-check
// Fabrication du TEXTE d'une composition Fusion portant l'animation d'un plan. Module PUR.
//
// Pourquoi Fusion : l'API de script de Resolve pose des valeurs FIXES (`SetProperty`) et n'expose
// aucune image clé (vérifié jusqu'à l'API v21). `TimelineItem.ImportFusionComp(path)` est la seule
// écriture d'animation qui existe, et `ExportFusionComp` permet de RELIRE ce qui a été posé.
//
// La comp n'est jamais écrite de toutes pièces : on part du squelette que Resolve vient d'exporter
// (`AddFusionComp` puis `ExportFusionComp`) et on s'insère entre son MediaIn et son MediaOut. Les
// en-têtes, la version du format et les noms de nœuds sont donc ceux de Resolve, pas les nôtres —
// une comp écrite de mémoire se périmerait à la première évolution du format.

const NODE = {
  transform: "NRTransform",
  // Nœud d'opacité. Le nom reste `NRFade` bien que l'outil soit un `BrightnessContrast` : c'est ce
  // qu'il FAIT dans la comp, et une comp déjà posée garderait de toute façon ce nom.
  merge: "NRFade",
};
const SPLINE_COLOR = "SplineColor = { Red = 246, Green = 121, Blue = 0 }";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function valueOf(property, fallback) {
  return property && Object.prototype.hasOwnProperty.call(property, "value") ? property.value : fallback;
}

function keyframesOf(property) {
  return property && Array.isArray(property.keyframes) && property.keyframes.length ? property.keyframes : null;
}

function isAnimated(property) {
  return !!keyframesOf(property);
}

/** Vrai dès qu'une propriété de transform du plan porte des images clés. */
function clipIsAnimated(clip) {
  const transform = (clip.video && clip.video.transform) || {};
  return [transform.position, transform.scale, transform.anchor, transform.rotation, transform.opacity]
    .some(isAnimated);
}

// --- lecture du squelette ------------------------------------------------------------------------

/** Bloc `Nom = Type { … }` délimité par ACCOLADES ÉQUILIBRÉES : une regex s'arrêterait au premier `}`. */
function findToolBlock(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  const open = text.indexOf("{", match.index);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { name: match[1], type: match[2], start: match.index, end: index + 1, body: text.slice(open, index + 1) };
    }
  }
  return null;
}

/**
 * Squelette exporté → points d'ancrage de la greffe.
 * @returns {{ mediaIn:string, mediaOut:string, mediaOutStart:number, mediaOutEnd:number,
 *             upstream:{op:string, source:string}, globalStart:number } | null}
 */
function readSkeleton(text) {
  const source = String(text || "");
  // `ExportFusionComp` écrit la comp au format Fusion AUTONOME : les nœuds de la page Fusion y
  // deviennent `Loader`/`Saver`, pas `MediaIn`/`MediaOut` (constaté sur Resolve Studio 21.0.3).
  // Ne chercher que les seconds rendait tout squelette illisible, donc aucune image clé posée.
  const mediaOut = findToolBlock(source, /(\w+)\s*=\s*(MediaOut|Saver)\s*\{/g);
  if (!mediaOut) return null;
  const mediaIn = findToolBlock(source, /(\w+)\s*=\s*(MediaIn|Loader)\s*\{/g);
  const input = /Input\s*=\s*Input\s*\{\s*SourceOp\s*=\s*"([^"]+)"\s*,\s*Source\s*=\s*"([^"]+)"/.exec(mediaOut.body);
  const globalStart = /GlobalStart\s*=\s*(-?\d+)/.exec(source);
  return {
    mediaIn: mediaIn ? mediaIn.name : "MediaIn1",
    mediaOut: mediaOut.name,
    mediaOutStart: mediaOut.start,
    mediaOutEnd: mediaOut.end,
    upstream: input ? { op: input[1], source: input[2] } : { op: mediaIn ? mediaIn.name : "MediaIn1", source: "Output" },
    globalStart: globalStart ? Number(globalStart[1]) : 0,
  };
}

/** Contrôle de relecture : la greffe a-t-elle survécu à l'import ? */
function skeletonHasAnimation(text) {
  const source = String(text || "");
  const hasTransform = new RegExp(`${NODE.transform}\\s*=\\s*Transform\\s*\\{`).test(source);
  const keyframes = /KeyFrames\s*=\s*\{\s*\[/.test(source);
  return hasTransform && keyframes;
}

// --- écriture ------------------------------------------------------------------------------------

function formatNumber(value) {
  const rounded = Math.round(num(value, 0) * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Spline d'une valeur scalaire. `Linear` sur chaque clé : le document ne transporte pas les poignées
 * de Bézier des hôtes (leurs unités diffèrent), et une interpolation inventée mentirait sur la courbe.
 */
function bezierSpline(name, keys) {
  const frames = keys
    .map((key) => `\t\t\t\t[${Math.round(num(key.frame, 0))}] = { ${formatNumber(key.value)}, Flags = { Linear = true } }`)
    .join(",\n");
  return `\t\t${name} = BezierSpline {\n\t\t\t${SPLINE_COLOR},\n\t\t\tNameSet = true,\n\t\t\tKeyFrames = {\n${frames}\n\t\t\t}\n\t\t},`;
}

/** Un point animé se pilote par DEUX splines réunies dans un XYPath — Fusion n'anime pas un Point d'un bloc. */
function xyPath(name, keysX, keysY) {
  return [
    bezierSpline(`${name}X`, keysX),
    bezierSpline(`${name}Y`, keysY),
    `\t\t${name} = XYPath {\n\t\t\tDrawMode = "ModifyOnly",\n\t\t\tNameSet = true,\n\t\t\tInputs = {\n`
      + `\t\t\t\tX = Input { SourceOp = "${name}X", Source = "Value", },\n`
      + `\t\t\t\tY = Input { SourceOp = "${name}Y", Source = "Value", },\n\t\t\t}\n\t\t},`,
  ].join("\n");
}

/** Entrée d'un outil : une valeur fixe, ou le branchement sur la spline qui la pilote. */
function inputLine(name, property, encode, splineName) {
  if (!property) return "";
  if (keyframesOf(property)) return `\t\t\t\t${name} = Input { SourceOp = "${splineName}", Source = "Value", },`;
  return `\t\t\t\t${name} = Input { Value = ${formatNumber(encode(valueOf(property, 0)))}, },`;
}

function pointInputLine(name, property, encode, splineName) {
  if (!property) return "";
  if (keyframesOf(property)) return `\t\t\t\t${name} = Input { SourceOp = "${splineName}", Source = "Value", },`;
  const point = encode(valueOf(property, { x: 0, y: 0 }));
  return `\t\t\t\t${name} = Input { Value = { ${formatNumber(point.x)}, ${formatNumber(point.y)} }, },`;
}

/**
 * Conversions vers l'espace Fusion, qui est NORMALISÉ (0..1) avec l'origine en bas à gauche et Y
 * vers le HAUT — l'inverse du document, qui compte en pixels depuis le centre avec Y vers le bas.
 */
function converters(dims) {
  const width = Math.max(1, num(dims.width, 1920));
  const height = Math.max(1, num(dims.height, 1080));
  const sourceWidth = Math.max(1, num(dims.sourceWidth, width));
  const sourceHeight = Math.max(1, num(dims.sourceHeight, height));
  return {
    center: (value) => ({ x: 0.5 + num(value && value.x, 0) / width, y: 0.5 - num(value && value.y, 0) / height }),
    pivot: (value) => ({
      x: num(value && value.x, sourceWidth / 2) / sourceWidth,
      y: 1 - num(value && value.y, sourceHeight / 2) / sourceHeight,
    }),
    size: (value) => num(value && value.y, 1),
    aspect: (value) => num(value && value.x, 1) / Math.max(1e-6, num(value && value.y, 1)),
    // Les hôtes de montage comptent la rotation dans le sens horaire, Fusion dans le sens inverse.
    angle: (value) => -num(value, 0),
    blend: (value) => Math.min(1, Math.max(0, num(value, 100) / 100)),
  };
}

function mapKeys(keys, pick, offset) {
  return keys.map((key) => ({ frame: num(key.frame, 0) + offset, value: pick(key.value) }));
}

function transformTool(transform, convert, offset, upstream) {
  const splines = [];
  const inputs = [];
  const position = transform.position;
  if (keyframesOf(position)) {
    const keys = keyframesOf(position);
    splines.push(xyPath(`${NODE.transform}Center`,
      mapKeys(keys, (value) => convert.center(value).x, offset),
      mapKeys(keys, (value) => convert.center(value).y, offset)));
  }
  inputs.push(pointInputLine("Center", position, convert.center, `${NODE.transform}Center`));
  inputs.push(pointInputLine("Pivot", transform.anchor, convert.pivot, `${NODE.transform}Pivot`));
  if (keyframesOf(transform.anchor)) {
    const keys = keyframesOf(transform.anchor);
    splines.push(xyPath(`${NODE.transform}Pivot`,
      mapKeys(keys, (value) => convert.pivot(value).x, offset),
      mapKeys(keys, (value) => convert.pivot(value).y, offset)));
  }
  if (keyframesOf(transform.scale)) {
    const keys = keyframesOf(transform.scale);
    splines.push(bezierSpline(`${NODE.transform}Size`, mapKeys(keys, convert.size, offset)));
    splines.push(bezierSpline(`${NODE.transform}Aspect`, mapKeys(keys, convert.aspect, offset)));
    inputs.push(`\t\t\t\tSize = Input { SourceOp = "${NODE.transform}Size", Source = "Value", },`);
    inputs.push(`\t\t\t\tAspect = Input { SourceOp = "${NODE.transform}Aspect", Source = "Value", },`);
  } else if (transform.scale) {
    inputs.push(inputLine("Size", transform.scale, convert.size, ""));
    inputs.push(inputLine("Aspect", transform.scale, convert.aspect, ""));
  }
  if (keyframesOf(transform.rotation)) {
    splines.push(bezierSpline(`${NODE.transform}Angle`, mapKeys(keyframesOf(transform.rotation), convert.angle, offset)));
  }
  inputs.push(inputLine("Angle", transform.rotation, convert.angle, `${NODE.transform}Angle`));
  if (valueOf(transform.flipX, false)) inputs.push('\t\t\t\tFlipHoriz = Input { Value = 1, },');
  if (valueOf(transform.flipY, false)) inputs.push('\t\t\t\tFlipVert = Input { Value = 1, },');
  inputs.push(`\t\t\t\tInput = Input { SourceOp = "${upstream.op}", Source = "${upstream.source}", },`);

  const tool = `\t\t${NODE.transform} = Transform {\n\t\tNameSet = true,\n\t\t\tInputs = {\n`
    + `${inputs.filter(Boolean).join("\n")}\n\t\t\t},\n\t\t\tViewInfo = OperatorInfo { Pos = { 165, 0 } },\n\t\t},`;
  return { text: [...splines, tool].join("\n"), output: NODE.transform };
}

/** L'opacité vaut-elle son défaut ? Alors il n'y a rien à poser pour elle. */
function opacityIsNeutral(opacity) {
  return !keyframesOf(opacity) && Math.abs(num(valueOf(opacity, 100), 100) - 100) < 1e-6;
}

/**
 * L'opacité n'est pas une entrée de Transform. Elle se rend par un `BrightnessContrast`, dont
 * l'entrée `Alpha` multiplie le canal alpha — un opérateur PIXEL À PIXEL, qui laisse la taille de
 * l'image intacte.
 *
 * Pourquoi pas un Merge sur un fond transparent, la façon la plus courante de le faire : le fond
 * impose sa taille à la sortie de la comp, ce qui court-circuite l'ajustement automatique de
 * Resolve (« mise à l'échelle pour remplir »). Un rush dont la résolution diffère de la timeline
 * arrivait donc débordé — vu en vrai : un plan zoomé dans Resolve alors qu'il ne l'est pas dans
 * Premiere, sur le seul plan qui portait un fondu.
 */
function fadeTools(opacity, convert, offset, dims, upstream) {
  if (!opacity || opacityIsNeutral(opacity)) return null;
  const splines = keyframesOf(opacity)
    ? [bezierSpline(`${NODE.merge}Alpha`, mapKeys(keyframesOf(opacity), convert.blend, offset))]
    : [];
  const alpha = keyframesOf(opacity)
    ? `\t\t\t\tAlpha = Input { SourceOp = "${NODE.merge}Alpha", Source = "Value", },`
    : `\t\t\t\tAlpha = Input { Value = ${formatNumber(convert.blend(valueOf(opacity, 100)))}, },`;
  const tool = `\t\t${NODE.merge} = BrightnessContrast {\n\t\t\tNameSet = true,\n\t\t\tInputs = {\n${alpha}\n`
    + `\t\t\t\tInput = Input { SourceOp = "${upstream.op}", Source = "${upstream.source}", },\n`
    + `\t\t\t},\n\t\t\tViewInfo = OperatorInfo { Pos = { 220, 0 } },\n\t\t},`;
  return { text: [...splines, tool].join("\n"), output: NODE.merge };
}

/**
 * Squelette exporté + plan animé → texte de composition à réimporter.
 * @param {string} skeletonText comp que Resolve vient d'exporter pour ce plan
 * @param {import('../types').TransferClip} clip
 * @param {{ width:number, height:number }} timeline
 * @returns {{ ok:true, text:string } | { ok:false, reason:string }}
 */
function buildAnimatedComp(skeletonText, clip, timeline) {
  const skeleton = readSkeleton(skeletonText);
  if (!skeleton) return { ok: false, reason: "fusionSkeletonUnreadable" };
  const transform = clip.video && clip.video.transform;
  if (!transform) return { ok: false, reason: "clipHasNoTransform" };
  const convert = converters({
    width: timeline.width, height: timeline.height,
    sourceWidth: clip.srcWidth, sourceHeight: clip.srcHeight,
  });
  const offset = skeleton.globalStart;
  const built = transformTool(transform, convert, offset, skeleton.upstream);
  const fade = fadeTools(transform.opacity, convert, offset, timeline, { op: built.output, source: "Output" });
  const output = fade ? fade.output : built.output;
  const inserted = `${built.text}\n${fade ? `${fade.text}\n` : ""}`;

  const before = skeletonText.slice(0, skeleton.mediaOutStart);
  const mediaOut = skeletonText.slice(skeleton.mediaOutStart, skeleton.mediaOutEnd)
    .replace(/(Input\s*=\s*Input\s*\{\s*SourceOp\s*=\s*")[^"]+(")/, `$1${output}$2`);
  const after = skeletonText.slice(skeleton.mediaOutEnd);
  return { ok: true, text: `${before}${inserted}${mediaOut}${after}` };
}

module.exports = { buildAnimatedComp, readSkeleton, skeletonHasAnimation, clipIsAnimated, NODE };
