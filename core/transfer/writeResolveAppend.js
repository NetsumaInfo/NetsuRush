// @ts-check
// Pose d'un document DANS Resolve par l'API, plan par plan et à positions absolues. Voie de REPLI de
// l'import de fichier (et seule voie possible pour ajouter à une timeline existante) : elle ne sait
// poser aucune image clé, l'API n'en exposant pas l'écriture.

const { uniqueTimelineName, sanitizeTimelineName, getTimelineByName } = require("../timeline");
const { yieldLoop } = require("../config");
const { resolvePlacement } = require("./doc");
const { applyResolveClip } = require("./resolveApply");
const { applyFusionAnimation } = require("./fusion/apply");
const { clipIsAnimated } = require("./fusion/compText");
const { placeTitles } = require("./resolveTitles");
const {
  formatFrameRate, openProject, ensureTracks, contentEndFrame, createSourceResolver,
  clipHasProperties, placementReports, trackCounts, timelineSnapshots, locateResolveClip, uniqueIdOf,
} = require("./writeResolveShared");
const { t } = require("../i18n");

/**
 * `AppendToTimeline` rend la LISTE des items créés. Un tableau VIDE est un échec — et un tableau
 * vide est `truthy` en JS : le tester tel quel comptait les refus comme des poses réussies, ce qui
 * faisait disparaître des plans sans qu'aucun compteur ne bouge.
 */
async function appendSingle(mediaPool, info, name) {
  try {
    const raw = await mediaPool.AppendToTimeline([info]);
    if (Array.isArray(raw)) return { ok: raw.length > 0, item: raw.length === 1 ? raw[0] : null };
    return { ok: !!raw, item: null };
  } catch (error) {
    console.warn("[transfer] plan refusé par Resolve :", name, error && error.message);
    return { ok: false, item: null };
  }
}

/**
 * Une pose refusée est retentée en relâchant les contraintes, de la plus stricte à la plus lâche.
 * Resolve refuse en silence selon la version : `mediaType` sur une source sans le flux demandé,
 * ou `trackIndex` sur une piste au mauvais sous-type. Mieux vaut un plan posé un cran plus bas
 * qu'un plan absent — chaque relâchement est rapporté.
 */
async function appendWithFallbacks(mediaPool, mediaPoolItem, placement, name) {
  const attempts = [
    { placement, relaxed: null },
    { placement: { ...placement, trackIndex: undefined }, relaxed: "trackIgnored" },
    { placement: { ...placement, mediaType: undefined }, relaxed: "mediaTypeIgnored" },
  ];
  for (const attempt of attempts) {
    const info = { ...attempt.placement, mediaPoolItem };
    for (const key of Object.keys(info)) if (info[key] === undefined) delete info[key];
    const result = await appendSingle(mediaPool, info, name);
    if (result.ok) return { ...result, relaxed: attempt.relaxed };
  }
  return { ok: false, item: null, relaxed: null };
}

/**
 * Longueur RÉELLE d'une source, telle que Resolve la compte. Premiere n'expose pas la sienne
 * (`srcFrames` vaut 0) et exprime l'audio dans sa propre base de temps : une borne de sortie au-delà
 * de la fin du média est refusée EN SILENCE par `AppendToTimeline`. Resolve est le seul des deux à
 * connaître ce nombre, c'est donc ici qu'il faut ramener les bornes.
 */
async function sourceLength(item, cache, path) {
  if (cache.has(path)) return cache.get(path);
  let frames = 0;
  try { frames = parseInt(await item.GetClipProperty("Frames"), 10) || 0; } catch (_) { frames = 0; }
  cache.set(path, frames);
  return frames;
}

/**
 * `frames <= 1` n'est PAS une longueur : Resolve ne compte pas un média audio en images et rend
 * couramment 0 ou 1. La croire ramènerait tout plan sonore à une seule frame — exactement le plan
 * d'une frame que `AppendToTimeline` refuse ensuite. Un vrai média d'une image ne se transfère pas.
 */
function clampToSource(placement, frames) {
  if (!(frames > 1)) return { placement, clamped: false };
  const endFrame = Math.min(placement.endFrame, frames - 1);
  const startFrame = Math.max(0, Math.min(placement.startFrame, endFrame));
  const clamped = endFrame !== placement.endFrame || startFrame !== placement.startFrame;
  return { placement: { ...placement, startFrame, endFrame }, clamped };
}

/**
 * Resolve refuse sans rien dire. Le journal porte donc TOUT ce qui a servi à construire la requête :
 * un plan absent de la timeline ne laisse sinon aucune trace de la raison de son absence, et c'est
 * la seule chose qui distingue une borne fausse d'un média que Resolve n'accepte pas.
 */
function logRefusal(clip, placement, sourceFrames) {
  console.warn("[transfer] pose refusée par Resolve :", clip.name || clip.path, JSON.stringify({
    requete: placement,
    resolveFrames: sourceFrames === undefined ? null : sourceFrames,
    document: {
      kind: clip.kind, track: clip.track, fps: clip.fps,
      srcIn: clip.srcIn, srcOut: clip.srcOut, srcFrames: clip.srcFrames,
      tlStart: clip.tlStart, tlEnd: clip.tlEnd, trimExactness: clip.trimExactness || null,
    },
  }));
}

/**
 * Inventaire de CE QUE LE DOCUMENT PORTE, plan par plan. Le rapport de fidélité ne compte que des
 * statuts : il ne dit pas si une propriété absente du résultat manquait déjà à la lecture. Sans
 * cette ligne, « le zoom n'est pas passé » ne distingue pas un hôte qui n'a rien rendu d'un hôte
 * cible qui a refusé l'écriture.
 */
function logClipInventory(clips) {
  const inventory = clips.map((clip, index) => {
    const transform = (clip.video && clip.video.transform) || {};
    const audio = clip.audio || {};
    const named = (group, keys) => keys
      .filter((key) => group[key])
      .map((key) => (Array.isArray(group[key].keyframes) && group[key].keyframes.length
        ? `${key}*${group[key].keyframes.length}`
        : key));
    return {
      i: index,
      name: clip.name || clip.path,
      kind: clip.kind,
      video: named(transform, ["position", "scale", "anchor", "rotation", "opacity", "flipX", "flipY"]),
      audio: named(audio, ["gainDb", "volume", "pan", "mute"]),
    };
  });
  console.log("[transfer] propriétés LUES chez la source (`nom*N` = N images clés) :", JSON.stringify(inventory));
}

/** Origine des images clés du document : sans elle, « rien d'animé » et « rien lu » se confondent. */
function logAnimationSource(doc) {
  const animation = doc.animation;
  if (!animation) return;
  if (animation.available) {
    console.log(`[transfer] animations lues dans l'export de l'hôte : ${animation.clips || 0} plan(s)`
      + `${animation.unpaired ? `, ${animation.unpaired} non apparié(s)` : ""}`);
    return;
  }
  console.warn("[transfer] aucune animation lue :", animation.reason || "raison inconnue");
}

async function createTarget(project, mediaPool, doc, opts) {
  let timeline = null;
  let created = false;
  let name = sanitizeTimelineName(opts.name || doc.timeline || "NetsuRush");
  if (opts.mode === "append") {
    timeline = opts.timelineName ? await getTimelineByName(project, opts.timelineName) : await project.GetCurrentTimeline();
    if (opts.timelineName && !timeline) return { ok: false, error: `${t("timelineMissing")}: ${opts.timelineName}` };
  }
  if (!timeline) {
    try { await project.SetSetting("timelineFrameRate", formatFrameRate(doc.fps)); } catch (error) {
      console.warn("[transfer] cadence de timeline non appliquée :", error && error.message);
    }
    name = await uniqueTimelineName(project, name);
    timeline = await mediaPool.CreateEmptyTimeline(name);
    if (!timeline) return { ok: false, error: `${t("timelineCreateFailed")}: ${name}` };
    created = true;
  } else {
    try { name = await timeline.GetName(); } catch (_) { /* nom illisible : on garde celui demandé */ }
  }
  try { await project.SetCurrentTimeline(timeline); } catch (_) { /* la timeline reste montable sans être ouverte */ }
  return { ok: true, timeline, name, created };
}

async function resolveSources(resolve, root, clips, onProgress) {
  const sources = createSourceResolver(resolve, root);
  const items = new Map();
  const paths = [...new Set(clips.map((clip) => clip.path))];
  for (let index = 0; index < paths.length; index++) {
    items.set(paths[index], await sources.get(paths[index]));
    if (onProgress) onProgress({ phase: "sources", done: index + 1, total: paths.length });
    await yieldLoop();
  }
  return { sources, items };
}

/**
 * @param {import('./types').TransferDoc} doc
 * @param {{ name?: string, mode?: 'new'|'append', timelineName?: string, videoOnly?: boolean,
 *   animation?: boolean, onProgress?: (p:{phase:string,done:number,total:number})=>void }} opts
 */
async function appendResolveDoc(doc, opts = {}) {
  const clips = opts.videoOnly ? doc.clips.filter((clip) => clip.kind === "video") : doc.clips;
  if (!clips.length) return { ok: false, error: t("noTransferClips") };

  const opened = await openProject();
  if (!opened.ok) return opened;
  const { resolve, project, mediaPool, root } = opened;
  const { sources, items } = await resolveSources(resolve, root, clips, opts.onProgress);

  const target = await createTarget(project, mediaPool, doc, opts);
  if (!target.ok) return target;
  const timeline = target.timeline;
  const wanted = trackCounts({ ...doc, clips });
  const available = {
    video: wanted.video ? await ensureTracks(timeline, "video", wanted.video) : 0,
    audio: wanted.audio ? await ensureTracks(timeline, "audio", wanted.audio) : 0,
  };
  const tracksClamped = available.video < wanted.video || available.audio < wanted.audio;
  const timelineStart = parseInt(await timeline.GetStartFrame(), 10) || 0;
  // Ajout à une timeline déjà montée : le document part de 0, il se pose APRÈS le contenu existant.
  // Le poser à sa position absolue l'écraserait — c'est ce que font déjà les écrivains Adobe.
  const origin = target.created ? timelineStart : await contentEndFrame(timeline, available, timelineStart);

  const placedRecords = [];
  const skipped = [];
  const failed = [];
  const relaxed = [];
  const trimmed = [];
  const sourceFrames = new Map();

  if (opts.onProgress) opts.onProgress({ phase: "build", done: 0, total: clips.length });
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const mediaPoolItem = items.get(clip.path);
    if (!mediaPoolItem) { skipped.push(clip.path); continue; }
    const placement = resolvePlacement(clip, origin);
    const ceiling = available[clip.kind] || 1;
    const bounded = clampToSource(
      { ...placement, trackIndex: Math.min(placement.trackIndex, ceiling) },
      await sourceLength(mediaPoolItem, sourceFrames, clip.path),
    );
    const finalPlacement = bounded.placement;
    if (bounded.clamped) trimmed.push({ clip: index, reason: "sourceLengthClamped" });
    const appended = await appendWithFallbacks(mediaPool, mediaPoolItem, finalPlacement, clip.name);
    if (!appended.ok) {
      failed.push(clip.name || String(index + 1));
      logRefusal(clip, finalPlacement, sourceFrames.get(clip.path));
    } else {
      if (appended.relaxed) relaxed.push({ clip: index, reason: appended.relaxed });
      // L'identité est lue TOUT DE SUITE : c'est le seul lien fiable entre l'objet rendu par
      // l'append et celui relu plus tard sur la timeline (le proxy en fabrique un neuf à chaque fois).
      placedRecords.push({
        clip, clipIndex: index, placement: finalPlacement,
        nativeId: await uniqueIdOf(appended.item),
      });
    }
    if (opts.onProgress) opts.onProgress({ phase: "build", done: index + 1, total: clips.length });
    await yieldLoop();
  }

  logClipInventory(clips);
  logAnimationSource(doc);
  const reportItems = [];
  let animatedClips = 0;
  if (placedRecords.length) {
    const snapshots = await timelineSnapshots(timeline, available);
    const dimensions = { width: doc.width, height: doc.height };
    for (const record of placedRecords) {
      const located = locateResolveClip(snapshots, record.clip, record.placement, record.nativeId);
      reportItems.push(...placementReports(record.clipIndex, located));
      if (!located.ok || !clipHasProperties(record.clip)) continue;
      /** @type {{ ok:true, verified:boolean } | { ok:false, reason:string }} */
      const animation = opts.animation === false
        ? { ok: false, reason: "fusionDisabled" }
        : await applyFusionAnimation(located.item, record.clip, dimensions);
      if (animation.ok === true) {
        animatedClips += 1;
        // Import ACCEPTÉ mais relecture négative : la comp est partie, Resolve ne l'a pas gardée.
        // Sans ce constat, un plan sans animation se lit exactement comme un plan animé dans le
        // rapport — c'est le cas « ça a marché sur un seul rush » qu'on ne pouvait pas expliquer.
        if (animation.ok === true && animation.verified === false) {
          console.warn("[transfer] comp Fusion posée mais NON confirmée à la relecture :", record.clip.name);
        }
      } else if (clipIsAnimated(record.clip)) {
        // Fusion est la SEULE écriture d'image clé côté Resolve : son refus explique à lui seul tout
        // `resolveKeyframeWriteUnavailable` du rapport, et sans sa raison on ne peut rien en faire.
        console.warn("[transfer] comp Fusion non posée :", record.clip.name,
          animation.ok === false ? animation.reason : "raison inconnue");
      }
      const applied = await applyResolveClip(located.item, record.clip, record.clipIndex, {
        mode: "write", animationCarried: animation.ok === true,
      });
      const refused = applied.filter((item) => item.status !== "applied");
      if (refused.length) {
        console.warn("[transfer] propriétés refusées par Resolve :", record.clip.name,
          JSON.stringify(refused.map((item) => `${item.property}=${item.status}${item.reason ? `(${item.reason})` : ""}`
            // La valeur demandée dit si Resolve bute sur la propriété ou sur son contenu.
            + (item.expected === undefined ? "" : ` [${JSON.stringify(item.expected)}]`))));
      }
      reportItems.push(...applied);
    }
  }

  // Les titres après les plans : chaque insertion bouge la tête de lecture, et un titre posé avant
  // le montage se retrouverait recouvert par les plans qui viennent ensuite.
  // `origin`, pas le début de la timeline : en mode ajout les titres suivent les plans, sinon ils
  // se poseraient sur le montage déjà en place.
  const titleReport = await placeTitles(timeline, doc.graphics || [], {
    startFrame: origin, fps: doc.fps, timeline: { width: doc.width, height: doc.height },
  });
  if (titleReport.failed.length) {
    console.warn("[transfer] titres non posés :", JSON.stringify(titleReport.failed));
  }

  const placed = placedRecords.length;
  return {
    ok: placed > 0,
    vehicle: "api",
    timeline: target.name,
    count: placed,
    titles: titleReport.placed || undefined,
    titlesRetimed: titleReport.retimed || undefined,
    titlesFailed: titleReport.failed.length || undefined,
    animatedClips: animatedClips || undefined,
    created: target.created,
    tracksClamped: tracksClamped || undefined,
    relaxed: relaxed.length ? relaxed : undefined,
    trimmed: trimmed.length ? trimmed : undefined,
    skipped: skipped.length ? skipped : undefined,
    failed: failed.length ? failed : undefined,
    missing: sources.missing.length ? sources.missing : undefined,
    report: { items: reportItems },
    error: placed > 0 ? undefined : `${t("timelineAppendFailed")}: ${target.name}`,
  };
}

module.exports = { appendResolveDoc, appendSingle, appendWithFallbacks, clampToSource, createTarget };
