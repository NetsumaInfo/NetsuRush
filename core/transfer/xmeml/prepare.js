// @ts-check
// Met un export FCP7 en état d'être importé par la cible. Fonction PURE.
//
// Deux retouches, chacune corrigeant un défaut MESURÉ de l'aller Premiere → Resolve :
// les éléments sans média (cf. `graphics.js`), qui font échouer l'import entier en silence, et les
// canaux audio éclatés (cf. `audioChannels.js`), qui doublent chaque son stéréo.
//
// Rien d'autre n'est touché : le document reste celui que l'hôte source a écrit, images clés et
// niveaux audio compris — c'est tout l'intérêt de laisser l'importeur de la cible faire le travail.

const { extractGraphics } = require("./graphics");
const { collapseAudioChannels } = require("./audioChannels");

/**
 * @param {string} source contenu du fichier XML
 * @returns {{ text: string, graphics: import('../types').TransferGraphic[],
 *             titles: number, dropped: number, channels: number }}
 */
function prepareForImport(source) {
  const extracted = extractGraphics(source);
  const collapsed = collapseAudioChannels(extracted.text);
  return { ...extracted, text: collapsed.text, channels: collapsed.channels };
}

module.exports = { prepareForImport };
