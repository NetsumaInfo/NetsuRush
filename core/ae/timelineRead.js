// @ts-check
// Lecture de la timeline Resolve pour l'export AE : parcours des pistes, fenêtres source frame-accurate,
// timelines imbriquées (render / comp / flatten), transforms. Produit { items, groups, fps, dims… }.

const path = require('path');
const fs = require('fs');
const { renderRange } = require('../aeRender');
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
// encodent le retime — `ssf == sef` = FREEZE (1 frame tenue), `ssf > sef` = REVERSE, `sef` est EXCLUSIF
// (forward : srcSpan = sef - ssf = durée timeline). GetLeftOffset est en fallback seulement (il dérive
// — décalé de plusieurs frames — et renvoie un timecode garbage, ex 86400, sur les freeze).
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
    if (ssf === sef) { srcIn = srcOut = ssf; freeze = true; }                 // freeze : 1 frame tenue
    else if (ssf > sef) { srcIn = sef; srcOut = ssf - 1; reverse = true; }    // reverse (sef exclusif)
    else { srcIn = ssf; srcOut = sef - 1; }                                   // forward (sef exclusif)
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
  const { nestedMode, outDir, codec, audio, audioRenderFmt, event, includeLinkedAudio } = renderOpts;
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
  async function nestedWindow(it, sub, tlS, tlE) {
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
              const { subStart, winStart } = await nestedWindow(it, sub, tlS, tlE);
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
          if (!mpi || !fp) { missing.push((await safeName(it)) || 'plan'); continue; }
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
          if (type === 'video' && outDir && !place) {
            try {
              fs.appendFileSync(path.join(outDir, '_netsurush_cut_debug.txt'),
                `${nm} | fps=${fpsClip} Frames=${srcFrames} | srcIn=${srcIn} srcOut=${srcOut} span=${srcOut - srcIn + 1} | tl=${tlS}-${tlE} (occ=${tlE - tlS}) | freeze=${freeze} reverse=${reverse} retimed=${retimed}\n`);
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
  }
  await collect(tl, 'video', null, 0, null, null);
  const videoPaths = new Set();
  for (const item of items) if (!item.group) videoPaths.add(item.path);
  await collect(tl, 'audio', includeLinkedAudio ? null : videoPaths, 0, null, null);
  try { if (origTl) await proj.SetCurrentTimeline(origTl); } catch (_) {}
  if (renderErr && !items.length) return { ok: false, error: renderErr };

  const rank = (c) => c.kind === 'video' ? 0 : 1;
  items.sort((a, b) => (rank(a) - rank(b)) || (a.track - b.track) || (a.tlStart - b.tlStart));
  if (endFrame <= startFrame && items.length) {
    endFrame = items.reduce((m, c) => Math.max(m, c.tlEnd), startFrame);
  }
  return { ok: true, timeline: await tl.GetName(), fps, width, height, startFrame, endFrame, items, missing, groups };
}

module.exports = { readTimelineEdit };
