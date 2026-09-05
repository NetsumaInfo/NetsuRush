// @ts-check
// core/boardMediaLocator.js
// Retrouver les octets d'un média de board dont le CHEMIN est mort.
//
// Une scène de la bibliothèque garde des chemins absolus. Un dossier compagnon déplacé ou vidé
// laisse donc des références vers des fichiers qui n'existent plus — alors que les octets vivent
// le plus souvent ailleurs, et que le NOM DU FICHIER porte leur empreinte de contenu
// (`<lisible>-<md5:12>` après adoption, `<md5>` dans le magasin d'assets).
//
// On relocalise donc PAR LE NOM SEUL, sans lire un octet : dossier compagnon du projet ouvert
// d'abord, puis magasin d'assets, puis les compagnons de tous les projets connus. L'import
// recalcule de toute façon la vraie empreinte du contenu, donc une collision de nom peut au pire
// exposer un autre média de l'utilisateur — jamais corrompre un document.
//
// Un chemin qui n'a pas d'empreinte dans son nom (rush au nom libre) n'est pas cherché : sa
// relocalisation reste le geste « retrouver le dossier », qui existe déjà côté board.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const sidecar = require('./netsu/sidecar');
const recents = require('./netsu/recents');
const { yieldLoop } = require('./config');

// Sous Windows, quelques milliers de `stat` en SÉRIE coûtent des dizaines de secondes. Le même
// travail en parallèle borné tient sous la seconde ; la borne évite d'ouvrir des milliers de
// descripteurs d'un coup.
const STAT_BATCH = 64;

/**
 * `stat` de plusieurs fichiers, par lots parallèles. Un fichier illisible est simplement absent du
 * résultat : ce module ne fait que mesurer et classer, jamais échouer sur un verrou.
 * @param {string[]} files @returns {Promise<{ file: string, stat: import('node:fs').Stats }[]>}
 */
async function statAll(files) {
  const out = [];
  for (let index = 0; index < files.length; index += STAT_BATCH) {
    const chunk = files.slice(index, index + STAT_BATCH);
    const stats = await Promise.all(chunk.map((file) => fsp.stat(file).catch(() => null)));
    for (let n = 0; n < chunk.length; n += 1) {
      if (stats[n] && stats[n].isFile()) out.push({ file: chunk[n], stat: stats[n] });
    }
    await yieldLoop();
  }
  return out;
}

/** Chemins de tous les fichiers sous `dir`, jusqu'à `depth` niveaux. */
async function listFiles(dir, depth) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // `withFileTypes` ne suit pas les liens : aucune boucle possible par lien symbolique.
    if (entry.isDirectory()) {
      if (depth > 0) out.push(...await listFiles(full, depth - 1));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @param {{ assetsDir: string }} deps magasin d'assets de l'app (reference.js)
 */
function createBoardMediaLocator({ assetsDir }) {
  /**
   * Empreinte ⇒ où, dans les dossiers compagnons des projets connus. Un projet dont le fichier a
   * disparu (disque externe débranché) rend un index vide : c'est le repli voulu.
   * @returns {Promise<Map<string, string>>}
   */
  async function projectCopies() {
    /** @type {Map<string, string>} */
    const byHash = new Map();
    for (const entry of recents.list('board')) {
      if (entry.missing) continue;
      const dir = sidecar.sidecarDirFor(entry.path);
      /** @type {Map<string, string>} */
      const wanted = new Map();
      for (const [hash, relative] of sidecar.indexSidecar(entry.path)) {
        if (!byHash.has(hash)) wanted.set(path.join(dir, relative), hash);
      }
      for (const found of await statAll([...wanted.keys()])) {
        // Un fichier vide ne prouve rien : il ne peut pas être la copie de quoi que ce soit.
        if (found.stat.size === 0) continue;
        byHash.set(String(wanted.get(found.file)), found.file);
      }
    }
    return byHash;
  }

  /**
   * @param {{ refs?: string[], projectPath?: string }} opts
   * @returns {Promise<{ ok: true, moves: Record<string, string>, dead: string[] }>}
   */
  async function locateMedia(opts) {
    const { refs, projectPath } = opts || {};
    /** @type {Record<string, string>} */
    const moves = {};
    /** @type {string[]} */
    const dead = [];
    /** @type {Map<string, string[]>} — empreinte → chemins morts qui la réclament */
    const wanted = new Map();
    for (const raw of Array.isArray(refs) ? refs : []) {
      const ref = String(raw || '');
      if (!ref || !path.isAbsolute(ref)) continue; // token, lien, id : rien à retrouver ici
      if (fs.existsSync(ref)) continue;
      const print = sidecar.hashFromName(ref).slice(0, sidecar.HASH_HEX);
      if (!print) {
        dead.push(ref); // rush au nom libre : la relocalisation par dossier reste son chemin
        continue;
      }
      const list = wanted.get(print) || [];
      list.push(ref);
      wanted.set(print, list);
    }
    if (!wanted.size) return { ok: true, moves, dead };

    const claim = (print, file) => {
      for (const ref of wanted.get(print) || []) {
        if (!moves[ref]) moves[ref] = file;
      }
    };
    const unresolved = () =>
      [...wanted.values()].some((deadRefs) => deadRefs.some((ref) => !moves[ref]));

    if (projectPath) {
      const dir = sidecar.sidecarDirFor(projectPath);
      for (const [print, relative] of sidecar.indexSidecar(projectPath)) {
        if (!wanted.has(print)) continue;
        const candidate = path.join(dir, relative);
        try {
          if (fs.statSync(candidate).size > 0) claim(print, candidate);
        } catch (_) { /* candidat illisible : source suivante */ }
      }
    }
    if (unresolved()) {
      for (const found of await statAll(await listFiles(assetsDir, 1))) {
        if (!found.stat.size) continue;
        const print = sidecar.hashFromName(found.file).slice(0, sidecar.HASH_HEX);
        if (print && wanted.has(print)) claim(print, found.file);
      }
    }
    if (unresolved()) {
      for (const [print, file] of await projectCopies()) {
        if (wanted.has(print)) claim(print, file);
      }
    }
    for (const deadRefs of wanted.values()) {
      for (const ref of deadRefs) {
        if (!moves[ref]) dead.push(ref);
      }
    }
    return { ok: true, moves, dead };
  }

  return { locateMedia };
}

module.exports = { createBoardMediaLocator };
