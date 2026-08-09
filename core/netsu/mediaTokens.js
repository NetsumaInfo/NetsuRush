// @ts-check
// core/netsu/mediaTokens.js
// Traduction des URL de médias écrites DANS les blocs d'une page ⇄ tokens portables.
//
// Le Carnet ne référence pas ses médias dans une colonne : l'URL est enfouie dans le JSON des blocs
// BlockNote (`http://127.0.0.1:8730/media?p=<chemin absolu>&tk=…`). Telle quelle, elle contient un
// chemin ABSOLU et un port — deux choses qui ne survivent pas au déplacement du projet ni au
// changement de port du core. Un carnet déplacé d'un dossier à l'autre perdait donc ses images.
//
// À l'écriture on remplace donc l'URL par `netsu-asset://<nom de fichier>` (vocabulaire du .netsu
// v1, déjà employé par core/nbfile.js) et à la lecture on la reconstruit depuis le dossier courant
// et le gabarit d'URL fourni par le renderer — lui seul connaît sa base et son jeton.
//
// Les deux sens vivent ICI, côte à côte : séparés, ils finiraient par ne plus se répondre.

const path = require('node:path');

// URL /media telle que persistée dans les blocs (échappée JSON : ni " ni \ dedans).
const MEDIA_URL_RE = /https?:\/\/[^"\\\s]*\/media\?p=([^&"\\\s]+)[^"\\\s]*/g;
// Token portable. Le nom de fichier est capturé largement : les assets du Carnet sont nommés par
// empreinte md5 (32 hex), ceux du .netsu v1 par sha256 (64) — une regex sur une seule longueur
// laisserait passer l'autre sans rien dire.
const TOKEN_RE = /(?:netsu|nrnote)-asset:\/\/([^"\\\s/?#]+)/g;

/** @param {string} value @returns {string} */
function decodePath(value) {
  try { return path.resolve(decodeURIComponent(value)); } catch (_) { return ''; }
}

/** Un chemin est-il sous ce dossier ? (comparaison insensible à la casse : Windows) */
function isUnder(rootDir, filePath) {
  const root = path.resolve(rootDir).toLowerCase();
  const abs = String(filePath || '').toLowerCase();
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * URL /media d'un média du dossier → token portable. Les médias HORS du dossier (rush posé depuis
 * ailleurs sur la machine) gardent leur URL : ce ne sont pas des fichiers du projet.
 * @param {string} json @param {string} rootDir
 */
function collapse(json, rootDir) {
  return String(json ?? '').replace(MEDIA_URL_RE, (url, encoded) => {
    const abs = decodePath(encoded);
    if (!abs || !isUnder(rootDir, abs)) return url;
    return `netsu-asset://${path.basename(abs)}`;
  });
}

/**
 * Token → URL /media, reconstruite depuis le dossier COURANT du projet. Sans gabarit d'URL
 * (renderer pas encore passé par là), le token est laissé tel quel plutôt que d'être transformé en
 * URL fausse : un média non résolu se voit, un média résolu vers le mauvais port ne se diagnostique pas.
 * @param {string} json @param {string} rootDir @param {{ prefix?: string, suffix?: string }} url
 */
function expand(json, rootDir, url) {
  const prefix = (url && url.prefix) || '';
  const suffix = (url && url.suffix) || '';
  if (!prefix) return String(json ?? '');
  return String(json ?? '').replace(TOKEN_RE, (token, name) => {
    if (name.includes('..')) return token; // un token reçu d'un tiers ne sort pas du dossier
    return `${prefix}${encodeURIComponent(path.join(rootDir, name))}${suffix}`;
  });
}

/**
 * Déménage les médias d'un dossier vers un autre : chaque URL sous `fromDir` est confiée à `adopt`,
 * qui en pose une copie ailleurs et rend son nouveau chemin. C'est l'opération d'« Enregistrer
 * sous… » — sans elle, un carnet enregistré ailleurs pointerait encore vers le magasin d'origine.
 * Un média qu'`adopt` n'a pas su reprendre garde son URL : mieux vaut un lien vers l'ancien
 * emplacement, qui marche encore sur cette machine, qu'un token qui ne désigne rien.
 * @param {string} json @param {string} fromDir @param {(abs: string) => string|null} adopt
 */
function rebase(json, fromDir, adopt) {
  return String(json ?? '').replace(MEDIA_URL_RE, (url, encoded) => {
    const abs = decodePath(encoded);
    if (!abs || !isUnder(fromDir, abs)) return url;
    const moved = adopt(abs);
    return moved ? `netsu-asset://${path.basename(moved)}` : url;
  });
}

module.exports = { collapse, expand, rebase, MEDIA_URL_RE, TOKEN_RE };
