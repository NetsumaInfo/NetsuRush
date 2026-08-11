// @ts-check
// Images clés des transformations, greffées sur les plans lus pour l'export After Effects.
//
// L'API de script de Resolve ne lit AUCUNE image clé : `TimelineItem.GetProperty` rend une valeur
// fixe, et rien d'autre n'existe (vérifié jusqu'à l'API v21). La seule sortie qui porte les courbes
// est son export FCP7 XML ; c'est déjà lui que NetsuBridge lit pour les autres cibles, avec le même
// appariement piste par piste.

const { pairClips, KEY_TOLERANCE_FRAMES } = require('../transfer/mergeAnimation');

const isAnimated = (property) => !!(property && Array.isArray(property.keyframes) && property.keyframes.length);

/**
 * Une image clé hors des bornes du plan est le signe d'un appariement douteux : on refuse la greffe
 * plutôt que de poser l'animation d'un plan sur son voisin.
 */
function keyframesFit(property, clip) {
  const span = Math.max(1, clip.tlEnd - clip.tlStart);
  return property.keyframes.every((key) => key.frame >= -KEY_TOLERANCE_FRAMES && key.frame <= span + KEY_TOLERANCE_FRAMES);
}

/**
 * Greffe les propriétés ANIMÉES du document XML sur les plans de l'export AE, EN PLACE.
 *
 * Seules les propriétés animées traversent : une valeur fixe est déjà lue sur l'objet Resolve, donc
 * exacte, et l'écraser par le XML échangerait une vérité contre une approximation. Les plans issus
 * d'une timeline imbriquée sont écartés — l'API les aplatit, le XML les garde entiers, et les
 * compter ensemble ferait glisser tout l'appariement d'une piste.
 *
 * @param {any} overlay document lu depuis l'export FCP7 XML (`readTimelineXml`)
 * @param {import('./types').ClipItem[]} items plans de l'export AE, modifiés en place
 * @returns {{ animated: number }}
 */
function graftAnimation(overlay, items) {
  if (!overlay || overlay.ok !== true || !Array.isArray(overlay.clips) || !overlay.clips.length) {
    return { animated: 0 };
  }
  const eligible = items
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip.kind === 'video' && !clip.group && !clip.nested && !clip.rendered);
  if (!eligible.length) return { animated: 0 };

  const { pairs } = pairClips(eligible.map((entry) => entry.clip), overlay.clips);
  let animated = 0;
  for (const pair of pairs) {
    const transform = pair.overlay.video && pair.overlay.video.transform;
    if (!transform) continue;
    /** @type {Record<string, any>} */
    const anim = {};
    let any = false;
    for (const key of Object.keys(transform)) {
      const property = transform[key];
      if (!isAnimated(property) || !keyframesFit(property, pair.base)) continue;
      anim[key] = property;
      any = true;
    }
    if (!any) continue;
    eligible[pair.index].clip.anim = anim;
    animated += 1;
  }
  return { animated };
}

module.exports = { graftAnimation };
