// @ts-check
// Extraction des métadonnées d'ANIMATION d'une séquence Premiere, via l'export FCP7 XML que
// Premiere produit lui-même (`Sequence.exportAsFinalCutProXML`).
//
// Miroir exact de `resolveXml.js`, et pour la même raison de fond : le snapshot du panneau porte la
// STRUCTURE (chemins, bornes en ticks, pistes), l'export porte l'ANIMATION. Deux raisons de ne pas
// se contenter des `ComponentParam` d'ExtendScript, qui savent pourtant rendre des images clés :
//   1. un composant intrinsèque n'est pas toujours atteignable — un scan qui rend des bornes justes
//      peut rendre `components` vide, et rien ne distingue alors « pas d'animation » de « pas lu » ;
//   2. le XML porte aussi la vitesse et le niveau audio dans une forme unique, déjà analysée par
//      `xmeml/` pour Resolve — un seul analyseur, un seul greffon, des deux côtés du pont.
//
// Le fichier ne construit JAMAIS de timeline : il n'apporte que des images clés.

const os = require("os");
const fs = require("fs");
const path = require("path");
const fsp = require("fs/promises");
const { NR_HOME } = require("../config");
const { parseXmeml } = require("./xmeml");
const { mergeAnimation } = require("./mergeAnimation");

/**
 * Le fichier d'échange vit dans NR_HOME, pas dans le dossier temporaire du système, et porte un
 * nom SIMPLE. Deux raisons : Resolve refuse l'import sans jamais dire pourquoi, et `%TEMP%` avec
 * un nom horodaté cumule deux variables (emplacement, forme du nom) qu'on ne peut pas départager
 * après coup. Un seul fichier réutilisé se retrouve aussi tout seul pour un import manuel.
 */
function tempXmlPath() {
  const dir = path.join(NR_HOME, "transfer");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return path.join(os.tmpdir(), "netsurush-transfer.xml"); }
  return path.join(dir, "netsurush-transfer.xml");
}

async function removeQuietly(filePath) {
  try { await fsp.unlink(filePath); } catch (_) { /* fichier déjà absent : rien à signaler */ }
}

/**
 * Fait écrire à Premiere l'export FCP7 de la séquence et rend le CHEMIN. Le fichier survit à
 * l'appel : c'est aussi celui que Resolve importera, et le relire pour le réécrire n'aurait aucun
 * sens. L'appelant en est responsable.
 * @param {{ exportXml: (filePath: string, timelineName: string|null) => Promise<any> }} host
 * @returns {Promise<{ ok: true, path: string, sequence?: string } | { ok: false, reason: string }>}
 */
async function exportSequenceXml(host, timelineName) {
  const filePath = tempXmlPath();
  let job;
  try {
    job = await host.exportXml(filePath, timelineName || null);
  } catch (error) {
    await removeQuietly(filePath);
    return { ok: false, reason: String((error && error.message) || error) };
  }
  if (!job || job.ok !== true) {
    await removeQuietly(filePath);
    return { ok: false, reason: (job && (job.errorCode || job.error)) || "sequenceExportRefused" };
  }
  return { ok: true, path: filePath, sequence: job.sequence };
}

/**
 * Séquence Premiere → document lu depuis son propre export FCP7 XML.
 * @param {{ exportXml: (filePath: string, timelineName: string|null) => Promise<any> }} host
 * @returns {Promise<{ ok: true, doc: import('./types').TransferDoc } | { ok: false, reason: string }>}
 */
async function readSequenceXml(host, timelineName) {
  const exported = await exportSequenceXml(host, timelineName);
  if (exported.ok !== true) return exported;
  const filePath = exported.path;
  const job = { sequence: exported.sequence };
  let source = "";
  try { source = await fsp.readFile(filePath, "utf8"); } catch (_) { source = ""; }
  await removeQuietly(filePath);
  if (!source) return { ok: false, reason: "sequenceExportEmpty" };
  const read = parseXmeml(source, { host: "ppro", sequenceName: job.sequence || timelineName || "" });
  if (read.ok !== true) return { ok: false, reason: read.error };
  return { ok: true, doc: read };
}

/** Découpage en pistes d'un document, sous la forme `video1:2, audio1:1` — la clé d'appariement. */
function trackShape(doc) {
  const counts = new Map();
  for (const clip of doc.clips || []) {
    const key = `${clip.kind}${clip.track}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return JSON.stringify(Object.fromEntries(counts));
}

/**
 * Greffe les images clés d'un export Premiere sur le document lu du snapshot. Best-effort : un refus
 * d'export laisse le document tel quel (valeurs fixes) plutôt que d'échouer la lecture entière.
 * @param {{ exportXml: (filePath: string, timelineName: string|null) => Promise<any> }} host
 * @param {import('./types').TransferDoc} doc
 */
async function graftPremiereAnimation(host, doc, timelineName) {
  try {
    const read = await readSequenceXml(host, timelineName);
    if (read.ok !== true) return { doc, animation: { available: false, reason: read.reason } };
    const merged = mergeAnimation(doc, read.doc);
    // Aucun plan apparié alors que les deux lectures portent du contenu : les pistes ne se
    // correspondent pas. On montre les deux découpages plutôt que de conclure « pas d'animation ».
    if (!merged.animatedClips && merged.skippedClips.length) {
      console.warn("[transfer] appariement XML impossible — panneau :", trackShape(doc),
        "· export :", trackShape(read.doc));
    }
    return {
      doc: merged.doc,
      animation: { available: true, clips: merged.animatedClips, unpaired: merged.skippedClips.length },
    };
  } catch (error) {
    return { doc, animation: { available: false, reason: String((error && error.message) || error) } };
  }
}

module.exports = { exportSequenceXml, readSequenceXml, graftPremiereAnimation, removeQuietly };
