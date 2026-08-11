// @ts-check
// Document d'échange NEUTRE entre hôtes de montage. Uniquement des fonctions PURES : les mappeurs
// et la frame-math du transfert restent vérifiables sans Resolve ni Adobe ouverts.

/** Resolve : `mediaType` de AppendToTimeline — poser un plan vidéo SANS son audio lié. */
const MEDIA_TYPE_VIDEO = 1;
const MEDIA_TYPE_AUDIO = 2;
/** @type {2} */
const TRANSFER_VERSION = 2;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Valeur numérique exploitable, sinon `fallback` (les hôtes renvoient volontiers null). */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) { const next = x % y; x = y; y = next; }
  return x || 1;
}

function reduced(numerator, denominator) {
  const den = Math.max(1, Math.abs(Math.round(denominator)));
  const sign = denominator < 0 ? -1 : 1;
  const n = Math.round(numerator) * sign;
  const common = gcd(n, den);
  return { numerator: n / common, denominator: den / common };
}

/** Cadences usuelles exactes, sinon approximation rationnelle bornée au millième. */
function frameRateRational(fps) {
  const value = num(fps, 0);
  const broadcast = [24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001];
  for (const rate of broadcast) {
    if (Math.abs(value - rate) < 0.001) return reduced(Math.round(rate * 1001), 1001);
  }
  if (Number.isInteger(value)) return reduced(value, 1);
  return reduced(Math.round(value * 1000), 1000);
}

function timingFor(clip, timelineFps, flags = {}) {
  const srcSpan = Math.max(1, num(clip.srcOut, 0) - num(clip.srcIn, 0) + 1);
  const tlSpan = Math.max(1, num(clip.tlEnd, 0) - num(clip.tlStart, 0));
  const sourceRate = frameRateRational(num(clip.fps, timelineFps));
  const timelineRate = frameRateRational(timelineFps);
  const speed = reduced(
    srcSpan * sourceRate.denominator * timelineRate.numerator,
    tlSpan * sourceRate.numerator * timelineRate.denominator,
  );
  return {
    speed,
    reverse: !!flags.reverse,
    freeze: !!flags.freeze,
    source: flags.source,
  };
}

function valueOf(property, fallback) {
  return property && Object.prototype.hasOwnProperty.call(property, "value") ? property.value : fallback;
}

/**
 * @param {import('./types').TransferHost} host
 * @param {string} api
 * @param {import('./types').TransferExactness} [exactness]
 * @param {string} [reason]
 * @returns {import('./types').TransferPropertySource}
 */
function source(host, api, exactness = "exact", reason) {
  return { host, api, exactness, ...(reason ? { reason } : {}) };
}

/**
 * Point d'ancrage CANONIQUE du document : pixels de la SOURCE, origine au coin haut-gauche, Y vers
 * le bas — la convention de Premiere ET d'After Effects, donc deux hôtes sur trois. Resolve, lui,
 * le compte en décalage depuis le CENTRE avec Y vers le haut. Sans cette normalisation, un ancrage
 * traversait tel quel et décalait le plan de la moitié de l'image.
 * Dimensions source inconnues ⇒ la conversion est approchée sur celles de la timeline, et le dit.
 */
function resolveAnchor(xf, dims) {
  const anchorX = num(xf.anchorX, 0);
  const anchorY = num(xf.anchorY, 0);
  const width = num(dims && dims.width, 0);
  const height = num(dims && dims.height, 0);
  const known = width > 0 && height > 0;
  if (!known && Math.abs(anchorX) < 1e-6 && Math.abs(anchorY) < 1e-6) return undefined;
  const fallback = { width: num(dims && dims.timelineWidth, 1920), height: num(dims && dims.timelineHeight, 1080) };
  const halfWidth = (known ? width : fallback.width) / 2;
  const halfHeight = (known ? height : fallback.height) / 2;
  return {
    value: { x: halfWidth + anchorX, y: halfHeight - anchorY },
    source: source("resolve", "TimelineItem.GetProperty(AnchorPoint)", known ? "exact" : "approx",
      known ? undefined : "sourceResolutionUnknown"),
  };
}

/** Forme Resolve historique → transform canonique, tout en gardant `xf` pour le pipeline AE actuel. */
function videoFromResolveXf(xf, dims) {
  if (!xf) return undefined;
  const src = source("resolve", "TimelineItem.GetProperty");
  return {
    transform: {
      position: { value: { x: num(xf.pan, 0), y: -num(xf.tilt, 0) }, source: src },
      scale: { value: { x: num(xf.zoomX, 1), y: num(xf.zoomY, 1) }, source: src },
      anchor: resolveAnchor(xf, dims),
      rotation: { value: num(xf.rot, 0), source: src },
      opacity: { value: num(xf.opacity, 100), source: src },
      flipX: { value: !!xf.flipX, source: src },
      flipY: { value: !!xf.flipY, source: src },
      crop: {
        left: { value: num(xf.cropL, 0), source: src },
        right: { value: num(xf.cropR, 0), source: src },
        top: { value: num(xf.cropT, 0), source: src },
        bottom: { value: num(xf.cropB, 0), source: src },
      },
    },
  };
}

/** Compatibilité documents v1 et formes partielles venant d'un panneau plus ancien. */
function upgradeTransferClip(clip, host, timelineFps) {
  const kind = clip.kind === "audio" ? "audio" : "video";
  const upgraded = {
    ...clip,
    kind,
    track: Math.max(1, num(clip.track, 1)),
    path: String(clip.path || ""),
    name: String(clip.name || ""),
    fps: num(clip.fps, timelineFps) || timelineFps,
    srcFrames: Math.max(0, num(clip.srcFrames, 0)),
    srcIn: num(clip.srcIn, 0),
    srcOut: num(clip.srcOut, 0),
    tlStart: num(clip.tlStart, 0),
    tlEnd: num(clip.tlEnd, 0),
    identity: { sourceHost: host, ...(clip.identity || {}) },
  };
  if (kind === "video" && !upgraded.video && clip.xf) {
    upgraded.video = videoFromResolveXf(clip.xf, { width: clip.srcWidth, height: clip.srcHeight });
  }
  if (!upgraded.timing) upgraded.timing = timingFor(upgraded, timelineFps, {
    reverse: clip.reverse,
    freeze: clip.freeze,
    source: source(host, "legacy-derived", "derived"),
  });
  return upgraded;
}

/** @param {import('./types').TransferDoc} doc */
function upgradeTransferDoc(doc) {
  const fps = num(doc.fps, 24) || 24;
  return {
    ...doc,
    version: TRANSFER_VERSION,
    fps,
    fpsRational: doc.fpsRational || frameRateRational(fps),
    clips: (doc.clips || []).map((clip) => upgradeTransferClip(clip, doc.host, fps)),
    missing: [...(doc.missing || [])],
    mediaLess: [...(doc.mediaLess || [])],
    deferred: [...(doc.deferred || [])],
  };
}

/** Plans d'une timeline Resolve (sortie de `readTimelineEdit`) → document neutre. */
function docFromResolveEdit(edit) {
  const fps = num(edit.fps, 24);
  /** @type {import('./types').TransferClip[]} */
  const clips = [];
  for (const item of edit.items || []) {
    if (!item || !item.path) continue;
    /** @type {import('./types').TransferClip} */
    const clip = {
      kind: item.kind === "audio" ? "audio" : "video",
      track: Math.max(1, num(item.track, 1)),
      path: item.path,
      name: item.name || "",
      fps: num(item.fpsClip, fps),
      srcFrames: num(item.srcFrames, 0),
      srcWidth: num(item.srcWidth, 0) || undefined,
      srcHeight: num(item.srcHeight, 0) || undefined,
      srcIn: num(item.srcIn, 0),
      srcOut: num(item.srcOut, 0),
      tlStart: num(item.tlStart, 0),
      tlEnd: num(item.tlEnd, 0),
      identity: { sourceHost: "resolve" },
      xf: item.xf || null,
      video: item.kind === "audio" ? undefined : videoFromResolveXf(item.xf, {
        width: item.srcWidth, height: item.srcHeight,
        timelineWidth: num(edit.width, 1920), timelineHeight: num(edit.height, 1080),
      }),
      timing: timingFor(item, fps, {
        reverse: item.reverse,
        freeze: item.freeze,
        source: source("resolve", "GetSourceStartFrame/GetSourceEndFrame", "exact"),
      }),
    };
    clips.push(clip);
  }
  return upgradeTransferDoc({
    ok: true,
    version: TRANSFER_VERSION,
    host: "resolve",
    timeline: edit.timeline || "",
    fps,
    fpsRational: frameRateRational(fps),
    width: num(edit.width, 1920),
    height: num(edit.height, 1080),
    startFrame: num(edit.startFrame, 0),
    endFrame: num(edit.endFrame, 0),
    clips,
    missing: [...(edit.missing || [])],
    // Titres et générateurs Fusion : sans média par nature, donc jamais des sources « introuvables ».
    // Leur contenu, lui, arrive par l'export XML (cf. readResolve).
    mediaLess: [...(edit.generators || [])],
  });
}

/**
 * Cadences hors desquelles une valeur n'est pas une cadence. Premiere rend un `frameRate` aberrant
 * sur un élément audio seul (mesuré 2,754e-8) : propagée, cette valeur ramenait toute conversion en
 * frames à zéro, donc des plans d'UNE frame que Resolve refuse de poser. Une cadence
 * invraisemblable retombe sur celle de la séquence, jamais sur elle-même.
 */
const FPS_MIN = 1;
const FPS_MAX = 1000;

function plausibleFps(value, fallback) {
  const rate = num(value, 0);
  return rate >= FPS_MIN && rate <= FPS_MAX ? rate : fallback;
}

// Les frames viennent de l'hôte quand il les a calculées depuis ses ticks (Premiere). Le repli
// secondes×fps ne sert qu'aux snapshots émis par un panneau antérieur à ces champs.
function sourceInFrame(clip, fps) {
  if (isNum(clip.srcInFrame)) return clip.srcInFrame;
  return fps > 0 && isNum(clip.srcIn) ? Math.round(clip.srcIn * fps) : 0;
}
/** Borne de sortie SOURCE lue chez l'hôte, inclusive. `null` = l'hôte ne la rend pas. */
function knownSourceOutFrame(clip, fps, inFrame) {
  const raw = isNum(clip.srcOutFrame) ? clip.srcOutFrame
    : (fps > 0 && isNum(clip.srcOut) ? Math.round(clip.srcOut * fps) - 1 : null);
  // Une borne de sortie SOUS l'entrée n'est pas une borne : l'hôte n'a rien su rendre.
  return raw === null || raw < inFrame ? null : raw;
}

/**
 * Borne de sortie déduite de l'OCCUPATION du plan sur la timeline, ramenée dans la base de la
 * source. Écraser la sortie sur l'entrée produisait un plan d'UNE frame, que `AppendToTimeline`
 * refuse en silence — c'est ce qui faisait disparaître les plans audio dont Premiere ne sait pas
 * rendre les bornes.
 */
function derivedSourceOutFrame(inFrame, timelineSpan, fps, sequenceFps) {
  const ratio = sequenceFps > 0 && fps > 0 ? fps / sequenceFps : 1;
  return inFrame + Math.max(1, Math.round(num(timelineSpan, 0) * ratio)) - 1;
}
function timelineStartFrame(clip, sequenceFps) {
  if (isNum(clip.tlStartFrame)) return clip.tlStartFrame;
  return sequenceFps > 0 && isNum(clip.tlStart) ? Math.round(clip.tlStart * sequenceFps) : 0;
}
function timelineEndFrame(clip, sequenceFps, srcSpan, srcFps, startFrame) {
  if (isNum(clip.tlEndFrame)) return clip.tlEndFrame;
  if (sequenceFps > 0 && isNum(clip.tlEnd)) return Math.round(clip.tlEnd * sequenceFps);
  const ratio = srcFps > 0 && sequenceFps > 0 ? sequenceFps / srcFps : 1;
  return startFrame + Math.max(1, Math.round(srcSpan * ratio));
}

function adobeVideo(clip) {
  if (clip.video) return clip.video;
  if (!clip.transform && !clip.opacity) return undefined;
  return { transform: { ...(clip.transform || {}), ...(clip.opacity ? { opacity: clip.opacity } : {}) } };
}

/**
 * Le texte lu ressemble-t-il à un titre ? Sur un titre NATIF de Premiere, `getValue()` du paramètre
 * « Texte source » ne rend pas la chaîne saisie mais une valeur opaque — mesuré : un unique `ļ`
 * pour un titre qui portait une phrase. Poser ce caractère chez la cible fabrique un titre FAUX
 * là où l'utilisateur en attendait un vrai : mieux vaut n'en poser aucun et le dire.
 */
function plausibleTitle(value) {
  const text = String(value || "").trim();
  if (text.length < 2) return false;
  // Une valeur opaque n'a ni lettre ni chiffre, ou porte des caractères de contrôle.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Élément sans média → titre du document, quand l'hôte a su en lire le texte. Sans texte il n'y a
 * rien à recréer : le rendre en titre vide poserait un cadre noir là où l'utilisateur attend le sien.
 * @returns {import('./types').TransferGraphic | null}
 */
function graphicFrom(clip, kind, track, sequenceFps) {
  const graphic = clip.graphic;
  if (kind !== "video" || !graphic || !plausibleTitle(graphic.text)) return null;
  const tlStart = timelineStartFrame(clip, sequenceFps);
  const tlEnd = isNum(clip.tlEndFrame) ? clip.tlEndFrame
    : (sequenceFps > 0 && isNum(clip.tlEnd) ? Math.round(clip.tlEnd * sequenceFps) : tlStart + 1);
  return {
    track,
    name: clip.name || "",
    tlStart,
    tlEnd: Math.max(tlStart + 1, tlEnd),
    text: String(graphic.text),
    font: graphic.font ? String(graphic.font) : undefined,
    size: num(graphic.size, 0) || undefined,
    color: graphic.color || undefined,
    transform: (clip.video && clip.video.transform) || undefined,
  };
}

/** Séquence Premiere / composition After Effects d'un snapshot CEP → document. */
function docFromAdobeSequence(snap, name) {
  if (!snap || !Array.isArray(snap.sequences)) {
    /** @type {import('./types').TransferFailure} */
    const failure = { ok: false, error: "snapshotMissing" };
    return failure;
  }
  const wanted = name || snap.activeSequence || "";
  const sequence = snap.sequences.find((s) => s && s.name === wanted)
    || (wanted ? null : snap.sequences[0]);
  if (!sequence) {
    /** @type {import('./types').TransferFailure} */
    const failure = { ok: false, error: "timelineMissing" };
    return failure;
  }

  const sequenceFps = num(sequence.fps, 0) || 25;
  /** @type {import('./types').TransferClip[]} */
  const clips = [];
  // Un titre, un cache de couleur ou un calque d'effet n'a AUCUN fichier : ce n'est pas une source
  // « introuvable » (qui, elle, désigne un fichier absent du disque), c'est un élément qu'aucun
  // transfert ne peut porter. Les confondre faisait lire « source introuvable » sur un projet sain.
  /** @type {string[]} */
  const mediaLess = [];
  /** @type {import('./types').TransferGraphic[]} */
  const graphics = [];
  for (const track of sequence.tracks || []) {
    const kind = track && track.kind === "audio" ? "audio" : "video";
    const index = Math.max(1, num(track && track.index, 1));
    for (const clip of (track && track.clips) || []) {
      if (!clip) continue;
      if (!clip.path) {
        // Un titre n'est pas un plan : il n'a ni fichier ni bornes source, donc rien à faire dans
        // `clips`, que tous les écrivains lisent comme des références média. Il porte en revanche
        // un texte et un style, que l'hôte cible sait recréer — d'où une liste à part.
        const graphic = graphicFrom(clip, kind, index, sequenceFps);
        if (graphic) graphics.push(graphic);
        // Le relevé de l'hôte accompagne le nom : « Image » ne dit pas si c'est un titre dont on
        // n'a pas su lire le texte ou un cache de couleur, qui n'a rien à transporter.
        else mediaLess.push(clip.graphicProbe
          ? `${clip.name || "plan"} ${JSON.stringify(clip.graphicProbe)}`
          : (clip.name || "plan"));
        continue;
      }
      const fps = plausibleFps(clip.srcFps, sequenceFps);
      const srcIn = sourceInFrame(clip, fps);
      // Les deux bornes se déduisent l'une de l'autre quand l'hôte en tait une : la source donne
      // l'occupation timeline, l'occupation timeline donne la source. Une seule des deux peut
      // manquer sans casser le plan — l'ordre ci-dessous garde chaque déduction dans ce sens-là.
      const knownOut = knownSourceOutFrame(clip, fps, srcIn);
      const tlStart = timelineStartFrame(clip, sequenceFps);
      const tlEnd = timelineEndFrame(clip, sequenceFps, knownOut === null ? 1 : knownOut - srcIn + 1, fps, tlStart);
      const srcOut = knownOut === null ? derivedSourceOutFrame(srcIn, tlEnd - tlStart, fps, sequenceFps) : knownOut;
      /** @type {import('./types').TransferClip} */
      const base = {
        kind,
        track: index,
        path: clip.path,
        name: clip.name || "",
        fps,
        srcFrames: num(clip.srcFrames, 0),
        srcWidth: num(clip.srcWidth, 0) || undefined,
        srcHeight: num(clip.srcHeight, 0) || undefined,
        srcIn,
        srcOut,
        tlStart,
        tlEnd,
        identity: { nativeId: clip.nodeId ? String(clip.nodeId) : undefined, sourceHost: snap.app },
        hostTicks: clip.ticks,
        video: kind === "video" ? adobeVideo(clip) : undefined,
        audio: clip.audio,
        trimExactness: clip.direct === false ? "approx" : "exact",
        timing: clip.timing || timingFor({ fps, srcIn, srcOut, tlStart, tlEnd }, sequenceFps, {
          reverse: clip.reverse,
          freeze: clip.freeze,
          source: source(snap.app, "TrackItem timing", clip.speed == null ? "derived" : "exact"),
        }),
        deferred: clip.deferred,
      };
      clips.push(base);
    }
  }
  return upgradeTransferDoc({
    ok: true,
    version: TRANSFER_VERSION,
    host: snap.app === "aeft" ? "aeft" : "ppro",
    timeline: sequence.name,
    fps: sequenceFps,
    fpsRational: frameRateRational(sequenceFps),
    width: num(sequence.w, 1920),
    height: num(sequence.h, 1080),
    startFrame: 0,
    endFrame: 0,
    clips,
    missing: [],
    mediaLess,
    graphics,
  });
}

function animated(property) {
  return !!(property && Array.isArray(property.keyframes) && property.keyframes.length);
}

function audioHasMix(audio) {
  if (!audio) return false;
  const gain = valueOf(audio.gainDb, 0);
  const volume = valueOf(audio.volume, 1);
  const pan = valueOf(audio.pan, 0);
  const mute = valueOf(audio.mute, false);
  return Math.abs(num(gain, 0)) > 1e-6 || Math.abs(num(volume, 1) - 1) > 1e-6
    || Math.abs(num(pan, 0)) > 1e-6 || mute === true
    || [audio.gainDb, audio.volume, audio.pan, audio.mute].some(animated);
}

/** Écarte uniquement les doublons AUDIO exacts ; la vidéo est posée sans son par les writers. */
function dedupLinkedAudio(clips) {
  const seen = new Set();
  return clips.filter((clip) => {
    if (clip.kind !== "audio") return true;
    const key = `${clip.track}|${clip.path}|${clip.srcIn}|${clip.srcOut}|${clip.tlStart}|${clip.tlEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Ordre de lecture : vidéo d'abord, puis par piste, puis chronologique. */
function compareClips(a, b) {
  const rank = (c) => (c.kind === "video" ? 0 : 1);
  return (rank(a) - rank(b)) || (a.track - b.track) || (a.tlStart - b.tlStart);
}

function clampClip(clip, startFrame) {
  const srcIn = Math.max(0, Math.round(clip.srcIn));
  let srcOut = Math.max(srcIn, Math.round(clip.srcOut));
  if (clip.srcFrames > 0) srcOut = Math.min(srcOut, clip.srcFrames - 1);
  return {
    ...clip,
    srcIn: Math.min(srcIn, srcOut),
    srcOut,
    tlStart: Math.max(0, Math.round(clip.tlStart) - startFrame),
    tlEnd: Math.max(0, Math.round(clip.tlEnd) - startFrame),
  };
}

/** Remet le document dans sa forme canonique. */
function normalizeDoc(input) {
  const doc = upgradeTransferDoc(input);
  const startFrame = num(doc.startFrame, 0);
  const clips = dedupLinkedAudio(
    doc.clips.filter((c) => c && c.path)
      .map((c) => clampClip(c, startFrame))
      .filter((c) => c.tlEnd > c.tlStart),
  ).sort(compareClips);
  // Les titres se rebasent avec les plans : laissés sur l'horloge d'origine, ils atterriraient une
  // heure plus loin sur une timeline qui démarre à 01:00:00:00.
  const graphics = (doc.graphics || [])
    .map((g) => ({ ...g, tlStart: Math.max(0, g.tlStart - startFrame), tlEnd: Math.max(1, g.tlEnd - startFrame) }))
    .filter((g) => g.tlEnd > g.tlStart)
    .sort((a, b) => a.tlStart - b.tlStart || a.track - b.track);
  const endFrame = clips.reduce(
    (max, c) => Math.max(max, c.tlEnd),
    graphics.reduce((max, g) => Math.max(max, g.tlEnd), Math.max(0, num(doc.endFrame, 0) - startFrame)),
  );
  return { ...doc, startFrame: 0, endFrame, clips, graphics };
}

function propertiesOf(clip) {
  const transform = clip.video && clip.video.transform;
  const audio = clip.audio;
  return [
    transform && transform.position, transform && transform.scale, transform && transform.anchor,
    transform && transform.rotation, transform && transform.opacity,
    audio && audio.gainDb, audio && audio.volume, audio && audio.pan, audio && audio.mute,
  ].filter(Boolean);
}

function transformIsIdentity(clip) {
  const tr = clip.video && clip.video.transform;
  if (!tr) return true;
  const point = (p, x, y) => {
    const v = valueOf(p, { x, y });
    return Math.abs(num(v && v.x, x) - x) < 1e-6 && Math.abs(num(v && v.y, y) - y) < 1e-6;
  };
  // L'ancrage neutre est le CENTRE de la source, pas l'origine. Sans dimensions connues, il ne peut
  // pas être jugé : on ne le compte alors pas comme une transformation.
  const anchorNeutral = !tr.anchor || !clip.srcWidth || !clip.srcHeight
    || point(tr.anchor, clip.srcWidth / 2, clip.srcHeight / 2);
  return point(tr.position, 0, 0) && point(tr.scale, 1, 1) && anchorNeutral
    && Math.abs(num(valueOf(tr.rotation, 0), 0)) < 1e-6
    && Math.abs(num(valueOf(tr.opacity, 100), 100) - 100) < 1e-6
    && !valueOf(tr.flipX, false) && !valueOf(tr.flipY, false);
}

/** Chiffres de l'aperçu affiché AVANT le montage. */
function docSummary(doc) {
  const video = doc.clips.filter((c) => c.kind === "video");
  const audio = doc.clips.filter((c) => c.kind === "audio");
  const trackCount = (list) => new Set(list.map((c) => c.track)).size;
  return {
    clips: doc.clips.length,
    video: video.length,
    audio: audio.length,
    videoTracks: trackCount(video),
    audioTracks: trackCount(audio),
    durationFrames: doc.endFrame,
    missing: doc.missing.length,
    mediaLess: doc.mediaLess ? doc.mediaLess.length : 0,
    graphics: doc.graphics ? doc.graphics.length : 0,
    animated: doc.clips.filter((c) => propertiesOf(c).some(animated) || !!(c.timing && c.timing.timeMap && c.timing.timeMap.length)).length,
    transformed: video.filter((c) => !transformIsIdentity(c)).length,
    mixedAudio: audio.filter((c) => audioHasMix(c.audio)).length,
    retimed: doc.clips.filter((c) => c.timing && (c.timing.freeze || c.timing.reverse
      || c.timing.speed.numerator !== c.timing.speed.denominator)).length,
  };
}

/** Pose d'un plan dans Resolve. `endFrame` reste INCLUSIF. */
function resolvePlacement(clip, timelineStart) {
  return {
    startFrame: clip.srcIn,
    endFrame: clip.srcOut,
    recordFrame: timelineStart + clip.tlStart,
    trackIndex: clip.track,
    mediaType: clip.kind === "audio" ? MEDIA_TYPE_AUDIO : MEDIA_TYPE_VIDEO,
  };
}

/** Nombre de pistes à garantir sur la cible, par type. */
function trackCounts(doc) {
  const max = (kind) => doc.clips.reduce((m, c) => (c.kind === kind ? Math.max(m, c.track) : m), 0);
  return { video: max("video"), audio: max("audio") };
}

module.exports = {
  MEDIA_TYPE_VIDEO, MEDIA_TYPE_AUDIO, TRANSFER_VERSION,
  frameRateRational, timingFor, videoFromResolveXf, upgradeTransferDoc,
  docFromResolveEdit, docFromAdobeSequence, dedupLinkedAudio,
  normalizeDoc, docSummary, resolvePlacement, trackCounts,
};
