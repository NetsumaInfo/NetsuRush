// @ts-check
// Sérialise un résultat d'outil pour le RENVOYER AU MODÈLE (pas pour l'UI). Plafonne la taille : une
// liste (Media Pool de 1000 clips, markers en masse…) gonflerait le contexte LLM et coûterait des
// tokens inutiles. On tronque à un budget de caractères en signalant la coupe au modèle.
const MAX = 8000;

/** @param {any} r @param {number} [max] @returns {string} */
function toToolContent(r, max = MAX) {
  let s;
  try { s = typeof r === 'string' ? r : JSON.stringify(r); }
  catch { s = String(r); }
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[résultat tronqué : ${s.length} caractères au total]`;
}

module.exports = { toToolContent };
