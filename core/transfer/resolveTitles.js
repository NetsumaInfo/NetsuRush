// @ts-check
// Pose des titres du document dans une timeline Resolve.
//
// `InsertFusionTitleIntoTimeline` est la SEULE écriture de titre de l'API, et elle insère à la TÊTE
// DE LECTURE, sur la piste courante, avec la durée par défaut du modèle. Trois limites qui ne se
// contournent pas : aucune méthode ne déplace un item, n'en change la piste, ni n'en règle la durée.
// NetsuRush pose donc la playhead sur la bonne frame, puis réécrit le contenu du Text+ par la
// composition Fusion — la seule surface où le texte d'un titre est adressable.
//
// ⚠️ Cette insertion est un RIPPLE, pas une pose. Mesuré sur Resolve Studio 21.0.3 : sur une
// timeline de cinq plans, insérer un titre à l'image 5 a COUPÉ le plan sous la tête de lecture et
// décalé tout le reste — les trois pistes vidéo ET les six pistes audio — de la durée du titre.
// Verrouiller les pistes basses n'y change rien, l'insertion est alors simplement refusée. Un titre
// ne s'écrit donc ici QU'AVANT le montage, jamais dans une timeline déjà peuplée : `placeTitles`
// refuse et le rapporte. La voie exacte est ailleurs — traduire le titre en `<generatoritem>` FCP7
// et laisser l'importeur le poser (cf. `xmeml/graphics.js`).
//
// Ce que l'on garantit : position de départ, texte, police, corps, couleur, position à l'écran.
// Ce que l'on ne garantit pas : la DURÉE et la PISTE, rapportées telles quelles à l'appelant.

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const { buildTitleComp, compHasText } = require("./fusion/titleText");

/** Modèle de titre Fusion livré avec Resolve. Aucune API ne liste les titres disponibles. */
const FUSION_TITLE = "Text+";

function tempCompPath(suffix) {
  return path.join(os.tmpdir(), `netsurush-title-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.comp`);
}

async function removeQuietly(filePath) {
  try { await fsp.unlink(filePath); } catch (_) { /* fichier déjà absent : rien à signaler */ }
}

/**
 * Frame absolue → timecode `HH:MM:SS:FF`. `SetCurrentTimecode` n'accepte rien d'autre.
 * Le drop-frame est OBLIGATOIRE sur les cadences NTSC : un timecode non-drop y désigne une autre
 * image dès la première minute, et le titre atterrirait décalé.
 */
function frameToTimecode(frame, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 25;
  const nominal = Math.round(rate);
  const dropFrame = Math.abs(rate - nominal) > 1e-4 && nominal % 30 === 0;
  let position = Math.max(0, Math.round(Number(frame) || 0));
  if (dropFrame) {
    // Deux images sautées par minute et par tranche de 30 i/s, sauf toutes les dix minutes.
    const dropped = 2 * (nominal / 30);
    const perMinute = nominal * 60 - dropped;
    const perTenMinutes = perMinute * 10 + dropped;
    const tenMinuteBlocks = Math.floor(position / perTenMinutes);
    const remainder = position % perTenMinutes;
    position += dropped * 9 * tenMinuteBlocks;
    if (remainder >= dropped) position += dropped * Math.floor((remainder - dropped) / perMinute);
  }
  const frames = position % nominal;
  const totalSeconds = Math.floor(position / nominal);
  const pad = (value) => String(value).padStart(2, "0");
  const hours = pad(Math.floor(totalSeconds / 3600));
  const minutes = pad(Math.floor(totalSeconds / 60) % 60);
  const seconds = pad(totalSeconds % 60);
  // En drop-frame, seul le dernier séparateur est un point-virgule — c'est ce qui distingue les
  // deux notations, et Resolve les lit différemment.
  return `${hours}:${minutes}:${seconds}${dropFrame ? ";" : ":"}${pad(frames)}`;
}

async function compCount(item) {
  try { return parseInt(await item.GetFusionCompCount(), 10) || 0; } catch (_) { return 0; }
}

async function exportComp(item, suffix) {
  const count = await compCount(item);
  if (!count) return "";
  const filePath = tempCompPath(suffix);
  let exported = false;
  try { exported = !!(await item.ExportFusionComp(filePath, count)); } catch (_) { exported = false; }
  let text = "";
  if (exported) {
    try { text = await fsp.readFile(filePath, "utf8"); } catch (_) { text = ""; }
  }
  await removeQuietly(filePath);
  return text;
}

/** Réécrit le Text+ du titre inséré. Un échec laisse le titre par défaut : visible, donc corrigeable. */
async function writeTitleContent(item, graphic, timeline) {
  const skeleton = await exportComp(item, "skeleton");
  if (!skeleton) return { ok: false, reason: "fusionCompExportFailed" };
  const built = buildTitleComp(skeleton, graphic, timeline);
  if (built.ok !== true) return built;

  const filePath = tempCompPath("title");
  await fsp.writeFile(filePath, built.text, "utf8");
  let imported = null;
  try { imported = await item.ImportFusionComp(filePath); } catch (_) { imported = null; }
  await removeQuietly(filePath);
  if (!imported) return { ok: false, reason: "fusionCompImportRefused" };
  return { ok: true, verified: compHasText(await exportComp(item, "verify"), graphic.text), applied: built.applied };
}

/**
 * Pose un titre à sa frame de départ.
 * @returns {Promise<{ ok:true, verified:boolean, durationKept:boolean, reason?:string } | { ok:false, reason:string }>}
 */
async function placeTitle(timeline, graphic, context) {
  const timecode = frameToTimecode(context.startFrame + graphic.tlStart, context.fps);
  let positioned = false;
  try { positioned = !!(await timeline.SetCurrentTimecode(timecode)); } catch (_) { positioned = false; }
  // Sans playhead posée, le titre atterrirait n'importe où : mieux vaut ne rien insérer.
  if (!positioned) return { ok: false, reason: "playheadRefused" };

  let item = null;
  try { item = await timeline.InsertFusionTitleIntoTimeline(FUSION_TITLE); } catch (_) { item = null; }
  if (!item) return { ok: false, reason: "titleInsertRefused" };

  const written = await writeTitleContent(item, graphic, context.timeline);
  let duration = 0;
  try { duration = parseInt(await item.GetDuration(), 10) || 0; } catch (_) { duration = 0; }
  return {
    ok: true,
    verified: written.ok === true && written.verified === true,
    // La durée du modèle n'est pas réglable : on la rapporte plutôt que de la taire.
    durationKept: duration === graphic.tlEnd - graphic.tlStart,
    reason: written.ok === true ? undefined : written.reason,
  };
}

/** La timeline porte-t-elle déjà quelque chose qu'une insertion en ripple déplacerait ? */
async function hasContent(timeline) {
  for (const kind of ["video", "audio"]) {
    let tracks = 0;
    try { tracks = parseInt(await timeline.GetTrackCount(kind), 10) || 0; } catch (_) { tracks = 0; }
    for (let track = 1; track <= tracks; track++) {
      let items = [];
      try { items = (await timeline.GetItemListInTrack(kind, track)) || []; } catch (_) { items = []; }
      if (items.length) return true;
    }
  }
  return false;
}

/**
 * Pose tous les titres du document. Best-effort et SÉQUENTIEL : chaque insertion bouge la tête de
 * lecture, deux poses concurrentes se marcheraient dessus.
 * @param {any} timeline Timeline Resolve
 * @param {import('./types').TransferGraphic[]} graphics
 */
async function placeTitles(timeline, graphics, context) {
  const report = { placed: 0, verified: 0, retimed: 0, failed: [] };
  if (!Array.isArray(graphics) || !graphics.length) return report;
  // Une timeline déjà peuplée ne survivrait pas au ripple : mieux vaut aucun titre qu'un montage
  // décousu, d'autant que le premier se rattrape à la main et pas le second.
  if (await hasContent(timeline)) {
    for (const graphic of graphics) {
      report.failed.push({ name: graphic.name || graphic.text, reason: "insertWouldRippleTimeline" });
    }
    return report;
  }
  let restore = null;
  try { restore = await timeline.GetCurrentTimecode(); } catch (_) { restore = null; }

  for (const graphic of graphics) {
    const result = await placeTitle(timeline, graphic, context);
    if (result.ok !== true) { report.failed.push({ name: graphic.name || graphic.text, reason: result.reason }); continue; }
    report.placed += 1;
    if (result.verified) report.verified += 1;
    if (!result.durationKept) report.retimed += 1;
  }
  // La tête de lecture appartient à l'utilisateur : on la remet où on l'a trouvée.
  if (restore) { try { await timeline.SetCurrentTimecode(restore); } catch (_) { /* position perdue, sans conséquence */ } }
  return report;
}

module.exports = { placeTitles, placeTitle, frameToTimecode, FUSION_TITLE };
