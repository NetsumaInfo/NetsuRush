// @ts-check
// Adaptateur propriétés TimelineItem Resolve. Chaque écriture est relue ; une propriété absente ou
// refusée devient `unsupported`, jamais une réussite supposée.
//
// Deux régimes. `write` : l'API pose tout (voie de repli, sans image clé). `verify` : le montage est
// arrivé par import XML, l'API ne sert plus qu'à CONTRÔLER la valeur posée et à réparer ce que
// l'importeur a laissé de côté — sans jamais réécrire une propriété animée, ce qui l'aplatirait.

const NUMERIC_TOLERANCE = 1e-4;

function closeEnough(expected, actual, tolerance = NUMERIC_TOLERANCE) {
  if (typeof expected === "boolean") return !!actual === expected;
  const e = Number(expected);
  const a = Number(actual);
  return Number.isFinite(e) && Number.isFinite(a) && Math.abs(e - a) <= tolerance;
}

function valueOf(property, fallback) {
  return property && Object.prototype.hasOwnProperty.call(property, "value") ? property.value : fallback;
}

function isAnimated(property) {
  return !!(property && Array.isArray(property.keyframes) && property.keyframes.length);
}

async function readProperty(item, key) {
  try { return await item.GetProperty(key); } catch (_) { return undefined; }
}

async function writeProperty(item, key, value) {
  try { return !!(await item.SetProperty(key, value)); } catch (_) { return false; }
}

function report(clipIndex, property, status, extra) {
  return { clip: clipIndex, property, status, readback: false, ...extra };
}

async function setAndRead(item, clipIndex, request) {
  const { property, key, value, tolerance } = request;
  if (!(await writeProperty(item, key, value))) {
    // La valeur refusée fait partie du diagnostic : « anchor rejeté » ne dit pas si Resolve bute
    // sur la propriété ou sur ce qu'on lui demande d'y mettre.
    return report(clipIndex, property, "unsupported", { reason: "setPropertyRejected", expected: value });
  }
  const actual = await readProperty(item, key);
  if (actual === undefined) return report(clipIndex, property, "unsupported", { reason: "readbackUnavailable" });
  if (!closeEnough(value, actual, tolerance)) {
    return report(clipIndex, property, "readbackMismatch", { expected: value, actual, readback: true });
  }
  return report(clipIndex, property, "applied", { expected: value, actual, readback: true });
}

/** Contrôle d'abord : une valeur déjà bonne ne se réécrit pas, ce qui laisse l'import maître. */
async function verifyThenRepair(item, clipIndex, request) {
  const actual = await readProperty(item, request.key);
  if (actual !== undefined && closeEnough(request.value, actual, request.tolerance)) {
    return report(clipIndex, request.property, "applied", { expected: request.value, actual, readback: true });
  }
  return setAndRead(item, clipIndex, request);
}

function transformRequests(transform, clip) {
  const requests = [];
  /** @type {(property:string, key:string, value:any, source:any, tolerance?:number, neutral?:any)=>void} */
  const push = (property, key, value, source, tolerance, neutral = 0) => {
    requests.push({ property, key, value, tolerance, neutral, animated: isAnimated(source) });
  };
  const position = valueOf(transform.position, null);
  if (position) {
    push("video.position", "Pan", Number(position.x) || 0, transform.position);
    // Resolve compte le Tilt vers le HAUT, le document vers le BAS (convention Premiere/AE).
    push("video.position", "Tilt", -(Number(position.y) || 0), transform.position);
  }
  const scale = valueOf(transform.scale, null);
  if (scale) {
    push("video.scale", "ZoomX", Number(scale.x) || 0, transform.scale, undefined, 1);
    push("video.scale", "ZoomY", Number(scale.y) || 0, transform.scale, undefined, 1);
  }
  const anchor = valueOf(transform.anchor, null);
  // Le document tient l'ancrage en pixels source depuis le coin haut-gauche (convention Premiere/AE) ;
  // Resolve le veut en décalage depuis le CENTRE, Y vers le haut. Sans dimensions source, la
  // conversion serait une invention : on n'écrit rien plutôt que de déplacer le plan au hasard.
  if (anchor && clip.srcWidth > 0 && clip.srcHeight > 0) {
    push("video.anchor", "AnchorPointX", (Number(anchor.x) || 0) - clip.srcWidth / 2, transform.anchor);
    push("video.anchor", "AnchorPointY", clip.srcHeight / 2 - (Number(anchor.y) || 0), transform.anchor);
  }
  if (transform.rotation) push("video.rotation", "RotationAngle", Number(valueOf(transform.rotation, 0)) || 0, transform.rotation);
  if (transform.opacity) push("video.opacity", "Opacity", Number(valueOf(transform.opacity, 100)), transform.opacity, undefined, 100);
  if (transform.flipX) push("video.flip", "FlipX", !!valueOf(transform.flipX, false), transform.flipX, 0, false);
  if (transform.flipY) push("video.flip", "FlipY", !!valueOf(transform.flipY, false), transform.flipY, 0, false);
  const crop = transform.crop || {};
  const cropKeys = [["left", "CropLeft"], ["right", "CropRight"], ["top", "CropTop"], ["bottom", "CropBottom"]];
  for (const [side, key] of cropKeys) {
    if (crop[side]) push("video.crop", key, Number(valueOf(crop[side], 0)) || 0, crop[side]);
  }
  return requests;
}

// Clés audio non documentées selon versions Resolve : tenter uniquement si le document en demande
// une, puis laisser SetProperty/GetProperty décider et rapporter honnêtement la capacité runtime.
function audioRequests(audio) {
  const requests = [];
  /** @type {(property:string, key:string, value:any, source:any, tolerance?:number, neutral?:any)=>void} */
  const push = (property, key, value, source, tolerance, neutral = 0) => {
    requests.push({ property, key, value, tolerance, neutral, animated: isAnimated(source) });
  };
  if (audio.gainDb) push("audio.gain", "AudioGain", Number(valueOf(audio.gainDb, 0)) || 0, audio.gainDb);
  if (audio.volume) push("audio.volume", "Volume", Number(valueOf(audio.volume, 1)), audio.volume, undefined, 1);
  if (audio.pan) push("audio.pan", "Pan", Number(valueOf(audio.pan, 0)) || 0, audio.pan);
  if (audio.mute) push("audio.mute", "Mute", !!valueOf(audio.mute, false), audio.mute, 0, false);
  return requests;
}

/** La demande vaut-elle déjà l'état d'un plan neuf ? Alors il n'y a rien à écrire. */
function isNeutral(request) {
  if (typeof request.value === "boolean") return request.value === !!request.neutral;
  return closeEnough(request.neutral, request.value, request.tolerance);
}

function requestsFor(clip) {
  const transform = clip.video && clip.video.transform;
  return [
    ...(transform ? transformRequests(transform, clip) : []),
    ...(clip.audio ? audioRequests(clip.audio) : []),
  ];
}

/** Propriétés animées du plan, nommées comme la matrice de capacités les désigne. */
function animatedProperties(clip) {
  const transform = (clip.video && clip.video.transform) || {};
  const audio = clip.audio || {};
  const named = [
    ["video.position", transform.position], ["video.scale", transform.scale],
    ["video.anchor", transform.anchor], ["video.rotation", transform.rotation],
    ["video.opacity", transform.opacity],
    ["audio.gain", audio.gainDb], ["audio.volume", audio.volume],
    ["audio.pan", audio.pan], ["audio.mute", audio.mute],
  ];
  return named.filter(([, property]) => isAnimated(property)).map(([name]) => name);
}

function timingReports(clip, clipIndex, carried) {
  const timing = clip.timing;
  if (!timing) return [];
  const properties = [];
  if (timing.speed && timing.speed.numerator !== timing.speed.denominator) properties.push("timing.speed");
  if (timing.reverse) properties.push("timing.reverse");
  if (timing.freeze) properties.push("timing.freeze");
  if (timing.timeMap && timing.timeMap.length) properties.push("timing.timeMap");
  return properties.map((property) => {
    // La vitesse constante et l'inversion voyagent dans le fichier importé ; la courbe de vitesse,
    // non — et Resolve n'expose aucune relecture de retime, d'où l'absence de readback.
    const inFile = carried && (property === "timing.speed" || property === "timing.reverse");
    return inFile
      ? report(clipIndex, property, "applied", { reason: "carriedByTimelineImport" })
      : report(clipIndex, property, "unsupported", { reason: "resolveRetimeWriteUnavailable" });
  });
}

/**
 * @param {any} item TimelineItem Resolve
 * @param {import('./types').TransferClip} clip
 * @param {number} clipIndex
 * @param {{ mode?: 'write'|'verify', animationCarried?: boolean, timingCarried?: boolean }} [opts]
 */
async function applyResolveClip(item, clip, clipIndex, opts = {}) {
  const verify = opts.mode === "verify";
  const fusionCarried = !!opts.animationCarried;
  const carried = fusionCarried || verify;
  const results = [];
  for (const request of requestsFor(clip)) {
    // Une comp Fusion porte TOUT le cadrage du plan — position, ancrage, échelle, rotation,
    // miroirs, opacité — et pas seulement ses courbes : `transformTool` écrit aussi les valeurs
    // FIXES des propriétés non animées. Or le redimensionnement de la page Montage s'applique
    // APRÈS Fusion : réécrire ces valeurs par `SetProperty` les CUMULE. C'est ce qui rendait un
    // plan animé « un peu trop zoomé » et touchait des réglages que l'utilisateur n'avait pas posés.
    if (fusionCarried && request.property.startsWith("video.")) {
      results.push(report(clipIndex, request.property, "applied", { reason: "carriedByFusionComp" }));
      continue;
    }
    if (carried && request.animated) continue;
    // Valeur NEUTRE sur un plan qu'on vient de poser : il la porte déjà. L'écrire quand même
    // n'apporte rien et expose au refus — c'est ce qui remplissait le rapport de « anchor rejeté »
    // sur des ancres parfaitement centrées. En `verify` on garde l'écriture : l'import a pu poser
    // autre chose, et c'est justement le rôle de ce mode de le corriger.
    if (!verify && !request.animated && isNeutral(request)) continue;
    results.push(verify ? await verifyThenRepair(item, clipIndex, request) : await setAndRead(item, clipIndex, request));
  }
  for (const property of animatedProperties(clip)) {
    results.push(carried
      ? report(clipIndex, `${property}.keyframes`, "applied", { reason: "resolveKeyframeReadbackUnavailable" })
      : report(clipIndex, `${property}.keyframes`, "unsupported", { reason: "resolveKeyframeWriteUnavailable" }));
  }
  results.push(...timingReports(clip, clipIndex, !!opts.timingCarried || verify));
  return results;
}

module.exports = { applyResolveClip, requestsFor, animatedProperties, closeEnough };
