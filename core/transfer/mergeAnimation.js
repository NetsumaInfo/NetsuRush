// @ts-check
// Greffe des propriétés ANIMÉES d'un second document sur un premier. Fonctions PURES.
//
// Pourquoi greffer plutôt que remplacer : la lecture par l'API Resolve porte tout ce que l'export
// XML ne sait pas rendre — bornes source exactes (GetSourceStartFrame), dé-ancrage du Start TC,
// aplatissement des timelines imbriquées, chemins réels du Media Pool. L'export XML n'apporte QUE
// l'animation. Écraser le document reviendrait à échanger trois invariants contre des images clés.

const KEY_TOLERANCE_FRAMES = 2;

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function animated(property) {
  return !!(property && Array.isArray(property.keyframes) && property.keyframes.length);
}

function trackKey(clip) {
  return `${clip.kind}|${clip.track}`;
}

function byTrack(clips) {
  const groups = new Map();
  clips.forEach((clip, index) => {
    const key = trackKey(clip);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ clip, index });
  });
  for (const group of groups.values()) group.sort((a, b) => a.clip.tlStart - b.clip.tlStart);
  return groups;
}

/**
 * Appariement plan à plan, PISTE PAR PISTE et dans l'ordre chronologique. Une piste dont les deux
 * lectures ne comptent pas le même nombre de plans n'est pas appariée : c'est le cas d'une timeline
 * imbriquée, que l'API aplatit et que l'export XML garde entière — deviner l'alignement y
 * poserait l'animation d'un plan sur un autre.
 */
function pairClips(base, overlay) {
  const overlayTracks = byTrack(overlay);
  const pairs = [];
  const unmatched = [];
  for (const [key, group] of byTrack(base)) {
    const candidates = overlayTracks.get(key);
    if (!candidates || candidates.length !== group.length) {
      for (const entry of group) unmatched.push(entry.index);
      continue;
    }
    group.forEach((entry, position) => {
      const other = candidates[position];
      if (normalizePath(entry.clip.path) !== normalizePath(other.clip.path)) { unmatched.push(entry.index); return; }
      pairs.push({ index: entry.index, base: entry.clip, overlay: other.clip });
    });
  }
  return { pairs, unmatched };
}

/** Une image clé hors du plan est le signe d'un appariement douteux : on refuse la greffe. */
function keyframesFit(property, clip) {
  const span = Math.max(1, clip.tlEnd - clip.tlStart);
  return property.keyframes.every((key) => key.frame >= -KEY_TOLERANCE_FRAMES && key.frame <= span + KEY_TOLERANCE_FRAMES);
}

/**
 * Deux raisons de greffer, et deux seulement.
 * 1. La propriété est ANIMÉE : l'API ne lit aucune image clé, le XML est la seule source.
 * 2. Le document n'a AUCUNE valeur pour elle : le gain, le panoramique et la coupure audio ne sont
 *    exposés par aucune clé de `TimelineItem.GetProperty` — les jeter reviendrait à transférer un
 *    montage muet parce que Resolve refuse de dire son niveau.
 * Jamais pour écraser une valeur que l'API a su lire : elle est relue sur l'objet, donc exacte.
 */
function mergeGroup(baseGroup, overlayGroup, clip) {
  if (!overlayGroup) return { group: baseGroup, grafted: [] };
  const out = { ...(baseGroup || {}) };
  const grafted = [];
  for (const key of Object.keys(overlayGroup)) {
    const property = overlayGroup[key];
    if (!property) continue;
    if (animated(property)) {
      if (!keyframesFit(property, clip)) continue;
    } else if (baseGroup && baseGroup[key]) continue;
    // La VALEUR fixe reste celle de l'API quand elle existe ; seules les images clés arrivent du
    // XML, avec la valeur de la première comme point de départ.
    out[key] = { ...(baseGroup && baseGroup[key]), ...property };
    grafted.push(key);
  }
  return { group: Object.keys(out).length ? out : undefined, grafted };
}

/**
 * @param {import('./types').TransferDoc} base document de référence (lecture API)
 * @param {import('./types').TransferDoc} overlay document d'animation (lecture XML)
 * @returns {{ doc: import('./types').TransferDoc, animatedClips: number, skippedClips: number[] }}
 */
function mergeAnimation(base, overlay) {
  if (!overlay || overlay.ok !== true || !overlay.clips.length) {
    return { doc: base, animatedClips: 0, skippedClips: [] };
  }
  const { pairs, unmatched } = pairClips(base.clips, overlay.clips);
  const clips = base.clips.slice();
  let animatedClips = 0;
  for (const pair of pairs) {
    const transform = mergeGroup(
      pair.base.video && pair.base.video.transform,
      pair.overlay.video && pair.overlay.video.transform,
      pair.base,
    );
    const audio = mergeGroup(pair.base.audio, pair.overlay.audio, pair.base);
    if (!transform.grafted.length && !audio.grafted.length) continue;
    animatedClips += 1;
    clips[pair.index] = {
      ...pair.base,
      video: transform.group ? { ...pair.base.video, transform: transform.group } : pair.base.video,
      audio: audio.group || pair.base.audio,
    };
  }
  return { doc: { ...base, clips }, animatedClips, skippedClips: unmatched };
}

module.exports = { mergeAnimation, pairClips, KEY_TOLERANCE_FRAMES };
