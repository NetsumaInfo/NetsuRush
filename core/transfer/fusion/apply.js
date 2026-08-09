// @ts-check
// Pose d'une composition Fusion animée sur un plan de timeline Resolve, et RELECTURE de ce qui a
// été posé. Seul point d'entrée d'écriture d'animation côté Resolve.
//
// Chaque étape est vérifiée : la comp est relue après import et la greffe doit s'y retrouver. Un
// échec ne fait rien perdre — l'appelant retombe sur la valeur FIXE via `SetProperty`, c'est-à-dire
// le comportement d'avant, et le rapport de fidélité le dit.

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const { buildAnimatedComp, skeletonHasAnimation, clipIsAnimated } = require("./compText");

const COMP_EXTENSION = ".comp";

function tempCompPath(suffix) {
  return path.join(os.tmpdir(), `netsurush-fusion-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${COMP_EXTENSION}`);
}

async function removeQuietly(filePath) {
  try { await fsp.unlink(filePath); } catch (_) { /* fichier déjà absent : rien à signaler */ }
}

async function readQuietly(filePath) {
  try { return await fsp.readFile(filePath, "utf8"); } catch (_) { return ""; }
}

async function compCount(item) {
  try { return parseInt(await item.GetFusionCompCount(), 10) || 0; } catch (_) { return 0; }
}

/**
 * Squelette de comp que Resolve produit LUI-MÊME pour ce plan. C'est la seule source fiable des
 * noms de nœuds, de la version du format et de la base de temps : les écrire de mémoire les
 * périmerait à la première évolution de Fusion.
 */
async function compNames(item) {
  try {
    const names = await item.GetFusionCompNameList();
    return Array.isArray(names) ? names.map(String) : [];
  } catch (_) { return []; }
}

async function exportSkeleton(item) {
  const before = await compNames(item);
  let count = await compCount(item);
  // `scratch` = comp créée UNIQUEMENT pour obtenir le squelette. Elle est supprimée après l'import,
  // sinon le plan garde une composition vide en plus de la composition animée.
  let scratch = null;
  if (!count) {
    try { await item.AddFusionComp(); } catch (_) { count = 0; }
    count = await compCount(item);
    const added = (await compNames(item)).filter((name) => before.indexOf(name) < 0);
    scratch = added.length === 1 ? added[0] : null;
  }
  if (!count) return /** @type {{ok:false, reason:string, scratch:string|null}} */ ({ ok: false, reason: "fusionCompCreateFailed", scratch });
  const filePath = tempCompPath("skeleton");
  let exported = false;
  try { exported = !!(await item.ExportFusionComp(filePath, count)); } catch (_) { exported = false; }
  const text = exported ? await readQuietly(filePath) : "";
  await removeQuietly(filePath);
  if (!text) return /** @type {{ok:false, reason:string, scratch:string|null}} */ ({ ok: false, reason: "fusionCompExportFailed", scratch });
  return /** @type {{ok:true, text:string, index:number, scratch:string|null}} */ ({ ok: true, text, index: count, scratch });
}

async function deleteScratch(item, name) {
  if (!name) return;
  try { await item.DeleteFusionCompByName(name); } catch (_) { /* comp déjà absente : rien à nettoyer */ }
}

/** La comp réellement enregistrée par Resolve porte-t-elle bien la greffe ? */
async function verifyComp(item) {
  const count = await compCount(item);
  if (!count) return false;
  const filePath = tempCompPath("verify");
  let exported = false;
  try { exported = !!(await item.ExportFusionComp(filePath, count)); } catch (_) { exported = false; }
  const text = exported ? await readQuietly(filePath) : "";
  await removeQuietly(filePath);
  return skeletonHasAnimation(text);
}

/**
 * @param {any} item TimelineItem Resolve
 * @param {import('../types').TransferClip} clip
 * @param {{ width:number, height:number }} timeline
 * @returns {Promise<{ ok:true, verified:boolean } | { ok:false, reason:string }>}
 */
async function applyFusionAnimation(item, clip, timeline) {
  if (!clipIsAnimated(clip)) return { ok: false, reason: "clipNotAnimated" };
  const skeleton = await exportSkeleton(item);
  if (skeleton.ok !== true) {
    await deleteScratch(item, skeleton.scratch);
    return { ok: false, reason: skeleton.reason };
  }
  const built = buildAnimatedComp(skeleton.text, clip, timeline);
  if (built.ok !== true) {
    // Le squelette vient de Resolve : s'il n'est pas lisible, c'est sa FORME qui a changé, et
    // aucune supposition ne remplace le fait de regarder ce qu'il contient vraiment.
    if (built.reason === "fusionSkeletonUnreadable") {
      console.warn("[transfer] squelette Fusion illisible — début du fichier :",
        JSON.stringify(skeleton.text.slice(0, 400)));
    }
    await deleteScratch(item, skeleton.scratch);
    return built;
  }

  const filePath = tempCompPath("animated");
  await fsp.writeFile(filePath, built.text, "utf8");
  const before = await compCount(item);
  let imported = null;
  try { imported = await item.ImportFusionComp(filePath); } catch (_) { imported = null; }
  await removeQuietly(filePath);
  if (!imported) {
    await deleteScratch(item, skeleton.scratch);
    return { ok: false, reason: "fusionCompImportRefused" };
  }
  const verified = await verifyComp(item);
  // La comp de travail ne se supprime QUE si l'import en a créé une AUTRE. Selon la version,
  // `ImportFusionComp` remplace le contenu de la composition courante au lieu d'en ajouter une :
  // la « comp de travail » EST alors la comp animée, et la nettoyer effaçait l'animation qu'on
  // venait de poser — sur les plans qui n'avaient pas déjà une composition à eux.
  if ((await compCount(item)) > before) await deleteScratch(item, skeleton.scratch);
  return { ok: true, verified };
}

module.exports = { applyFusionAnimation, exportSkeleton };
