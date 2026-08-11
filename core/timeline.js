// @ts-check
// core/timeline.js
// Construction de timeline FRAME-ACCURATE avec 3 invariants préservés : endFrame inclusif,
// SetSetting('timelineFrameRate') avant create, remap d'espace-frames.
// L'accès Resolve vient du pont Python externe (core/resolve → resolve-proxy).
// sidecars/fcpxml/config sont des modules core/.

const path = require("path");
const os = require("os");
const { pathToFileURL } = require("url");
const { fsp, yieldLoop } = require("./config");
const { getResolve, findItemByPath } = require("./resolve");
const { bridge } = require("./resolve-proxy");
const { detectScenes, getCachedScenes } = require("./sidecars");
const { buildFcpxml, fpsRational } = require("./fcpxml");
const { t } = require("./i18n");
const {
  timelineRecordFrame, timelineClipLayout, firstFreeVideoTrack,
  appendContiguousTimelineClips,
} = require("./timeline-insertion");
const { createFitToFillMedia } = require("./timeline-fit");

// Nettoie un nom de timeline : ctrl-chars → espace (Resolve les refuse), espaces compactés,
// repli non-vide. Garde les accents/ponctuation (Resolve les accepte).
function sanitizeTimelineName(s, fallback = "Timeline") {
  const cleaned = String(s == null ? "" : s)
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

// Liste les noms de timeline déjà pris dans le projet (Resolve interdit les doublons).
async function existingTimelineNames(proj) {
  const names = new Set();
  const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
  for (let i = 1; i <= count; i++) {
    const tl = await proj.GetTimelineByIndex(i);
    if (!tl) continue;
    try { names.add(await tl.GetName()); } catch (_) {}
  }
  return names;
}

// Premier nom LIBRE : base, « base (2) », « base (3) »… calculé AVANT création → une seule
// tentative (plus de boucle de création aveugle). Si la liste est illisible, renvoie le nom nettoyé.
async function uniqueTimelineName(proj, base) {
  const clean = sanitizeTimelineName(base);
  let names;
  try { names = await existingTimelineNames(proj); } catch (_) { return clean; }
  if (!names.has(clean)) return clean;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${clean} (${i})`;
    if (!names.has(candidate)) return candidate;
  }
  return `${clean} (${Date.now()})`;
}

async function ensureVideoTrack(tl, index) {
  let count = parseInt(await tl.GetTrackCount("video"), 10) || 0;
  while (count < index) {
    try {
      if (!(await tl.AddTrack("video"))) break;
    } catch (_) { break; }
    count = parseInt(await tl.GetTrackCount("video"), 10) || count + 1;
  }
  return count >= index ? index : null;
}

async function videoTrackRanges(tl) {
  const count = parseInt(await tl.GetTrackCount("video"), 10) || 0;
  const tracks = [];
  for (let index = 1; index <= count; index++) {
    const ranges = [];
    let items = [];
    try { items = await tl.GetItemListInTrack("video", index) || []; } catch (_) {}
    for (const item of items) {
      try {
        const start = Number(await item.GetStart());
        const end = Number(await item.GetEnd());
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push({ start, end });
      } catch (_) {}
    }
    tracks.push(ranges);
  }
  return tracks;
}

async function videoContentEnd(tl) {
  const startFrame = parseInt(await tl.GetStartFrame(), 10) || 0;
  const tracks = await videoTrackRanges(tl);
  let endFrame = startFrame;
  for (const ranges of tracks) {
    for (const range of ranges) endFrame = Math.max(endFrame, range.end);
  }
  return endFrame;
}

async function appendContiguousOrThrow(mp, clipInfos, opts) {
  const result = await appendContiguousTimelineClips(mp, clipInfos, opts);
  if (!result.ok) throw new Error(t("timelineAppendFailed"));
  return result;
}

async function placementForTimeline(tl, insertion, fps, clipInfos, sourceFps = []) {
  if (!tl || !insertion || insertion === "end") return null;
  const startFrame = parseInt(await tl.GetStartFrame(), 10) || 0;
  let startTimecode = null;
  try { startTimecode = await tl.GetStartTimecode(); } catch (_) {}
  const recordFrame = timelineRecordFrame(await tl.GetCurrentTimecode(), startTimecode, startFrame, fps);
  const layout = timelineClipLayout(clipInfos, sourceFps, fps);
  const totalDuration = layout.totalDuration;
  let trackIndex = null;
  if (insertion === "above") {
    const ranges = await videoTrackRanges(tl);
    trackIndex = await ensureVideoTrack(tl, firstFreeVideoTrack(ranges, recordFrame, recordFrame + totalDuration));
  }
  return clipInfos.map((info, index) => {
    const out = { ...info };
    if (trackIndex != null) out.trackIndex = trackIndex;
    out.recordFrame = recordFrame + layout.clips[index].offset;
    return out;
  });
}

async function timelineItemSnapshot(item, fallbackTrackIndex, fallbackId, timelineFps) {
  const start = Number(await item.GetStart());
  const end = Number(await item.GetEnd());
  const sourceStart = Number(await item.GetSourceStartFrame());
  const sourceEnd = Number(await item.GetSourceEndFrame());
  const media = await item.GetMediaPoolItem();
  let sourceFps = timelineFps;
  try { sourceFps = parseFloat(await media.GetClipProperty("FPS")) || timelineFps; } catch (_) {}
  let trackIndex = fallbackTrackIndex;
  try {
    const track = await item.GetTrackTypeAndIndex();
    trackIndex = Number(track?.trackIndex ?? track?.[1] ?? fallbackTrackIndex) || fallbackTrackIndex;
  } catch (_) {}
  let id = fallbackId;
  try { id = String(await item.GetUniqueId() || fallbackId); } catch (_) {}
  return { id, item, media, trackIndex, start, end, sourceStart, sourceEnd, sourceFps, timelineFps };
}

async function videoTrackSnapshots(tl, trackIndex, timelineFps) {
  const items = await tl.GetItemListInTrack("video", trackIndex) || [];
  const snapshots = [];
  for (let i = 0; i < items.length; i++) {
    try { snapshots.push(await timelineItemSnapshot(items[i], trackIndex, `${trackIndex}:${i}`, timelineFps)); } catch (_) {}
  }
  return snapshots;
}

async function currentVideoTarget(tl, recordFrame, timelineFps) {
  try {
    const current = await tl.GetCurrentVideoItem();
    if (current) {
      const snapshot = await timelineItemSnapshot(current, 1, "current", timelineFps);
      if (snapshot.start <= recordFrame && snapshot.end > recordFrame) return snapshot;
    }
  } catch (_) {}
  const count = parseInt(await tl.GetTrackCount("video"), 10) || 0;
  for (let trackIndex = count; trackIndex >= 1; trackIndex--) {
    const snapshots = await videoTrackSnapshots(tl, trackIndex, timelineFps);
    const hit = snapshots.find((clip) => clip.start <= recordFrame && clip.end > recordFrame);
    if (hit) return hit;
  }
  return null;
}

async function finalizeTake(target, mediaPoolItem, startFrame, endFrame) {
  if (!(await target.AddTake(mediaPoolItem, startFrame, endFrame))) return false;
  const count = parseInt(await target.GetTakesCount(), 10) || 0;
  if (count > 0 && !(await target.SelectTakeByIndex(count))) return false;
  return !!(await target.FinalizeTake());
}

async function applyExistingTimelineInsertion({ tl, mp, resolve, insertion, fps, clipInfos, sourcePaths, sourceFps, videoOnly }) {
  const startFrame = parseInt(await tl.GetStartFrame(), 10) || 0;
  let startTimecode = null;
  try { startTimecode = await tl.GetStartTimecode(); } catch (_) {}
  const timelineFps = parseFloat(await tl.GetSetting("timelineFrameRate")) || fps;
  if (!insertion || insertion === "end") {
    const result = await appendContiguousOrThrow(mp, clipInfos, {
      recordFrame: await videoContentEnd(tl), sourceFps, timelineFps,
    });
    return result.items;
  }
  const recordFrame = timelineRecordFrame(await tl.GetCurrentTimecode(), startTimecode, startFrame, timelineFps);

  if (insertion === "above") {
    const positioned = await placementForTimeline(tl, insertion, timelineFps, clipInfos, sourceFps);
    const first = positioned?.[0];
    const result = await appendContiguousOrThrow(mp, clipInfos, {
      recordFrame: first?.recordFrame ?? recordFrame,
      trackIndex: first?.trackIndex,
      sourceFps, timelineFps,
    });
    return result.items;
  }

  const target = await currentVideoTarget(tl, recordFrame, timelineFps);
  if ((insertion === "replace" || insertion === "fit") && !target) {
    throw new Error(t("timelineInsertionNoTarget"));
  }

  if (insertion === "replace") {
    if (clipInfos.length !== 1) throw new Error(t("timelineInsertionOneShot"));
    const info = clipInfos[0];
    if (!(await finalizeTake(target.item, info.mediaPoolItem, info.startFrame, info.endFrame))) {
      throw new Error(t("timelineReplaceFailed"));
    }
    return [target.item];
  }

  if (insertion === "fit") {
    if (clipInfos.length !== 1 || !sourcePaths?.[0]) throw new Error(t("timelineInsertionOneShot"));
    const info = clipInfos[0];
    const targetFrames = target.end - target.start;
    const output = await createFitToFillMedia({
      input: sourcePaths[0], startFrame: info.startFrame, endFrame: info.endFrame,
      sourceFps: sourceFps?.[0] || fps, targetFrames, targetFps: timelineFps, includeAudio: !videoOnly,
    });
    const storage = await resolve.GetMediaStorage();
    let restoreFolder = null;
    try {
      restoreFolder = await mp.GetCurrentFolder();
      const fitBin = await ensureBin(mp, "NetsuRush — Fit to Fill");
      if (fitBin) await mp.SetCurrentFolder(fitBin);
    } catch (_) { restoreFolder = null; }
    let added;
    try { added = await storage.AddItemListToMediaPool([output]); }
    finally { if (restoreFolder) { try { await mp.SetCurrentFolder(restoreFolder); } catch (_) {} } }
    const fitted = added && added[0];
    if (!fitted) throw new Error(t("timelineFitFailed"));
    const fittedFrames = parseInt(await fitted.GetClipProperty("Frames"), 10) || targetFrames;
    if (!(await finalizeTake(target.item, fitted, 0, Math.max(0, fittedFrames - 1)))) {
      throw new Error(t("timelineFitFailed"));
    }
    return [target.item];
  }

  if (insertion === "overwrite") {
    const result = await appendContiguousOrThrow(mp, clipInfos, {
      recordFrame, trackIndex: target?.trackIndex || 1, sourceFps, timelineFps,
    });
    return result.items;
  }

  throw new Error(`${t("timelineInsertionUnsupported")} : ${insertion}`);
}

/** @param {import('./types').BuildTimelineOpts} opts */
async function buildTimeline(opts) {
  let { name } = opts;   // réassigné si le nom est déjà pris (CreateEmptyTimeline)
  const { input, segments = [], srcFrames, mode = "new", whole = false } = opts;
  // Vidéo seule : n'importe QUE la piste vidéo (mediaType 1) — pas d'audio dans la timeline.
  const videoOnly = !!opts.videoOnly;
  try {
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject") };
    const mp = await proj.GetMediaPool();
    const root = await mp.GetRootFolder();

    let item = await findItemByPath(root, input);
    if (!item) {
      try {
        const ms = await resolve.GetMediaStorage();
        const added = await ms.AddItemListToMediaPool([input]);
        if (added && added.length) item = added[0];
      } catch (_) {}
    }
  if (!item) return { ok: false, error: t("mediaImportFailed") + " : " + input };

    const fpsStr = await item.GetClipProperty("FPS");
    let fps = parseFloat(fpsStr);
    if (!fps || Number.isNaN(fps)) fps = 24;

    let tl = null;
    let created = false;
    let fpsMismatch = false;
    let timelineFps = null;
    let renamed = false;
    const requestedName = sanitizeTimelineName(name);
    if (mode === "append") {
      // Cible explicite (nom de timeline choisi dans le profil d'export) sinon la timeline ouverte.
      const targetName = opts.timelineName ? sanitizeTimelineName(opts.timelineName) : null;
      if (targetName) {
        tl = await getTimelineByName(proj, targetName);
        // Une cible explicite est un contrat : ne jamais ajouter ailleurs ni créer silencieusement.
        if (!tl) return { ok: false, error: `${t("timelineMissing")}: ${targetName}` };
      } else tl = await proj.GetCurrentTimeline();
      if (tl) {
        const tlFpsStr = await tl.GetSetting("timelineFrameRate");
        timelineFps = parseFloat(tlFpsStr);
        if (timelineFps && !Number.isNaN(timelineFps) && Math.abs(timelineFps - fps) > 0.01) {
          fpsMismatch = true;
        }
      }
    }
    if (!tl) {
      // CRUCIAL : la timeline doit avoir le MÊME fps que le clip (sinon Resolve reconforme → drift).
      try { await proj.SetSetting("timelineFrameRate", String(fpsStr)); } catch (_) {}
      // Destination 'bin' → la timeline créée atterrit dans un DOSSIER du Media Pool (cible le dossier
      // AVANT la création, restaure la racine juste après). Défaut = racine.
      let restoreFolder = null;
      if (opts.dest === "bin") {
        try {
          restoreFolder = root;
          const bin = await ensureBin(mp, (opts.binName && String(opts.binName).trim()) || "NetsuRush — Coupes");
          if (bin) await mp.SetCurrentFolder(bin);
        } catch (_) { restoreFolder = null; }
      }
      // Nom unique PRÉ-calculé (Resolve refuse les doublons) → une seule tentative de création.
      let tryName = await uniqueTimelineName(proj, requestedName);
      tl = await mp.CreateEmptyTimeline(tryName);
      // Repli défensif si une course a repris le nom entre le check et la création.
      for (let i = 2; !tl && i < 50; i++) {
        tryName = `${requestedName} (${i})`;
        tl = await mp.CreateEmptyTimeline(tryName);
      }
      if (restoreFolder) { try { await mp.SetCurrentFolder(restoreFolder); } catch (_) { /* best-effort */ } }
  if (!tl) return { ok: false, error: `${t("timelineCreateFailed")}: ${requestedName}` };
      renamed = tryName !== requestedName;
      name = tryName;
      created = true;
      timelineFps = fps;
    }

    const resFrames = parseInt(await item.GetClipProperty("Frames"), 10) || 0;
    const detFrames = parseInt(String(srcFrames), 10) || 0;
    let mapped = false;
    const toRes = (f) => {
      if (resFrames > 1 && detFrames > 1 && resFrames !== detFrames) {
        mapped = true;
        return Math.round((f * (resFrames - 1)) / (detFrames - 1));
      }
      return f;
    };

    const maxFrame = resFrames > 0 ? resFrames - 1 : Number.MAX_SAFE_INTEGER;
    // Couleurs (revue colorée) filtrées EN PARALLÈLE des clips : une clipInfo invalide (frames
    // hors borne / dégénérée) fait échouer TOUT AppendToTimeline → on saute ces clips, et on garde
    // l'alignement couleur↔clip en filtrant le même index.
    const colorsIn = Array.isArray(opts.colors) ? opts.colors : null;
    const keptColors = [];
    let clipInfos;
    if (whole) {
      if (resFrames > 0) {
        const wholeInfo = { mediaPoolItem: item, startFrame: 0, endFrame: maxFrame };
        clipInfos = [videoOnly ? { ...wholeInfo, mediaType: 1 } : wholeInfo];
      } else {
        clipInfos = [videoOnly ? { mediaPoolItem: item, mediaType: 1 } : { mediaPoolItem: item }];
      }
    } else {
      clipInfos = [];
      segments.forEach((s, idx) => {
        const sf0 = s.inFrame != null ? s.inFrame : Math.round(s.in * fps);
        const ef0 = s.outFrame != null ? s.outFrame : Math.round(s.out * fps) - 1;
        const startFrame = Math.min(maxFrame, Math.max(0, toRes(sf0)));
        const endFrame = Math.min(maxFrame, Math.max(startFrame, toRes(ef0)));
        if (!(endFrame >= startFrame) || startFrame > maxFrame) return; // dégénéré / hors borne
        clipInfos.push(videoOnly ? { mediaPoolItem: item, startFrame, endFrame, mediaType: 1 } : { mediaPoolItem: item, startFrame, endFrame });
        if (colorsIn) keptColors.push(colorsIn[idx] != null ? colorsIn[idx] : null);
      });
    }
    if (!clipInfos.length) {
    return { ok: false, error: `${t("noValidSegments")} (fps=${fps} frames=${resFrames})`, timeline: name, mode, created };
    }

    try { await proj.SetCurrentTimeline(tl); } catch (_) {}
    if (!created && whole && opts.insertion !== "end" && resFrames <= 0) {
      return { ok: false, error: `${t("noValidSegments")} (Frames=0)`, timeline: await tl.GetName(), mode, created };
    }
    const appended = !created
      ? await applyExistingTimelineInsertion({ tl, mp, resolve, insertion: opts.insertion, fps, clipInfos, sourcePaths: [input], sourceFps: [fps], videoOnly })
      : (await appendContiguousOrThrow(mp, clipInfos, {
          recordFrame: parseInt(await tl.GetStartFrame(), 10) || 0,
          sourceFps: [fps], timelineFps: fps,
        })).items;
    const okAppend = Array.isArray(appended) ? appended.length > 0 : !!appended;
    let tlName = name;
    if (!created) { try { tlName = await tl.GetName(); } catch (_) {} }
    if (!okAppend) {
      // Diagnostic concret : fps + Frames lus par Resolve + nb de clips + 3 plages → repère VFR
      // (Frames=0/incohérent), fps faux, ou liste vide à l'origine du refus.
      const sample = clipInfos.slice(0, 3).map((c) => `${c.startFrame}-${c.endFrame}`).join(", ");
    return { ok: false, error: `${t("timelineAppendFailed")}: ${tlName} (fps=${fps} frames=${resFrames} clips=${clipInfos.length} [${sample}])`, timeline: tlName, mode, created };
    }

    // Code-couleur des découpes : revue VOIX → on colore les clips de la piste AUDIO (A1), pas la
    // vidéo (c'est la forme d'onde audio qu'on relit pour le montage voix). Items lus en ordre sur une
    // timeline neuve = 1:1 avec clipInfos/keptColors. Repli vidéo (appended/V1) si pas d'audio.
    let colored = 0;
    if (keptColors.length) {
      let items = null;
      if (created) {
        try {
          const a = await tl.GetItemListInTrack("audio", 1);
          if (Array.isArray(a) && a.length) items = a;
        } catch (_) {}
      }
      if (!items || !items.length) {
        // Pas d'audio sur A1 → on retombe sur la vidéo (tableau renvoyé par AppendToTimeline ou V1).
        items = Array.isArray(appended) && appended.length === keptColors.length ? appended : null;
        if ((!items || !items.length) && created) {
          try {
            const v = await tl.GetItemListInTrack("video", 1);
            if (Array.isArray(v) && v.length) items = v;
          } catch (_) {}
        }
      }
      if (items) {
        const n = Math.min(items.length, keptColors.length);
        for (let i = 0; i < n; i++) {
          const col = keptColors[i];
          if (!col || !items[i]) continue;
          try { if (await items[i].SetClipColor(col)) colored++; } catch (_) {}
        }
      }
    }
    return {
      ok: true, timeline: tlName, count: clipInfos.length, mapped,
      mode, created, fpsMismatch, timelineFps, clipFps: fps, whole,
      renamed, requestedName, colored,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Construit une timeline à partir de blocs de script ORDONNÉS, sources MULTIPLES (≠ buildTimeline
 * qui est mono-source). Chaque bloc = { filePath, inFrame, outFrame, fps }. outFrame null/omis =
 * clip entier. Frame-accurate : endFrame INCLUSIF, SetSetting('timelineFrameRate') AVANT create.
 * Pas de remap srcFrames : les in/out sont posés sur le vrai clip (déjà en frames-clip).
 * mode 'append' + timelineName → ajoute à CETTE timeline existante (sinon la timeline ouverte).
 * `markers` = [{ index, name, note, color }] : marqueur Resolve posé au DÉBUT du clip issu de
 * blocks[index] (commentaires du script exportés vers la timeline) — best-effort.
 * @param {{ name?: string, mode?: 'new'|'append', timelineName?: string, insertion?: string, dest?: 'timeline'|'bin', binName?: string, videoOnly?: boolean, blocks: { filePath: string, inFrame?: number, outFrame?: number|null, fps?: number }[], markers?: { index: number, name?: string, note?: string, color?: string }[] }} opts
 */
async function buildTimelineFromBlocks(opts) {
  const { mode = "new", blocks = [], timelineName: targetName, markers = [] } = opts || {};
  let name = (opts && opts.name) || "Script";
  try {
  if (!blocks.length) return { ok: false, error: t("noBuildShots") };
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject") };
    const mp = await proj.GetMediaPool();
    const root = await mp.GetRootFolder();

    // Résolution (+ import au besoin) de chaque source, en cache par chemin.
    const itemCache = new Map();
    async function resolveItem(filePath) {
      if (itemCache.has(filePath)) return itemCache.get(filePath);
      let item = await findItemByPath(root, filePath);
      if (!item) {
        try {
          const ms = await resolve.GetMediaStorage();
          const added = await ms.AddItemListToMediaPool([filePath]);
          if (added && added.length) item = added[0];
        } catch (_) {}
      }
      itemCache.set(filePath, item || null);
      return item || null;
    }

    // clipInfos ordonnés + fps de référence (1er clip résolu) + détection de mélange de fps.
    const clipInfos = [];
    const sourcePaths = [];
    const sourceFps = [];
    const missing = [];
    let timelineFps = null;
    let timelineFpsStr = null; // chaîne fps d'origine (préserve 23.976 vs 23.975999… → pas de drift)
    let fpsMismatch = false;
    const clipBlockIndex = []; // clipInfos[i] ← blocks[clipBlockIndex[i]] (sources manquantes sautées)
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const item = await resolveItem(b.filePath);
      if (!item) { missing.push(b.filePath); continue; }
      const fpsStr = await item.GetClipProperty("FPS");
      const fpsValid = fpsStr != null && !Number.isNaN(parseFloat(fpsStr));
      let clipFps = parseFloat(fpsStr);
      if (!clipFps || Number.isNaN(clipFps)) clipFps = Number(b.fps) || 24;
      if (timelineFps == null) { timelineFps = clipFps; timelineFpsStr = fpsValid ? String(fpsStr) : String(clipFps); }
      else if (Math.abs(clipFps - timelineFps) > 0.01) fpsMismatch = true;

      const resFrames = parseInt(await item.GetClipProperty("Frames"), 10) || 0;
      const maxFrame = resFrames > 0 ? resFrames - 1 : Number.MAX_SAFE_INTEGER;
      const startFrame = Math.min(maxFrame, Math.max(0, Math.round(b.inFrame || 0)));
      const endFrame =
        b.outFrame == null
          ? maxFrame
          : Math.min(maxFrame, Math.max(startFrame, Math.round(b.outFrame)));
      clipInfos.push(opts.videoOnly
        ? { mediaPoolItem: item, startFrame, endFrame, mediaType: 1 }
        : { mediaPoolItem: item, startFrame, endFrame });
      sourcePaths.push(b.filePath);
      sourceFps.push(clipFps);
      clipBlockIndex.push(bi);
      await yieldLoop();
    }
    if (!clipInfos.length) {
    return { ok: false, error: t("mediaPoolSourcesMissing") + " : " + missing.join(", "), missing };
    }

    let tl = null;
    let created = false;
    const requestedName = sanitizeTimelineName(name);
    if (mode === "append") {
      // Cible explicite (timeline choisie) → on la rend courante ; sinon la timeline ouverte.
      if (targetName) {
        tl = await getTimelineByName(proj, targetName);
        if (!tl) return { ok: false, error: `${t("timelineMissing")}: ${targetName}` };
      } else tl = await proj.GetCurrentTimeline();
      if (tl) {
        const tlFpsStr = await tl.GetSetting("timelineFrameRate");
        const tlFps = parseFloat(tlFpsStr);
        if (tlFps && !Number.isNaN(tlFps) && Math.abs(tlFps - timelineFps) > 0.01) fpsMismatch = true;
      }
    }
    if (!tl) {
      try { await proj.SetSetting("timelineFrameRate", timelineFpsStr || String(timelineFps)); } catch (_) {}
      let restoreFolder = null;
      if (opts.dest === "bin") {
        try {
          restoreFolder = root;
          const bin = await ensureBin(mp, (opts.binName && String(opts.binName).trim()) || "NetsuRush — Coupes");
          if (bin) await mp.SetCurrentFolder(bin);
        } catch (_) { restoreFolder = null; }
      }
      let tryName = await uniqueTimelineName(proj, requestedName);
      tl = await mp.CreateEmptyTimeline(tryName);
      for (let i = 2; !tl && i < 50; i++) {
        tryName = `${requestedName} (${i})`;
        tl = await mp.CreateEmptyTimeline(tryName);
      }
      if (restoreFolder) { try { await mp.SetCurrentFolder(restoreFolder); } catch (_) { /* best-effort */ } }
  if (!tl) return { ok: false, error: `${t("timelineCreateFailed")}: ${requestedName}` };
      name = tryName;
      created = true;
    }

    try { await proj.SetCurrentTimeline(tl); } catch (_) {}
    // Contenu déjà présent (mode append) : les marqueurs des nouveaux clips se posent APRÈS.
    let baseFrames = 0;
    if (markers.length && !created) {
      try {
        const s = parseInt(await tl.GetStartFrame(), 10);
        const e = parseInt(await tl.GetEndFrame(), 10);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) baseFrames = e - s;
      } catch (_) {}
    }
    const appended = !created
      ? await applyExistingTimelineInsertion({
          tl, mp, resolve, insertion: opts.insertion, fps: timelineFps || 24,
          clipInfos, sourcePaths, sourceFps, videoOnly: !!opts.videoOnly,
        })
      : (await appendContiguousOrThrow(mp, clipInfos, {
          recordFrame: parseInt(await tl.GetStartFrame(), 10) || 0,
          sourceFps, timelineFps: timelineFps || 24,
        })).items;
    const okAppend = Array.isArray(appended) ? appended.length > 0 : !!appended;
    let tlName = name;
    if (!created) { try { tlName = await tl.GetName(); } catch (_) {} }
    if (!okAppend) {
    return { ok: false, error: `${t("timelineAppendFailed")}: ${tlName}`, timeline: tlName, mode, created };
    }

    // Marqueurs (commentaires exportés) : offset cumulé des clips précédents, frame relative au
    // début de la timeline (contrat AddMarker). Best-effort : un échec ne casse pas le build.
    let markersAdded = 0;
    if (markers.length) {
      const byBlock = new Map();
      markers.forEach((m) => { if (m && Number.isFinite(m.index)) byBlock.set(m.index | 0, m); });
      const markerLayout = timelineClipLayout(clipInfos, sourceFps, timelineFps || 24);
      let cum = baseFrames;
      for (let ci = 0; ci < clipInfos.length; ci++) {
        const m = byBlock.get(clipBlockIndex[ci]);
        if (m) {
          try {
            const okM = await tl.AddMarker(
              cum, String(m.color || 'Blue'), String(m.name || 'Commentaire'), String(m.note || ''), 1, ''
            );
            if (okM) markersAdded++;
          } catch (_) {}
        }
        cum += markerLayout.clips[ci].duration;
      }
    }
    return {
      ok: true, timeline: tlName, count: clipInfos.length, mode, created,
      fpsMismatch, timelineFps, missing: missing.length ? missing : undefined,
      markersAdded: markers.length ? markersAdded : undefined,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function listTimelines() {
  try {
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable"), timelines: [] };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject"), timelines: [] };
    const cur = await proj.GetCurrentTimeline();
    const curName = cur ? await cur.GetName() : null;
    const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
    const timelines = [];
    for (let i = 1; i <= count; i++) {
      try {
        const tl = await proj.GetTimelineByIndex(i);
        if (!tl) continue;
        const name = await tl.GetName();
        if (name) timelines.push({ name, current: name === curName });
      } catch (_) { /* une timeline illisible ne doit pas annuler toute la liste */ }
    }
    // Invariant UI : si Resolve expose une timeline courante, elle doit toujours être sélectionnable,
    // même si GetTimelineCount/GetTimelineByIndex a rendu une vue transitoirement incomplète.
    if (curName && !timelines.some((timeline) => timeline.name === curName)) {
      timelines.unshift({ name: curName, current: true });
    }
    return { ok: true, current: curName, timelines };
  } catch (e) {
    return { ok: false, error: String(e), timelines: [] };
  }
}

// Arbre des timelines façon Media Pool : chaque timeline EST un item du Media Pool (sans « File Path »),
// rangé dans un bin. On parcourt les dossiers et on associe chaque timeline à son bin (chemin « A/B »).
// Cross-référence avec GetTimelineByIndex (vérité) → ne garde que les vraies timelines + marque la
// courante. Sert le navigateur Timeline Live à replier/trier par dossier comme le Media Pool.
async function timelineTree() {
  try {
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable"), timelines: [] };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject"), timelines: [] };
    const cur = await proj.GetCurrentTimeline();
    const curName = cur ? await cur.GetName() : null;
    const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
    const known = new Set();
    for (let i = 1; i <= count; i++) { const tl = await proj.GetTimelineByIndex(i); if (tl) known.add(await tl.GetName()); }

    const mp = await proj.GetMediaPool();
    const root = await mp.GetRootFolder();
    const out = [];
    const seen = new Set();
    let processed = 0;
    async function walk(folder, prefix) {
      const list = (await folder.GetClipList()) || [];
      for (const item of list) {
        try {
          const name = await item.GetName();
          if (!known.has(name) || seen.has(name)) continue;   // pas une (vraie) timeline / déjà vue
          seen.add(name);
          out.push({ name, bin: prefix, current: name === curName });
        } catch (_) { /* item illisible */ }
        if (++processed % 25 === 0) await yieldLoop();
      }
      const subs = (await folder.GetSubFolderList()) || [];
      for (const sub of subs) await walk(sub, (prefix ? prefix + "/" : "") + (await sub.GetName()));
    }
    await walk(root, "");
    // Timelines non localisées dans un bin (rare) → racine.
    for (const name of known) if (!seen.has(name)) out.push({ name, bin: "", current: name === curName });
    return { ok: true, current: curName, timelines: out };
  } catch (e) {
    return { ok: false, error: String(e), timelines: [] };
  }
}

// Premier plan SOURCE d'une timeline (pour une vignette) : 1er item d'une piste vidéo qui porte un
// MediaPoolItem + un chemin fichier (on saute titres/générateurs/Fusion). Lecture MINIMALE — on
// s'arrête au 1er trouvé, pas de parcours complet (≠ readTimelineCuts). Renvoie { path, in } (sec).
async function firstSourceClip(tl) {
  const vCount = parseInt(await tl.GetTrackCount("video"), 10) || 0;
  for (let t = 1; t <= vCount; t++) {
    const items = (await tl.GetItemListInTrack("video", t)) || [];
    for (const it of items) {
      try {
        const mpi = await it.GetMediaPoolItem();
        if (!mpi) continue;
        const fp = await mpi.GetClipProperty("File Path");
        if (!fp) continue;
        let fps = parseFloat(await mpi.GetClipProperty("FPS"));
        if (!fps || Number.isNaN(fps)) fps = 24;
        const ssf = parseInt(await it.GetSourceStartFrame(), 10);
        const inFrame = Number.isNaN(ssf) ? 0 : Math.max(0, ssf);
        return { path: fp, in: inFrame / fps };
      } catch (_) { /* item illisible : suivant */ }
    }
  }
  return null;
}

// Cache de session (name → { path, in }) : probe Resolve coûteux (round-trips par timeline) → on ne
// le refait pas à chaque ouverture de l'onglet. Invalidé par `refresh:true` (bouton recharger) OU au
// changement de projet (opts.project ≠ projet du cache → le cache montrait des timelines obsolètes).
let thumbsCache = null;
// Nom du projet dont provient le cache : un switch de projet (opts.project différent) force un rescan.
let thumbsProject = null;
// Scan EN COURS (dédup) + projet qu'il vise. Le pont Python est SÉQUENTIEL. Au switch de projet, le
// refocus de la fenêtre + l'effet de scan rappellent timelineThumbs ; sans cette garde, N scans
// complets (des milliers d'allers-retours chacun) s'empilent et affament listTimelines/readTimelineCuts
// → chargement infini. Un seul scan tourne par projet visé ; les appels concurrents attendent son
// résultat et le re-streament.
let thumbsInFlight = null;
let thumbsInFlightProject = null;

// Pour CHAQUE timeline du projet : son 1er plan source → { name, path, in }. STREAMÉ : chaque vignette
// est poussée en SSE (`resolve:timelineThumb`) dès qu'elle est résolue → le navigateur se remplit au
// fil de l'eau au lieu d'attendre le scan complet. Le renderer génère/cache la vignette en lazy via
// ffmpeg:thumbnail. Pas de bascule de timeline courante (objets lus via GetTimelineByIndex).
/** @param {any} [ev] @param {{ refresh?: boolean, project?: string }} [opts] */
async function timelineThumbs(ev, opts = {}) {
  const send = (name, clip) => { try { ev && ev.sender.send("resolve:timelineThumb", { name, path: clip.path, in: clip.in }); } catch (_) {} };
  const reqProject = opts.project != null ? opts.project : null;
  const explicit = !!opts.refresh; // bouton recharger → toujours rescan
  // Cache valide si même projet (ou caller sans avis) et pas de refresh explicite.
  const cacheUsable = thumbsCache && !explicit && (reqProject == null || reqProject === thumbsProject);
  if (reqProject != null && thumbsProject != null && reqProject !== thumbsProject) thumbsCache = null; // switch projet
  if (cacheUsable) {
    const thumbs = [...thumbsCache].map(([name, clip]) => ({ name, ...clip }));
    for (const [name, clip] of thumbsCache) send(name, clip);
    return { ok: true, thumbs, cached: true };
  }
  // Un scan vise déjà ce même projet → on attend SON résultat (pas de second scan) puis on le re-streame.
  if (thumbsInFlight && !explicit && (reqProject == null || reqProject === thumbsInFlightProject)) {
    const r = await thumbsInFlight;
    if (r && r.ok) for (const t of r.thumbs) send(t.name, { path: t.path, in: t.in });
    return r;
  }
  thumbsInFlightProject = reqProject;
  const scan = (async () => {
    try {
      const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable"), thumbs: [] };
      const pm = await resolve.GetProjectManager();
      const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject"), thumbs: [] };
      const projName = await proj.GetName();
      const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
      const cache = new Map();
      const thumbs = [];
      let n = 0;
      for (let i = 1; i <= count; i++) {
        const tl = await proj.GetTimelineByIndex(i);
        if (!tl) continue;
        const name = await tl.GetName();
        let clip = null;
        try { clip = await firstSourceClip(tl); } catch (_) { /* timeline illisible : sans vignette */ }
        if (clip) { const c = { path: clip.path, in: clip.in }; cache.set(name, c); thumbs.push({ name, ...c }); send(name, c); }
        if (++n % 5 === 0) await yieldLoop();
      }
      thumbsCache = cache;
      thumbsProject = projName;
      return { ok: true, thumbs };
    } catch (e) {
      return { ok: false, error: String(e), thumbs: [] };
    }
  })();
  thumbsInFlight = scan;
  try { return await scan; } finally { if (thumbsInFlight === scan) thumbsInFlight = null; }
}

async function getTimelineByName(proj, name) {
  const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
  for (let i = 1; i <= count; i++) {
    const tl = await proj.GetTimelineByIndex(i);
    if (tl && (await tl.GetName()) === name) return tl;
  }
  return null;
}

async function timelineSourceClips(tl) {
  const found = [];
  const seen = new Set();
  const vCount = parseInt(await tl.GetTrackCount("video"), 10) || 0;
  let n = 0;
  for (let t = 1; t <= vCount; t++) {
    const items = (await tl.GetItemListInTrack("video", t)) || [];
    for (const it of items) {
      try {
        const mpi = await it.GetMediaPoolItem();
        if (mpi) {
          const fp = await mpi.GetClipProperty("File Path");
          if (fp && !seen.has(fp)) {
            seen.add(fp);
            const start = parseInt(await it.GetStart(), 10) || 0;
            found.push({ path: fp, name: await mpi.GetName(), item: mpi, start });
          }
        }
      } catch (_) {}
      if (++n % 25 === 0) await yieldLoop();
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

// Lit les plans (items) d'une timeline Resolve EXISTANTE comme une liste de coupes individuelles —
// chaque item vidéo = un plan (source MediaPoolItem + in/out frames SOURCE). Sert l'onglet « Timeline
// Live » : on charge les coupes déjà montées en vignettes/aperçus (comme le derush) pour les re-monter
// facilement ailleurs. in/out en secondes (lecture proxy) ET frames (re-montage frame-accurate).
// in/outFrame = frames SOURCE inclusives ; out (s) = exclusif (fin de plan) pour le proxy.
/** @param {{ timelineName?: string }} [opts] */
async function readTimelineCuts(opts = {}) {
  const { timelineName } = opts;
  // Agrégat Python `read_timeline` : items + propriétés de TOUTE la timeline en UN round-trip stdio
  // (l'ouverture faisait ~5 allers-retours PAR plan). La frame-math reste ici, identique au chemin
  // proxy : ssf/sef bruts → clamp → outFrame inclusif, out (s) exclusif. Repli proxy si agrégat KO.
  try {
    const c = await bridge.connect();
  if (!c || !c.connected) return { ok: false, error: t("resolveUnavailable"), cuts: [] };
    const r = await bridge.readTimeline(timelineName || null);
    if (r && r.found === false) {
      return timelineName
      ? { ok: false, error: `${t("timelineMissing")}: ${timelineName}`, cuts: [] }
      : { ok: false, error: t("noTimeline"), cuts: [] };
    }
    if (r && r.found) {
      const cuts = [];
      /** @type {Map<string, {fps:number, srcFrames:number, name:string}>} */
      const propCache = new Map();
      for (const row of r.items || []) {
        const fp = row.path;
        if (!fp) continue;
        let meta = propCache.get(fp);
        if (!meta) {
          let fps = parseFloat(row.fps);
          if (!fps || Number.isNaN(fps)) fps = 24;
          const srcFrames = parseInt(row.frames, 10) || 0;
          meta = { fps, srcFrames, name: row.clipName || "" };
          propCache.set(fp, meta);
        }
        const { fps, srcFrames, name } = meta;
        const maxFrame = srcFrames > 0 ? srcFrames - 1 : Number.MAX_SAFE_INTEGER;
        let ssf = parseInt(row.ssf, 10);
        let sef = parseInt(row.sef, 10);
        if (Number.isNaN(ssf) || Number.isNaN(sef)) {
          const lo = parseInt(row.lo, 10) || 0;
          const span = parseInt(row.dur, 10) || 0;
          ssf = lo;
          sef = lo + span; // exclusif
        }
        const inFrame = Math.max(0, Math.min(maxFrame, ssf));
        const outFrame = Math.max(inFrame, Math.min(maxFrame, sef - 1)); // inclusif
        cuts.push({
          id: `${row.track}:${cuts.length}:${inFrame}`,
          path: fp,
          name,
          track: row.track,
          // Nom BRUT de la piste : le renderer décide seul ce qu'il en affiche (une piste jamais
          // renommée s'appelle « Video N » chez Resolve comme chez Premiere).
          trackName: row.trackName || "",
          in: inFrame / fps,
          out: (outFrame + 1) / fps, // exclusif → fin de plan pour le proxy
          inFrame,
          outFrame,
          srcFrames,
          fps,
          tlStart: parseInt(row.start, 10) || 0,
        });
      }
      cuts.sort((a, b) => a.tlStart - b.tlStart);
      return { ok: true, timeline: r.timeline, cuts };
    }
  } catch (_) { /* agrégat KO (pont froid, projet fermé mid-call…) → repli proxy ci-dessous */ }
  return readTimelineCutsViaProxy(opts);
}

/** @param {{ timelineName?: string }} [opts] */
async function readTimelineCutsViaProxy(opts = {}) {
  const { timelineName } = opts;
  try {
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable"), cuts: [] };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject"), cuts: [] };

    let tl;
    if (timelineName) {
      tl = await getTimelineByName(proj, timelineName);
  if (!tl) return { ok: false, error: `${t("timelineMissing")}: ${timelineName}`, cuts: [] };
    } else {
      tl = await proj.GetCurrentTimeline();
  if (!tl) return { ok: false, error: t("noTimeline"), cuts: [] };
    }
    const tlName = await tl.GetName();

    const cuts = [];
    let n = 0;
    // Pont Python SÉQUENTIEL : chaque appel = un aller-retour. On minimise les round-trips par plan :
    // 1 seul GetClipProperty() (dict complet) au lieu de 3 appels nommés, et cache des métadonnées
    // source par chemin (FPS/Frames/Nom identiques pour tous les plans d'un même rush). Sur une
    // timeline qui réutilise les mêmes rushs, ça divise fortement le temps d'ouverture.
    const propCache = new Map();
    const vCount = parseInt(await tl.GetTrackCount("video"), 10) || 0;
    for (let t = 1; t <= vCount; t++) {
      // Un seul aller-retour par PISTE (le pont est séquentiel) — jamais par plan.
      let trackName = "";
      try { trackName = (await tl.GetTrackName("video", t)) || ""; } catch (_) { /* API absente */ }
      const items = (await tl.GetItemListInTrack("video", t)) || [];
      for (const it of items) {
        try {
          const mpi = await it.GetMediaPoolItem();
          if (!mpi) continue; // titres / générateurs / Fusion : pas de média source
          const props = (await mpi.GetClipProperty()) || {};
          const fp = props["File Path"];
          if (!fp) continue;
          let meta = propCache.get(fp);
          if (!meta) {
            let fps = parseFloat(props["FPS"]);
            if (!fps || Number.isNaN(fps)) fps = 24;
            const srcFrames = parseInt(props["Frames"], 10) || 0;
            const name = props["Clip Name"] || (await mpi.GetName());
            meta = { fps, srcFrames, name };
            propCache.set(fp, meta);
          }
          const { fps, srcFrames, name } = meta;
          const maxFrame = srcFrames > 0 ? srcFrames - 1 : Number.MAX_SAFE_INTEGER;

          // in/out SOURCE en frames. GetSourceEndFrame est INCLUSIF (mesuré sur Resolve 21.0.3 :
          // un fichier de 96 images posé entier rend ssf=0, sef=95) → outFrame = sef, l'invariant
          // « bornes inclusives » de la timeline est déjà le sien. Le lire comme exclusif retirait
          // la dernière image de chaque plan découpé. Repli GetLeftOffset + span si l'API manque.
          let ssf = parseInt(await it.GetSourceStartFrame(), 10);
          let sef = parseInt(await it.GetSourceEndFrame(), 10);
          if (Number.isNaN(ssf) || Number.isNaN(sef)) {
            const lo = parseInt(await it.GetLeftOffset(), 10) || 0;
            const span = (parseInt(await it.GetDuration(), 10) || 0);
            ssf = lo;
            sef = lo + Math.max(0, span - 1); // inclusif, comme l'API
          }
          const inFrame = Math.max(0, Math.min(maxFrame, ssf));
          const outFrame = Math.max(inFrame, Math.min(maxFrame, sef)); // inclusif
          cuts.push({
            id: `${t}:${cuts.length}:${inFrame}`,
            path: fp,
            name,
            track: t,
            trackName,
            in: inFrame / fps,
            out: (outFrame + 1) / fps, // exclusif → fin de plan pour le proxy
            inFrame,
            outFrame,
            srcFrames,
            fps,
            tlStart: parseInt(await it.GetStart(), 10) || 0,
          });
        } catch (_) { /* item illisible : on saute */ }
        if (++n % 25 === 0) await yieldLoop();
      }
    }
    cuts.sort((a, b) => a.tlStart - b.tlStart);
    return { ok: true, timeline: tlName, cuts };
  } catch (e) {
    return { ok: false, error: String(e), cuts: [] };
  }
}

// Calcule la structure de coupe FCPXML (un objet par rush : plans source-contigus) à partir des plans
// DÉTECTÉS. Applique les 3 invariants timeline : remap d'espace-frames (#3), endFrame inclusif→exclusif
// (#1), et le fps réel du rush (#2, via fpsRational). Ne construit RIEN — sert l'analyse ET l'éditeur.
async function computeCutClips(withScenes, fps0, onProg) {
  const fcpClips = [];
  for (let ci = 0; ci < withScenes.length; ci++) {
    const p = withScenes[ci];
    const resFrames = parseInt(await p.item.GetClipProperty("Frames"), 10) || 0;
    const detFrames = p.detFrames;
    const maxFrame = resFrames > 0 ? resFrames - 1 : Number.MAX_SAFE_INTEGER;
    const maxExcl = resFrames > 0 ? resFrames : Number.MAX_SAFE_INTEGER;
    const toRes = (f) => (resFrames > 1 && detFrames > 1 && resFrames !== detFrames)
      ? Math.round((f * (resFrames - 1)) / (detFrames - 1)) : f;
    const fpsNum = parseFloat(await p.item.GetClipProperty("FPS")) || p.fps || fps0;
    const rm = /(\d+)\s*x\s*(\d+)/.exec((await p.item.GetClipProperty("Resolution")) || "");
    const w = rm ? parseInt(rm[1], 10) : 0;
    const h = rm ? parseInt(rm[2], 10) : 0;

    const sc = p.scenes;
    let prev = -1;
    const starts = sc.map((s) => {
      const sf0 = s.startFrame != null ? s.startFrame : Math.round(s.start * (p.fps || fps0));
      let v = Math.min(maxFrame, Math.max(0, toRes(sf0)));
      if (v <= prev) v = prev + 1;
      prev = v;
      return v;
    });
    const shots = [];
    for (let i = 0; i < sc.length; i++) {
      const startFrame = starts[i];
      if (startFrame >= maxExcl) break;
      let endExcl;
      if (i + 1 < sc.length && starts[i + 1] > startFrame && starts[i + 1] < maxExcl) {
        endExcl = starts[i + 1];
      } else {
        const s = sc[i];
        const ef0 = s.endFrame != null ? s.endFrame : Math.round(s.end * (p.fps || fps0)) - 1;
        endExcl = Math.min(maxExcl, toRes(ef0) + 1);
      }
      endExcl = Math.min(maxExcl, Math.max(startFrame + 1, endExcl));
      shots.push({ startFrame, frames: endExcl - startFrame });
    }
    if (shots.length) {
      const lastEnd = shots[shots.length - 1].startFrame + shots[shots.length - 1].frames;
      fcpClips.push({
        src: pathToFileURL(p.path).href, path: p.path, name: p.name, fps: fpsRational(fpsNum),
        totalFrames: resFrames || detFrames || lastEnd, w, h, fpsNum, shots,
      });
    }
    if (onProg) onProg(Math.round(((ci + 1) / withScenes.length) * 100));
    await yieldLoop();
  }
  return fcpClips;
}

// Résout la timeline cible (par nom, ou la courante) puis détecte les plans de TOUS ses rushs et
// calcule la structure de coupe — SANS construire. Retour sérialisable (aucun handle Resolve) pour
// l'éditeur de coupes in-app : { source, base, clips:[{src,path,name,fps,fpsNum,totalFrames,w,h,shots}], shots }.
/**
 * @param {any} event
 * @param {{ timelineName?: string, model?: string, threshold?: number, detectionOptions?: Record<string, any> }} [opts]
 */
async function analyzeTimelineCut(event, opts = {}) {
  const { timelineName, model = "transnetv2", threshold = 0.5, detectionOptions = {} } = opts;
  try {
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject") };

    let tl;
    if (timelineName) {
      tl = await getTimelineByName(proj, timelineName);
  if (!tl) return { ok: false, error: `${t("timelineMissing")}: ${timelineName}` };
    } else {
      tl = await proj.GetCurrentTimeline();
  if (!tl) return { ok: false, error: t("noTimeline") };
    }
    const srcName = await tl.GetName();

    const clips = await timelineSourceClips(tl);
  if (!clips.length) return { ok: false, error: t("noMediaTimeline") };

    const total = clips.length;
    const report = (i, pct, phase) => {
      // La détection repart à 0 pour chaque clip. Exposer ce pourcentage brut
      // faisait reculer la barre entre deux rushes ; on le projette sur la
      // portion 0..90 réservée à la détection de l'ensemble de la timeline.
      const localPct = Math.max(0, Math.min(100, Number(pct) || 0));
      const progress = Math.round(((i + localPct / 100) / total) * 90);
      if (event?.sender) event.sender.send("timelinecut:progress", { file: clips[i]?.name ?? "", done: i, total, pct: progress, phase });
    };

    const perClip = [];
    for (let i = 0; i < total; i++) {
      const c = clips[i];
      report(i, 0, "detect");
      const thr = model === "omnishotcut" ? 0 : threshold;
      let res = await getCachedScenes(c.path, model, thr, detectionOptions);
      if (!res || !res.cached || !res.scenes || !res.scenes.length) {
        const fakeEvent = { sender: { send: (ch, pct) => { if (ch === "scenes:progress") report(i, pct, "detect"); } } };
        res = await detectScenes(fakeEvent, c.path, thr, model, detectionOptions);
      }
      perClip.push({
        item: c.item, path: c.path, name: c.name, scenes: (res && res.scenes) || [],
        detFrames: parseInt(res && res.frames, 10) || 0, fps: parseFloat(res && res.fps) || 0,
      });
    }

    const withScenes = perClip.filter((p) => p.scenes.length);
  if (!withScenes.length) return { ok: false, error: t("noDetectedShots") };

    let fps0Str = await withScenes[0].item.GetClipProperty("FPS");
    if (!fps0Str || Number.isNaN(parseFloat(fps0Str))) fps0Str = String(withScenes[0].fps || 24);
    const fps0 = parseFloat(fps0Str) || 24;

    const fcpClips = await computeCutClips(withScenes, fps0, (pct) => {
      // Les 10 % restants couvrent l'analyse et la préparation du FCPXML.
      const progress = 90 + Math.round(Math.max(0, Math.min(100, Number(pct) || 0)) * 0.09);
      if (event?.sender) event.sender.send("timelinecut:progress", { file: "", done: total, total, pct: progress, phase: "analyze" });
    });
  if (!fcpClips.length) return { ok: false, error: t("noUsableClips") };

    const shotsTotal = fcpClips.reduce((a, c) => a + c.shots.length, 0);
    // Sérialisable : on retire l'item Resolve (handle non re-passable au renderer).
    const outClips = fcpClips.map((c) => ({
      src: c.src, path: c.path, name: c.name, fps: c.fps, fpsNum: c.fpsNum,
      totalFrames: c.totalFrames, w: c.w, h: c.h, shots: c.shots,
    }));
    return { ok: true, source: srcName, base: `${srcName} — découpé`, clips: outClips, shots: shotsTotal };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Construit + importe la timeline découpée à partir d'une structure fcpClips (potentiellement ÉDITÉE
// par l'éditeur de coupes in-app : plans fusionnés/supprimés). Voie FCPXML → l'originale reste intacte,
// les coupes sont des through-edits natifs (supprimables/joignables à la main dans Resolve).
/**
 * @param {any} event
 * @param {{ name?: string, source?: string, mode?: string, clips?: Array<{src:string,name:string,fps:{num:number,den:number}|number,totalFrames:number,w:number,h:number,shots:Array<{startFrame:number,frames:number}>}> }} [opts]
 */
async function buildCutTimeline(event, opts = {}) {
  const { name, source, clips } = opts;
  // Mode : 'new' (défaut, crée une timeline découpée à côté de l'originale) ou 'replace' → UNE SEULE
  // timeline : on construit la découpe, on SUPPRIME l'originale, puis on renomme la nouvelle au nom de
  // l'originale (évite le doublon encombrant). L'API ne coupe pas EN PLACE dans une timeline existante.
  const mode = opts.mode === "replace" ? "replace" : "new";
  try {
  if (!clips || !clips.length) return { ok: false, error: t("noBuildShots") };
    const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject") };

    const buildProg = (pct) => { if (event?.sender) event.sender.send("timelinecut:progress", { file: "", done: 1, total: 1, pct, phase: "build" }); };
    buildProg(0);
    const mp = await proj.GetMediaPool();
    // Nom unique PRÉ-calculé → l'import FCPXML reçoit un nom libre (sinon Resolve suffixe au hasard).
    // En mode 'replace', on utilise un nom TEMPORAIRE (l'originale porte encore son nom) puis on renomme.
    const rawBase = mode === "replace" && source
      ? `${source} — découpé (tmp)`
      : ((name && String(name).trim()) || (source ? `${source} — découpé` : "NetsuRush — découpé"));
    const baseName = await uniqueTimelineName(proj, rawBase);

    // Normalise : fps re-rationalisé si l'éditeur a renvoyé un nombre, plans vides écartés.
    const fcpClips = clips
      .map((c) => ({
        src: c.src, name: c.name,
        fps: (c.fps && typeof c.fps === "object" && c.fps.num) ? c.fps : fpsRational(c.fps),
        totalFrames: c.totalFrames, w: c.w, h: c.h,
        shots: (c.shots || []).filter((s) => s && s.frames > 0),
      }))
      .filter((c) => c.shots.length);
  if (!fcpClips.length) return { ok: false, error: t("noUsableClips") };

    const shotsTotal = fcpClips.reduce((a, c) => a + c.shots.length, 0);
    const xml = buildFcpxml({ projectName: baseName, eventName: "NetsuRush", clips: fcpClips });
    const xmlPath = path.join(os.tmpdir(), `netsurush-cut-${Date.now()}.fcpxml`);
    await fsp.writeFile(xmlPath, xml, "utf8");
    buildProg(75);

    let newTl = null;
    try {
      newTl = await mp.ImportTimelineFromFile(xmlPath, { timelineName: baseName });
    } catch (e) {
      return { ok: false, error: "Import FCPXML refusé par Resolve : " + String(e) };
    }
    buildProg(100);
  if (!newTl) return { ok: false, error: t("timelineImportFailed") };

    // Mode 'replace' : on rend la nouvelle timeline courante, on supprime l'originale, puis on renomme
    // la nouvelle au nom de l'originale → une seule timeline, pas de doublon. Best-effort : si la
    // suppression/le renommage échoue, on garde la nouvelle sous son nom temporaire (repli non bloquant).
    let replaced = false;
    if (mode === "replace" && source) {
      try {
        try { await proj.SetCurrentTimeline(newTl); } catch (_) {}
        const orig = await findTimelineByName(proj, source);
        let deleted = false;
        if (orig) { try { deleted = !!(await mp.DeleteTimelines([orig])); } catch (_) { deleted = false; } }
        if (deleted) { try { await newTl.SetName(source); replaced = true; } catch (_) {} }
      } catch (_) { /* repli : la nouvelle reste sous son nom temporaire */ }
    }

    let outName = baseName;
    try { outName = await newTl.GetName(); } catch (_) {}
    return { ok: true, timeline: outName, source, clips: fcpClips.length, shots: shotsTotal, mode, replaced };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Récupère l'objet Timeline du projet par son nom (pour DeleteTimelines / SetCurrentTimeline).
async function findTimelineByName(proj, name) {
  try {
    const count = parseInt(await proj.GetTimelineCount(), 10) || 0;
    for (let i = 1; i <= count; i++) {
      const tl = await proj.GetTimelineByIndex(i);
      if (tl && (await tl.GetName()) === name) return tl;
    }
  } catch (_) { /* introuvable */ }
  return null;
}

// Trouve (ou crée) un sous-dossier de PREMIER niveau du Media Pool par son nom → sert de destination
// « mise de côté » aux timelines/exports. Repli sur la racine si l'API AddSubFolder échoue.
async function ensureBin(mp, name) {
  const root = await mp.GetRootFolder();
  try {
    const subs = (await root.GetSubFolderList()) || [];
    for (const s of subs) { try { if ((await s.GetName()) === name) return s; } catch (_) { /* dossier illisible */ } }
  } catch (_) { /* pas de sous-dossiers */ }
  try { return await mp.AddSubFolder(root, name); } catch (_) { return root; }
}

// Découpe directe (sans édition) = analyse + build. Réutilisée en lot (une timeline découpée par
// source sélectionnée). L'éditeur de coupes appelle analyzeTimelineCut puis buildCutTimeline.
/**
 * @param {any} event
 * @param {{ timelineName?: string, model?: string, threshold?: number, detectionOptions?: Record<string, any>, name?: string, mode?: string }} [opts]
 */
async function cutTimeline(event, opts = {}) {
  const a = await analyzeTimelineCut(event, opts);
  if (!a.ok) return a;
  return buildCutTimeline(event, { name: opts.name, source: a.source, clips: a.clips, mode: opts.mode });
}

module.exports = { buildTimeline, buildTimelineFromBlocks, listTimelines, timelineTree, timelineThumbs, readTimelineCuts, analyzeTimelineCut, buildCutTimeline, cutTimeline, uniqueTimelineName, sanitizeTimelineName, getTimelineByName };
