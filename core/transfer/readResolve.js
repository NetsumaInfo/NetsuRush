// @ts-check
// Lecture d'une timeline Resolve en document d'échange. Le parcours de pistes, la frame-math source
// (freeze/reverse/retime) et l'aplatissement des timelines imbriquées sont déjà résolus par
// `readTimelineEdit` : on ne réimplémente rien, on ne fait que projeter son résultat, puis on greffe
// les images clés que seul l'export XML de Resolve sait rendre.

const { readTimelineEdit } = require("../ae/timelineRead");
const { docFromResolveEdit, normalizeDoc } = require("./doc");
const { readResolveProperties } = require("./readResolveProperties");
const { readTimelineXml } = require("./resolveXml");
const { mergeAnimation } = require("./mergeAnimation");

/** Timeline visée, ou celle ouverte. Même parcours que `readTimelineEdit`, sur son objet natif. */
async function findTimeline(project, timelineName) {
  if (timelineName) {
    const count = parseInt(await project.GetTimelineCount(), 10) || 0;
    for (let index = 1; index <= count; index++) {
      const timeline = await project.GetTimelineByIndex(index);
      if (timeline && (await timeline.GetName()) === timelineName) return timeline;
    }
  }
  return project.GetCurrentTimeline();
}

/**
 * Images clés du montage, via l'export FCP7 XML que Resolve produit lui-même. Best-effort : un
 * refus d'export laisse le document tel quel (transforms fixes) plutôt que d'échouer la lecture.
 */
async function graftAnimation(resolve, doc, timelineName) {
  try {
    const projectManager = await resolve.GetProjectManager();
    const project = projectManager ? await projectManager.GetCurrentProject() : null;
    const timeline = project ? await findTimeline(project, timelineName) : null;
    if (!timeline) return { doc, animation: { available: false, reason: "timelineMissing" } };
    const read = await readTimelineXml(resolve, timeline);
    if (read.ok !== true) return { doc, animation: { available: false, reason: read.reason } };
    const merged = mergeAnimation(doc, read.doc);
    return {
      doc: merged.doc,
      animation: { available: true, clips: merged.animatedClips, unpaired: merged.skippedClips.length },
    };
  } catch (error) {
    return { doc, animation: { available: false, reason: String((error && error.message) || error) } };
  }
}

/**
 * @param {any} resolve objet Resolve (proxy du pont Python)
 * @param {string|null} timelineName timeline visée ; null = celle ouverte
 * @returns {Promise<import('./types').TransferRead>}
 */
async function readResolveDoc(resolve, timelineName) {
  // 'flatten' + aucun dossier de sortie : la lecture reste PASSIVE (aucun rendu Resolve déclenché),
  // et les plans d'une timeline imbriquée remontent comme des plans ordinaires du parent.
  const edit = await readTimelineEdit(resolve, timelineName, {
    nestedMode: "flatten",
    // Writers posent la vidéo et l'audio séparément. Supprimer ici le son lié rendrait le transfert muet.
    includeLinkedAudio: true,
  });
  if (edit.ok !== true) return { ok: false, error: String(edit.error) };
  const doc = docFromResolveEdit(edit);
  let documentIndex = 0;
  for (const sourceItem of edit.items) {
    if (!sourceItem || !sourceItem.path) continue;
    const clip = doc.clips[documentIndex++];
    if (!clip || !sourceItem.nativeItem) continue;
    const properties = await readResolveProperties(sourceItem.nativeItem, clip.kind);
    if (properties.nativeId) clip.identity.nativeId = properties.nativeId;
    if (properties.audio) clip.audio = properties.audio;
  }
  const normalized = normalizeDoc(doc);
  const grafted = await graftAnimation(resolve, normalized, timelineName);
  return { ...grafted.doc, animation: grafted.animation };
}

module.exports = { readResolveDoc, graftAnimation };
