// @ts-check
// Briques communes aux deux voies d'écriture Resolve (import de fichier et pose par l'API) :
// ouverture du projet, résolution des sources, pistes, réconciliation des plans posés.

const fs = require("fs");
const { getResolve, findItemByPath } = require("../resolve");
const { trackCounts } = require("./doc");
const { timelineSnapshots, locateResolveClip, uniqueIdOf } = require("./resolveLocate");
const { t } = require("../i18n");

function formatFrameRate(fps) {
  const value = Number(fps);
  if (!(value > 0)) return "24";
  return value.toFixed(3).replace(/\.?0+$/, "");
}

/** @returns {Promise<{ ok:true, resolve:any, project:any, mediaPool:any, root:any } | { ok:false, error:string }>} */
async function openProject() {
  const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveUnavailable") };
  const projectManager = await resolve.GetProjectManager();
  const project = projectManager ? await projectManager.GetCurrentProject() : null;
  if (!project) return { ok: false, error: t("noProject") };
  const mediaPool = await project.GetMediaPool();
  const root = await mediaPool.GetRootFolder();
  return { ok: true, resolve, project, mediaPool, root };
}

/**
 * Porte la timeline à `count` pistes. Pour l'audio, le sous-type est tenté EXPLICITEMENT : selon la
 * version, `AddTrack("audio")` sans sous-type ne crée rien et rend `false` — la timeline restait
 * alors à une seule piste et tous les plans audio s'écrasaient dessus.
 */
async function ensureTracks(timeline, type, count) {
  let have = parseInt(await timeline.GetTrackCount(type), 10) || 0;
  while (have < count) {
    let added = false;
    if (type === "audio") {
      try { added = !!(await timeline.AddTrack(type, "stereo")); } catch (_) { added = false; }
    }
    if (!added) {
      try { added = !!(await timeline.AddTrack(type)); } catch (_) { added = false; }
    }
    if (!added) break;
    have = parseInt(await timeline.GetTrackCount(type), 10) || have + 1;
  }
  return have;
}

/** Dernière frame occupée, tous types de pistes confondus. `GetEndFrame` décrit la timeline, pas son contenu. */
async function contentEndFrame(timeline, counts, fallback) {
  let end = fallback;
  for (const kind of ["video", "audio"]) {
    for (let track = 1; track <= (counts[kind] || 0); track++) {
      let items = [];
      try { items = (await timeline.GetItemListInTrack(kind, track)) || []; } catch (_) { items = []; }
      for (const item of items) {
        try {
          const value = parseInt(await item.GetEnd(), 10);
          if (Number.isFinite(value) && value > end) end = value;
        } catch (_) { /* item sans bornes lisibles : il ne déplace pas la fin */ }
      }
    }
  }
  return end;
}

function createSourceResolver(resolve, root) {
  const cache = new Map();
  const missing = [];
  return {
    missing,
    async get(filePath) {
      if (cache.has(filePath)) return cache.get(filePath);
      let item = await findItemByPath(root, filePath);
      if (!item) {
        try {
          const storage = await resolve.GetMediaStorage();
          const added = await storage.AddItemListToMediaPool([filePath]);
          if (added && added.length) item = added[0];
        } catch (error) {
          console.warn("[transfer] import Media Pool impossible :", filePath, error && error.message);
        }
      }
      if (!item) missing.push(filePath);
      cache.set(filePath, item || null);
      return item || null;
    },
  };
}

function clipHasProperties(clip) {
  const timing = clip.timing;
  return !!(clip.video || clip.audio || (timing && (timing.reverse || timing.freeze
    || (timing.timeMap && timing.timeMap.length)
    || (timing.speed && timing.speed.numerator !== timing.speed.denominator))));
}

/** Plans dont le fichier n'est plus sur le disque : jamais envoyés à un importeur, qui ouvrirait une modale. */
function splitMissingMedia(clips) {
  const missing = [];
  const usable = clips.filter((clip) => {
    if (fs.existsSync(clip.path)) return true;
    if (missing.indexOf(clip.path) < 0) missing.push(clip.path);
    return false;
  });
  return { usable, missing };
}

/** Constat de pose : ce que la réconciliation a réellement vérifié sur la timeline. */
function placementReports(clipIndex, located) {
  if (!located.ok) {
    return [{ clip: clipIndex, property: "clip.media", status: "unsupported", reason: located.reason, readback: false }];
  }
  return ["clip.media", "clip.trim", "clip.position", "clip.track"]
    .map((property) => ({ clip: clipIndex, property, status: "applied", readback: true }));
}

module.exports = {
  formatFrameRate, openProject, ensureTracks, contentEndFrame, createSourceResolver,
  clipHasProperties, splitMissingMedia, placementReports, trackCounts,
  timelineSnapshots, locateResolveClip, uniqueIdOf,
};
