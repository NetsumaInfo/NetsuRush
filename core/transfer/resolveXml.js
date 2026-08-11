// @ts-check
// Extraction des métadonnées d'ANIMATION d'une timeline Resolve, via l'export FCP7 XML que Resolve
// produit lui-même. L'API de script ne lit aucune image clé sur les propriétés d'un plan (vérifié
// jusqu'à l'API v21) : c'est la seule sortie qui les porte.
//
// Le fichier ne sert QU'À ÇA. Il ne construit aucune timeline : la structure du transfert reste
// celle lue par l'API, et c'est le script de l'hôte cible qui écrit le montage.

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const { readAttribute } = require("../resolve-proxy");
const { parseXmeml } = require("./xmeml");

/** Constante d'export Resolve, lue sur l'objet racine : sa valeur change selon la version. */
async function exportConstant(resolve, name) {
  try {
    const value = await readAttribute(resolve, name);
    return typeof value === "number" || typeof value === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

function tempXmlPath() {
  return path.join(os.tmpdir(), `netsurush-anim-${Date.now()}-${Math.floor(Math.random() * 1e6)}.xml`);
}

async function removeQuietly(filePath) {
  try { await fsp.unlink(filePath); } catch (_) { /* fichier déjà absent : rien à signaler */ }
}

/**
 * Écrit l'export FCP7 XML de la timeline et RENVOIE son chemin. Le fichier survit à l'appel : c'est
 * lui que Premiere importe quand le transfert emprunte la voie native (seule voie qui pose un titre,
 * qu'aucune API Premiere ne sait créer).
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: string }>}
 */
async function exportTimelineXml(resolve, timeline) {
  const exportType = await exportConstant(resolve, "EXPORT_FCP_7_XML");
  if (exportType === null) return { ok: false, reason: "exportConstantMissing" };
  const filePath = tempXmlPath();
  let exported = false;
  try { exported = !!(await timeline.Export(filePath, exportType)); } catch (_) { exported = false; }
  if (!exported) { await removeQuietly(filePath); return { ok: false, reason: "timelineExportRefused" }; }
  return { ok: true, path: filePath };
}

/**
 * Timeline Resolve → document lu depuis son propre export FCP7 XML.
 * @returns {Promise<{ ok: true, doc: import('./types').TransferDoc } | { ok: false, reason: string }>}
 */
async function readTimelineXml(resolve, timeline) {
  const written = await exportTimelineXml(resolve, timeline);
  if (written.ok !== true) return written;
  const filePath = written.path;
  let source = "";
  try { source = await fsp.readFile(filePath, "utf8"); } catch (_) { source = ""; }
  await removeQuietly(filePath);
  if (!source) return { ok: false, reason: "timelineExportEmpty" };
  const read = parseXmeml(source, { host: "resolve" });
  if (read.ok !== true) return { ok: false, reason: read.error };
  return { ok: true, doc: read };
}

module.exports = { readTimelineXml, exportTimelineXml, exportConstant };
