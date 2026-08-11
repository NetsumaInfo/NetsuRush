// @ts-check
// Lecture de la timeline Resolve pour l'export AE : parcours des pistes, fenêtres source frame-accurate,
// timelines imbriquées (render / comp / flatten), transforms. Produit { items, groups, fps, dims… }.

const { renderRange } = require('../aeRender');
const { readTimelineXml } = require('../transfer/resolveXml');
const { graftAnimation } = require('./animation');
const { sanitizeName: sanitize } = require('../utils');
const { t } = require('../i18n');

// "HH:MM:SS:FF" (ou ";FF" drop) → frames. Le TC tourne au fps NOMINAL (round : 24 pour 23.976).
function tcToFrames(tc, fps) {
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(tc || '').trim());
  if (!m) return 0;
  const rate = Math.max(1, Math.round(fps));
  return ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * rate) + (+m[4]);
}

// Start TC du média en frames (souvent 01:00:00:00 = 86400 sur les rushs anime). Les frames source de
// Resolve sont ANCRÉES dessus → il faut le retrancher pour un index 0-based depuis le début du fichier.
async function mediaStartTcFrames(mpi, fps) {
  try { return tcToFrames(await mpi.GetClipProperty('Start TC'), fps); } catch (_) { return 0; }
}

// In/out SOURCE d'un plan, en frames 0-based depuis le DÉBUT DU FICHIER (ce que ffmpeg -ss attend).
// PRIMAIRE = GetSourceStartFrame/GetSourceEndFrame (officiels Resolve 19.0.2+) : 0-based fiables, et ils
// encodent le retime — `ssf == sef` = FREEZE (1 frame tenue), `ssf > sef` = REVERSE.
//
// `sef` est INCLUSIF. Mesuré sur Resolve Studio 21.0.3, sur des plans posés ENTIERS et non rognés :
// un fichier de 96 images occupant 96 images de timeline rend `ssf=0, sef=95`. Le lire comme exclusif
// coûtait la DERNIÈRE IMAGE de chaque plan et inventait une vitesse de 95/96 sur un plan qui n'est pas
// retimé — assez pour noyer les vraies accélérations dans un bruit de fond de faux retimes.
// GetLeftOffset est en fallback seulement (il dérive — décalé de plusieurs frames — et renvoie un
// timecode garbage, ex 86400, sur les freeze).
// Renvoie { srcIn, srcOut (inclusifs), freeze, reverse, srcSpan, retimed }.
async function sourceRange(it, tlStart, tlEnd, tcFrames = 0, maxFrame = Infinity) {
  const span = Math.max(1, tlEnd - tlStart);
  const rd = async (k) => { try { const v = parseInt(await it[k](), 10); return Number.isFinite(v) ? v : NaN; } catch (_) { return NaN; } };
  // Dé-ancrage TC uniquement si la valeur dépasse la longueur du fichier (normalement déjà 0-based).
  const deTc = (v) => (tcFrames > 0 && Number.isFinite(maxFrame) && v > maxFrame) ? v - tcFrames : v;
  let ssf = deTc(await rd('GetSourceStartFrame'));
  let sef = deTc(await rd('GetSourceEndFrame'));
  if (Number.isFinite(ssf) && Number.isFinite(sef) && ssf >= 0 && sef >= 0) {
    let srcIn, srcOut, reverse = false, freeze = false;
    if (ssf === sef) { srcIn = srcOut = ssf; freeze = true; }             // freeze : 1 frame tenue
    else if (ssf > sef) { srcIn = sef; srcOut = ssf; reverse = true; }    // reverse : plage [sef, ssf]
    else { srcIn = ssf; srcOut = sef; }                                   // forward : plage [ssf, sef]
    if (Number.isFinite(maxFrame)) {
      srcIn = Math.max(0, Math.min(srcIn, maxFrame));
      srcOut = Math.max(srcIn, Math.min(srcOut, maxFrame));
    }
    const srcSpan = srcOut - srcIn + 1;
    return { srcIn, srcOut, reverse, freeze, srcSpan, retimed: !freeze && srcSpan !== span };
  }
  // Fallback : GetLeftOffset (ancré TC) + durée = longueur de l'item sur la timeline.
  let lo = await rd('GetLeftOffset');
  if (!Number.isFinite(lo) || lo < 0) lo = 0;
  let srcIn = (tcFrames > 0 && lo >= tcFrames) ? lo - tcFrames : lo;
  let srcOut = srcIn + span - 1;
  if (Number.isFinite(maxFrame)) { srcIn = Math.min(srcIn, maxFrame); srcOut = Math.min(srcOut, maxFrame); }
  return { srcIn, srcOut, reverse: false, freeze: false, srcSpan: span, retimed: false };
}

// Transform Resolve d'un plan (échelle/position/rotation/anchor/opacité/crop/flip). Valeurs brutes,
// mappées côté AE. Renvoie null si l'API n'expose rien (identité).
async function readTransform(it) {
  const g = async (k, d) => {
    try { const v = parseFloat(await it.GetProperty(k)); return Number.isFinite(v) ? v : d; }
    catch (_) { return d; }
  };
  // FlipX/FlipY sont des booléens → parseFloat(true) = NaN. Lire la valeur brute.
  const gb = async (k) => {
    try { const v = await it.GetProperty(k); return (v === true || v === 1 || v === '1') ? 1 : 0; }
    catch (_) { return 0; }
  };
  try {
    return {
      zoomX: await g('ZoomX', 1), zoomY: await g('ZoomY', 1),
      pan: await g('Pan', 0), tilt: await g('Tilt', 0),
      rot: await g('RotationAngle', 0),
      anchorX: await g('AnchorPointX', 0), anchorY: await g('AnchorPointY', 0),
      opacity: await g('Opacity', 100),
      cropL: await g('CropLeft', 0), cropR: await g('CropRight', 0),
      cropT: await g('CropTop', 0), cropB: await g('CropBottom', 0),
      flipX: await gb('FlipX'), flipY: await gb('FlipY'),
    };
  } catch (_) { return null; }
}

/**
 * Un plan RENDU par Resolve (cuisson d'un cadrage animé) devient un média final : le fichier porte
 * déjà le cadrage, la vitesse et les images clés, à la cadence et à la taille de la timeline. Il ne
 * doit donc plus rien traverser — ni remux, ni réencode, ni transform reposé sur le calque, ni
 * time-remap : chacun de ces traitements appliquerait une seconde fois ce qui est déjà dans l'image.
 * Ses bornes source repartent de zéro : la longueur du rush d'origine ne s'applique plus.
 */
function adoptRenderedClip(clip, file, fps) {
  clip.path = file;
  clip.rendered = true;
  clip.xf = null;
  delete clip.anim;
  clip.fpsClip = fps;
  clip.srcFrames = 0;
  clip.srcIn = 0;
  clip.srcOut = clip.tlEnd - clip.tlStart - 1;
  clip.freeze = false;
  clip.reverse = false;
  clip.retimed = false;
  return clip;
}

async function safeName(it) { try { return await it.GetName(); } catch (_) { return ''; } }

// Dimensions de la SOURCE ("1920x1080"). Le point d'ancrage s'y rapporte : sans elles, il n'y a
// aucun moyen de traduire l'ancrage Resolve (décalage depuis le centre) vers Premiere et After
// Effects, qui le comptent en pixels source depuis le coin haut-gauche.
async function mediaResolution(mpi) {
  try {
    const raw = String(await mpi.GetClipProperty('Resolution') || '');
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw.trim());
    if (!m) return null;
    return { width: +m[1], height: +m[2] };
  } catch (_) { return null; }
}

/**
 * Lit la timeline (ou la timeline courante) et produit les plans + précompos prêts à mapper en AE.
 * @returns {Promise<import('./types').EditResult>}
 */
async function readTimelineEdit(resolve, timelineName, renderOpts = {}) {
  const {
    nestedMode, outDir, codec, audio, audioRenderFmt, event, includeLinkedAudio, animation, bakeTransforms,
  } = renderOpts;
  const pm = await resolve.GetProjectManager();
  const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t('noProject') };

  let tl = null;
  if (timelineName) {
    const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
    for (let i = 1; i <= count && !tl; i++) {
      const t = await proj.GetTimelineByIndex(i);
      if (t && (await t.GetName()) === timelineName) tl = t;
    }
  }
  if (!tl) tl = await proj.GetCurrentTimeline();
  if (!tl) return { ok: false, error: t('noTimeline') };

  const fps = parseFloat(await tl.GetSetting('timelineFrameRate')) || 24;
  const width = parseInt(await tl.GetSetting('timelineResolutionWidth'), 10) || 1920;
  const height = parseInt(await tl.GetSetting('timelineResolutionHeight'), 10) || 1080;
  let startFrame = 0;
  let endFrame = 0;
  try { startFrame = parseInt(await tl.GetStartFrame(), 10) || 0; } catch (_) {}
  try { endFrame = parseInt(await tl.GetEndFrame(), 10) || 0; } catch (_) {}

  /** @type {import('./types').ClipItem[]} */
  const items = [];
  /** @type {string[]} */
  const missing = [];
  // Éléments SANS média par nature (titres Fusion, générateurs) : tenus à part des sources absentes.
  const generators = [];
  /** @type {import('./types').Group[]} */
  const groups = [];   // timelines imbriquées en mode 'comp' (chacune → précompo AE dédiée)

  // Rend [markIn, markOut] (markOut inclusif) d'une timeline en un fichier unique via Resolve.
  // Restaure la timeline courante après usage (renderRange la change). Renvoie le chemin ou null.
  const origTl = await proj.GetCurrentTimeline();
  let renderErr = null;
  async function doRender(timelineObj, markIn, markOut, name, audioOnly) {
    if (!outDir) throw new Error(t('chooseOutputFolder'));
    const cn = (sanitize(name).replace(/[^\x20-\x7E]+/g, '_').replace(/\s+/g, '_') || 'render') + `_${markIn}_${markOut}`;
    const onStatus = event && event.sender
      ? (st) => event.sender.send('ae:progress', { phase: 'Rendu Resolve', done: 0, total: 0, pct: (st && st.CompletionPercentage) || 0 })
      : null;
    return renderRange(proj, { timeline: timelineObj, markIn, markOut, outDir,
      customName: cn, codec, exportAudio: audio !== 'none', audioOnly, audioFmt: audioRenderFmt || 'wav', onStatus });
  }

  /**
   * Rend la plage d'UN plan par Resolve, cadrage et images clés compris. Les autres pistes vidéo
   * sont coupées le temps du rendu : sans ça, le rendu d'une plage rend la COMPOSITION de toute la
   * pile, et un plan de V1 se retrouverait cuit dans le fichier d'un plan de V2. L'état des pistes
   * est restauré quoi qu'il arrive — le projet de l'utilisateur n'a pas à garder la trace du passage.
   * Le son n'est pas exporté : celui de la plage est un MÉLANGE, pas l'audio de ce plan ; il reste
   * porté par les pistes audio lues à part.
   */
  async function renderClipRange(clip) {
    const count = parseInt(await tl.GetTrackCount('video'), 10) || 0;
    const enabled = [];
    for (let i = 1; i <= count; i++) {
      try { enabled.push(!!(await tl.GetIsTrackEnabled('video', i))); } catch (_) { enabled.push(true); }
    }
    try {
      for (let i = 1; i <= count; i++) {
        if (i !== clip.track) { try { await tl.SetTrackEnable('video', i, false); } catch (_) {} }
      }
      const name = `${sanitize(clip.name || 'plan')}_bake`;
      const cn = (name.replace(/[^\x20-\x7E]+/g, '_').replace(/\s+/g, '_') || 'bake') + `_${clip.tlStart}`;
      const onStatus = event && event.sender
        ? (st) => event.sender.send('ae:progress', { phase: 'Cuisson Resolve', done: 0, total: 0, pct: (st && st.CompletionPercentage) || 0 })
        : null;
      return await renderRange(proj, { timeline: tl, markIn: clip.tlStart, markOut: clip.tlEnd - 1,
        outDir, customName: cn, codec, exportAudio: false, onStatus });
    } catch (e) {
      // Un rendu refusé ne coûte que la cuisson : le cadrage repart sur le calque AE, et on le dit.
      console.warn(`[ae] cuisson Resolve impossible pour ${clip.name || clip.path} :`, e && e.message);
      return null;
    } finally {
      for (let i = 1; i <= count; i++) {
        try { await tl.SetTrackEnable('video', i, enabled[i - 1]); } catch (_) {}
      }
    }
  }

  // La timeline a-t-elle au moins un plan vidéo ? (sinon = timeline audio seule → rendu audio).
  async function timelineHasVideo(t) {
    const vc = parseInt(await t.GetTrackCount('video'), 10) || 0;
    for (let i = 1; i <= vc; i++) {
      const list = (await t.GetItemListInTrack('video', i)) || [];
      if (list.length) return true;
    }
    return false;
  }

  async function findTimelineByName(name) {
    const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
    for (let i = 1; i <= count; i++) {
      const t = await proj.GetTimelineByIndex(i);
      if (t && (await t.GetName()) === name) return t;
    }
    return null;
  }

  // Lit la fenêtre source d'un plan de timeline imbriquée (frames de la timeline imbriquée).
  async function nestedWindow(it, sub) {
    const subStart = parseInt(await sub.GetStartFrame(), 10) || 0;
    let pSrcIn = parseInt(await it.GetSourceStartFrame(), 10);
    if (!Number.isFinite(pSrcIn)) { try { pSrcIn = parseInt(await it.GetLeftOffset(), 10); } catch (_) {} }
    if (!Number.isFinite(pSrcIn)) pSrcIn = 0;
    const winStart = pSrcIn >= subStart ? pSrcIn : subStart + pSrcIn;
    return { subStart, winStart };
  }

  // Parcourt une timeline. `place` (imbriqué/aplati) reprojette+clampe les frames vers la timeline
  // parente : { winStart, winEnd } = fenêtre visible (frames timeline imbriquée), `parentStart` =
  // frame parente où tombe winStart. `group` = id de précompo (mode 'comp') → frames gardées telles
  // quelles (temps de la timeline imbriquée), placement géré par le calque de précompo dans le parent.
  // skipPaths : ignore l'audio déjà présent sur une piste vidéo (audio lié → doublon).
  async function collect(srcTl, type, skipPaths, depth, place, group) {
    const count = parseInt(await srcTl.GetTrackCount(type), 10) || 0;
    for (let t = 1; t <= count; t++) {
      const list = (await srcTl.GetItemListInTrack(type, t)) || [];
      for (const it of list) {
        try {
          let tlS = parseInt(await it.GetStart(), 10) || 0;
          let tlE = parseInt(await it.GetEnd(), 10) || tlS;
          let headCut = 0;
          if (place) {
            const ovS = Math.max(tlS, place.winStart);
            const ovE = Math.min(tlE, place.winEnd);
            if (ovE <= ovS) continue;                 // hors fenêtre visible du plan parent
            headCut = ovS - tlS;
            tlS = place.parentStart + (ovS - place.winStart);
            tlE = place.parentStart + (ovE - place.winStart);
          }
          const mpi = await it.GetMediaPoolItem();
          const fp = mpi ? await mpi.GetClipProperty('File Path') : null;

          // Pas de fichier mais nom = une timeline ⇒ timeline imbriquée.
          if (mpi && !fp) {
            const nm = await safeName(it);
            const sub = depth < 2 ? await findTimelineByName(nm) : null;
            if (sub && nm !== (await srcTl.GetName())) {
              const { subStart, winStart } = await nestedWindow(it, sub);
              // Mode 'render' (1er niveau). Timeline imbriquée rendue EN ENTIER par Resolve en 1 fichier
              // (vidéo OU audio seule), au format choisi. Fallback : aplatir ses plans si le rendu échoue.
              if (nestedMode === 'render' && !group && !place) {
                const len = tlE - tlS;
                const hasVid = await timelineHasVideo(sub);
                let file = null;
                try { file = await doRender(sub, winStart, winStart + len - 1, nm, !hasVid); } catch (_) {}
                if (file) {
                  const subFps = parseFloat(await sub.GetSetting('timelineFrameRate')) || fps;
                  items.push({ kind: hasVid ? 'video' : 'audio', track: t, path: file, name: nm,
                    fpsClip: hasVid ? subFps : fps, srcFrames: 0, srcIn: 0, srcOut: len - 1,
                    tlStart: tlS, tlEnd: tlE, xf: null, rendered: true });
                } else if (hasVid) {
                  renderErr = renderErr || 'Rendu Resolve échoué'; missing.push(nm + ' (rendu KO)');
                } else {
                  // Rendu audio Resolve KO → fallback : aplatir les plans audio (conversion ffmpeg fiable).
                  const place2 = { winStart, winEnd: winStart + len, parentStart: tlS };
                  const before = items.length;
                  await collect(sub, 'audio', null, depth + 1, place2, group);
                  for (let k = before; k < items.length; k++) items[k].aFmt = audioRenderFmt || 'wav';
                }
                continue;
              }
              // Mode 'comp' (au 1er niveau seulement) : la timeline imbriquée devient une précompo.
              if (nestedMode === 'comp' && !group && !place) {
                const gid = `g${groups.length + 1}`;
                const gFps = parseFloat(await sub.GetSetting('timelineFrameRate')) || fps;
                const gW = parseInt(await sub.GetSetting('timelineResolutionWidth'), 10) || width;
                const gH = parseInt(await sub.GetSetting('timelineResolutionHeight'), 10) || height;
                groups.push({ id: gid, name: nm, w: gW, h: gH, fps: gFps,
                  nestedStart: subStart, winStart, parentTlStart: tlS, parentTlEnd: tlE });
                const before = items.length;
                await collect(sub, 'video', null, depth + 1, null, gid);
                const subVideoPaths = new Set(items.slice(before).map((c) => c.path));
                await collect(sub, 'audio', subVideoPaths, depth + 1, null, gid);
              } else {
                // Mode 'flatten' (ou imbriqué plus profond) : reprojection dans le parent.
                const place2 = { winStart, winEnd: winStart + (tlE - tlS), parentStart: tlS };
                const before = items.length;
                await collect(sub, type, null, depth + 1, place2, group);
                if (type === 'video') {
                  const subVideoPaths = new Set(items.slice(before).map((c) => c.path));
                  await collect(sub, 'audio', subVideoPaths, depth + 1, place2, group);
                }
              }
            } else missing.push(nm || 'plan');
            continue;
          }
          if (!mpi || !fp) {
            // AUCUN MediaPoolItem = titre Text+, générateur ou cache : l'élément n'a jamais eu de
            // média, ce n'est pas une source INTROUVABLE (là, l'item garde son MediaPoolItem et
            // c'est son chemin qui manque). Les confondre faisait lire « 1 source introuvable :
            // Texte » sur une timeline saine. `GetFusionCompCount()` ne sert à rien ici : mesuré à
            // 0 sur un Text+ posé, comme sur un plan ordinaire.
            const label = (await safeName(it)) || 'plan';
            if (!mpi) generators.push(label);
            else missing.push(label);
            continue;
          }
          if (skipPaths && skipPaths.has(fp)) continue;

          const fpsClip = type === 'video' ? (parseFloat(await mpi.GetClipProperty('FPS')) || fps) : fps;
          const srcFrames = parseInt(await mpi.GetClipProperty('Frames'), 10) || 0;
          const tcFrames = type === 'video' ? await mediaStartTcFrames(mpi, fpsClip) : 0;
          const maxFrame = srcFrames > 0 ? srcFrames - 1 : Infinity;
          const sr = await sourceRange(it, tlS, tlE, tcFrames, maxFrame);
          let { srcIn, srcOut } = sr;
          let freeze = sr.freeze, reverse = sr.reverse, retimed = sr.retimed;
          if (place) {   // segment d'une timeline imbriquée → reprojeté, pas de retime géré ici
            srcIn += headCut; srcOut = srcIn + (tlE - tlS) - 1; freeze = reverse = retimed = false;
          }
          const xf = type === 'video' ? await readTransform(it) : null;
          const dims = type === 'video' ? await mediaResolution(mpi) : null;
          const nm = await safeName(it);
          items.push({
            kind: type, track: t, path: fp, name: nm, fpsClip, srcFrames,
            srcWidth: dims ? dims.width : 0, srcHeight: dims ? dims.height : 0,
            srcIn, srcOut, tlStart: tlS, tlEnd: tlE, xf, nativeItem: it,
            group: group || undefined, freeze, reverse, retimed,
            nested: !!(place || group),   // issu d'une timeline imbriquée (pas de remux)
          });
        } catch (_) {}
      }
    }
  }
  await collect(tl, 'video', null, 0, null, null);

  // Images clés : l'API n'en lit aucune, l'export FCP7 XML de Resolve est la seule source. Il ne
  // construit rien — la structure reste celle lue ci-dessus, seules les courbes sont greffées.
  let animated = 0;
  if (animation) {
    try {
      const read = await readTimelineXml(resolve, tl);
      if (read.ok === true) animated = graftAnimation(read.doc, items).animated;
      else console.warn('[ae] images clés indisponibles :', read.reason);
    } catch (e) {
      console.warn('[ae] lecture des images clés impossible :', e && e.message);
    }
  }

  // Cuisson d'un cadrage ANIMÉ : ffmpeg n'a pas de transformation affine variable dans le temps,
  // Resolve rend au contraire le plan exactement tel qu'il l'affiche — images clés comprises. C'est
  // le même moteur que les timelines imbriquées. Réservé aux plans animés : un cadrage fixe reste
  // sur la voie ffmpeg, sans lancer un rendu Resolve par plan.
  const bakedByResolve = new Set();
  if (bakeTransforms && outDir) {
    for (const clip of items) {
      if (clip.kind !== 'video' || clip.group || clip.nested || clip.rendered || !clip.anim) continue;
      const file = await renderClipRange(clip);
      if (!file) continue;
      bakedByResolve.add(clip.path);
      adoptRenderedClip(clip, file, fps);
    }
  }

  const videoPaths = new Set();
  // Un plan rendu par Resolve sort SANS son : son audio lié doit donc rester une piste à part,
  // au lieu d'être écarté comme doublon de l'audio embarqué qu'il n'a plus.
  for (const item of items) if (!item.group && !bakedByResolve.has(item.path)) videoPaths.add(item.path);
  await collect(tl, 'audio', includeLinkedAudio ? null : videoPaths, 0, null, null);

  try { if (origTl) await proj.SetCurrentTimeline(origTl); } catch (_) {}
  if (renderErr && !items.length) return { ok: false, error: renderErr };

  const rank = (c) => c.kind === 'video' ? 0 : 1;
  items.sort((a, b) => (rank(a) - rank(b)) || (a.track - b.track) || (a.tlStart - b.tlStart));
  if (endFrame <= startFrame && items.length) {
    endFrame = items.reduce((m, c) => Math.max(m, c.tlEnd), startFrame);
  }
  return { ok: true, timeline: await tl.GetName(), fps, width, height, startFrame, endFrame, items, missing, generators, groups, animated };
}

// `sourceRange` est exporté pour être testé seul : c'est lui qui porte l'invariant de frame-math
// (bornes source inclusives), et le vérifier au travers d'un faux Resolve complet ne prouverait rien
// de plus tout en coûtant un simulacre d'API entier.
module.exports = { readTimelineEdit, sourceRange, adoptRenderedClip };
