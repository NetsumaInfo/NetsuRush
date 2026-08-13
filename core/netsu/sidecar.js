// @ts-check
// core/netsu/sidecar.js
// Dossier compagnon d'un projet .netsu : « mon-projet.medias », posé À CÔTÉ du fichier.
//
// Un projet n'embarque PAS les rushs : ils restent là où ils sont, désignés par leur identité de
// contenu (token `ref:` — cf. core/netsu/board.js). Mais tout ce qui n'a pas de place à soi sur le
// disque de l'utilisateur — image collée au presse-papier, média récupéré d'un lien, image produite
// par l'app — vivait jusqu'ici dans le magasin GLOBAL (`NR_HOME/reference/assets`), commun à tous
// les boards. Un projet enregistré ailleurs y laissait donc ses propres médias : le fichier seul
// n'affichait plus rien sur une autre machine, et vider le magasin global crevait des projets qui
// n'avaient rien demandé.
//
// D'où ce dossier, et le token `sidecar:<relatif>` qui le désigne. Le chemin est RELATIF au .netsu :
// c'est la seule forme qui survit à un déplacement du projet, un chemin absolu ne le fait pas. Le
// couple (fichier + dossier) se déplace, se copie et se sauvegarde ensemble.
//
// RANGEMENT. Le dossier s'ouvre dans l'explorateur : c'est un dossier de travail, pas un cache. Il
// est donc trié par type, et chaque séquence d'images tient dans son propre dossier — sinon ses
// centaines de frames noient tout le reste.
//
//   mon-projet.medias/
//     images/    aurora-2f4a70a71de8.jpg
//     videos/    intro-1adb474d5f68.mp4
//     sequences/ cell-games/0001-0b374f12e333.jpg …
//     other/     (repli : extension ni image ni vidéo)
//
// Le nom porte l'empreinte du contenu en suffixe. C'est ce qui garde la déduplication gratuite —
// adopter deux fois le même média ne coûte qu'une comparaison de nom — tout en restant lisible.
// Les octets ne sont donc jamais réécrits deux fois, et un média déjà rangé n'est jamais déplacé
// d'un enregistrement à l'autre : un Ctrl+S ne doit pas remuer le disque.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { hashFile, hashFileAsync } = require('./blobs');

const TOKEN = 'sidecar:';
// Suffixe du dossier. Volontairement lisible : l'utilisateur doit comprendre au premier coup d'œil
// que ce dossier appartient au .netsu d'à côté et qu'il se déplace avec lui.
const DIR_SUFFIX = '.medias';
// Longueur de l'empreinte gardée dans le nom. 12 hexadécimaux = 48 bits : de quoi ne jamais
// collisionner sur les quelques milliers de médias d'un board, sans noyer la part lisible du nom.
const HASH_HEX = 12;
// Au-delà, le nom devient une phrase — et Windows plafonne le chemin complet.
const SLUG_MAX = 40;

const BUCKETS = { image: 'images', video: 'videos', other: 'other' };
const SEQ_ROOT = 'sequences';

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'jxl',
]);
const VIDEO_EXT = new Set([
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mxf', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', 'm2ts',
  'braw', 'r3d',
]);

// Noms de contenu produits AILLEURS : le magasin global nomme ses assets par md5 (32 hex,
// core/reference.js#saveAsset) et les anciens dossiers compagnons par sha256 tronqué (16 hex).
// Les reconnaître évite de relire plusieurs centaines de Mo pour recalculer ce qu'on sait déjà.
const LEGACY_NAME_RE = /^[0-9a-f]{16,64}$/i;
// Nom rangé : la part lisible, puis l'empreinte.
const PLACED_NAME_RE = new RegExp(`-([0-9a-f]{${HASH_HEX}})$`, 'i');
// Réservés par Windows quelle que soit l'extension : un dossier de séquence intitulé « CON » rendrait
// le projet inouvrable sur la machine qui l'a écrit.
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Marques diacritiques laissées par la décomposition NFD (construite depuis une chaîne : la classe
// littérale se lirait comme une suite de caractères invisibles).
const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

/** Dossier compagnon d'un fichier .netsu (jamais créé ici — seule l'adoption en a besoin). */
function sidecarDirFor(netsuPath) {
  const resolved = path.resolve(String(netsuPath || ''));
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(dir, `${base}${DIR_SUFFIX}`);
}

/** @param {unknown} value @returns {boolean} */
function isSidecarToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN);
}

/**
 * Token d'un fichier compagnon. Les séparateurs sont normalisés en barres obliques : un projet
 * écrit sous Windows doit rester lisible ailleurs, et `\` n'est pas un séparateur partout.
 * @param {string} relative
 */
function sidecarToken(relative) {
  return `${TOKEN}${String(relative || '').split(path.sep).join('/')}`;
}

/**
 * Token → chemin absolu, résolu depuis le .netsu. Rend '' si le token désigne quoi que ce soit hors
 * du dossier compagnon : un `..` dans un fichier reçu d'un tiers ne doit pas pouvoir pointer
 * ailleurs sur la machine.
 * @param {string} netsuPath @param {string} token @returns {string}
 */
function resolveSidecar(netsuPath, token) {
  if (!isSidecarToken(token)) return '';
  const dir = sidecarDirFor(netsuPath);
  const resolved = path.resolve(dir, String(token).slice(TOKEN.length));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return '';
  return resolved;
}

/** Un chemin est-il DÉJÀ dans le dossier compagnon de ce projet ? */
function isInSidecar(netsuPath, filePath) {
  try {
    const dir = sidecarDirFor(netsuPath);
    const resolved = path.resolve(String(filePath || ''));
    return resolved.startsWith(dir + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * Un chemin est-il dans le dossier compagnon d'un AUTRE projet ? « Enregistrer sous… » recopie une
 * scène dont les médias pointent encore vers le dossier du fichier d'origine : sans ce test ils
 * seraient traités comme des rushs de l'utilisateur, et le nouveau projet resterait suspendu au
 * dossier de l'ancien.
 * @param {string} filePath
 */
function isInAnySidecar(filePath) {
  try {
    const resolved = path.resolve(String(filePath || ''));
    for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
      if (path.basename(dir).toLowerCase().endsWith(DIR_SUFFIX)) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
    }
  } catch (_) {
    return false;
  }
}

/** Texte quelconque → part lisible d'un nom de fichier. Jamais vide, jamais un nom réservé. */
function slugify(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(DIACRITICS_RE, '') // les accents ne survivent pas à tous les systèmes de fichiers
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  if (!slug) return 'media';
  return RESERVED_RE.test(slug) ? `_${slug}` : slug;
}

/** @param {string} filePath @returns {string} */
function extOf(filePath) {
  return (path.extname(filePath).slice(1) || 'bin').toLowerCase();
}

/** Empreinte déjà portée par le nom du fichier, s'il en porte une. */
function hashFromName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  if (LEGACY_NAME_RE.test(base)) return base.toLowerCase();
  const placed = PLACED_NAME_RE.exec(base);
  return placed ? placed[1].toLowerCase() : '';
}

/**
 * Identité de contenu d'un fichier à adopter. Un fichier DÉJÀ nommé par son contenu (asset du
 * magasin global, média déjà rangé) rend son empreinte sans être relu — c'est ce qui évite de
 * repasser des centaines de Mo à chaque enregistrement.
 * @param {string} filePath @returns {string}
 */
function fingerprint(filePath) {
  return (hashFromName(filePath) || hashFile(filePath).sha).slice(0, HASH_HEX);
}

/** Même empreinte, lue sans bloquer le core (un rush non nommé par son contenu se relit en entier). */
async function fingerprintAsync(filePath) {
  const named = hashFromName(filePath);
  if (named) return named.slice(0, HASH_HEX);
  return (await hashFileAsync(filePath)).sha.slice(0, HASH_HEX);
}

/** @param {string} kind @param {string} ext @returns {string} */
function bucketFor(kind, ext) {
  if (kind === 'image' || kind === 'video') return BUCKETS[kind];
  if (IMAGE_EXT.has(ext)) return BUCKETS.image;
  if (VIDEO_EXT.has(ext)) return BUCKETS.video;
  return BUCKETS.other;
}

/**
 * Où va ce média, relativement au dossier compagnon.
 * `group` = dossier de séquence (déjà rendu unique par l'appelant) ; `index` = rang de la frame,
 * qui préfixe le nom pour que l'explorateur affiche la séquence DANS L'ORDRE.
 * @param {{ kind?: string, title?: string, sourcePath: string, hash: string,
 *           group?: string, index?: number }} place
 * @returns {string} chemin relatif, séparateurs natifs
 */
function placeFor(place) {
  const ext = extOf(place.sourcePath);
  const hash = String(place.hash || '').slice(0, HASH_HEX);
  if (place.group) {
    const rank = String(Math.max(0, Number(place.index) || 0) + 1).padStart(4, '0');
    return path.join(SEQ_ROOT, place.group, `${rank}-${hash}.${ext}`);
  }
  // Le nom du média l'emporte sur celui du fichier : un asset du magasin global s'appelle déjà par
  // son empreinte, la reprendre ne dirait rien à personne.
  const named = place.title || (hashFromName(place.sourcePath) ? '' : path.basename(place.sourcePath, path.extname(place.sourcePath)));
  return path.join(bucketFor(String(place.kind || ''), ext), `${slugify(named)}-${hash}.${ext}`);
}

/** @param {string} dir @param {string} [base] @returns {string[]} chemins relatifs, séparateurs natifs */
function walkFiles(dir, base) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    // `withFileTypes` ne suit pas les liens : un lien symbolique n'est ni fichier ni dossier ici,
    // donc aucune boucle possible.
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Ce que le dossier compagnon contient déjà : empreinte ⇒ chemin relatif. Construit UNE FOIS par
 * enregistrement, il porte deux garanties : un contenu déjà rangé n'est pas recopié, et un fichier
 * de l'ancienne disposition (tout à plat) est déplacé au lieu d'être dupliqué.
 * @param {string} netsuPath @returns {Map<string, string>}
 */
function indexSidecar(netsuPath) {
  /** @type {Map<string, string>} */
  const index = new Map();
  const dir = sidecarDirFor(netsuPath);
  for (const rel of walkFiles(dir)) {
    const hash = hashFromName(rel).slice(0, HASH_HEX);
    if (!hash || index.has(hash)) continue;
    index.set(hash, rel);
  }
  return index;
}

/**
 * Copie un fichier dans le dossier compagnon et rend son token.
 *
 * Sans `opts.place`, le fichier est rangé À PLAT sous son nom de contenu : c'est la disposition
 * qu'attend le Carnet (core/netsu/notebookDoc.js), dont les tokens de blocs ne portent qu'un nom de
 * fichier (core/netsu/mediaTokens.js) et ne sauraient pas désigner un sous-dossier.
 *
 * @param {string} netsuPath @param {string} filePath
 * @param {{ place?: { kind?: string, title?: string, group?: string, index?: number },
 *           index?: Map<string, string> }} [opts]
 * @returns {{ ok: boolean, token?: string, path?: string, relative?: string, bytes?: number, error?: string }}
 */
function adopt(netsuPath, filePath, opts) {
  try {
    const plan = planAdoption(netsuPath, filePath, opts, fingerprint(filePath));
    if (plan.settled) return plan.settled;
    if (!fs.existsSync(plan.dest)) {
      fs.mkdirSync(path.dirname(plan.dest), { recursive: true });
      if (plan.from && fs.existsSync(plan.from)) {
        fs.renameSync(plan.from, plan.dest); // même contenu, autre rangement : on déplace, pas de copie
      } else {
        // Écriture en `.part` puis renommage : un enregistrement interrompu ne doit pas laisser un
        // média tronqué SOUS SON NOM DE CONTENU, qui le ferait passer pour valide à jamais.
        const part = `${plan.dest}.part`;
        fs.copyFileSync(filePath, part);
        fs.renameSync(part, plan.dest);
      }
    }
    return plan.done();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Même adoption, sans bloquer le core. La copie d'un rush de plusieurs Go passe par le pool d'I/O
 * au lieu de figer la boucle d'événements — pendant un enregistrement, l'app doit continuer à
 * servir ses aperçus. Voie normale du projet ; `adopt` reste pour les appelants synchrones.
 * @param {string} netsuPath @param {string} filePath
 * @param {{ place?: { kind?: string, title?: string, group?: string, index?: number },
 *           index?: Map<string, string> }} [opts]
 * @returns {Promise<{ ok: boolean, token?: string, path?: string, relative?: string, bytes?: number, error?: string }>}
 */
async function adoptAsync(netsuPath, filePath, opts) {
  try {
    const plan = planAdoption(netsuPath, filePath, opts, await fingerprintAsync(filePath));
    if (plan.settled) return plan.settled;
    if (!fs.existsSync(plan.dest)) {
      await fsp.mkdir(path.dirname(plan.dest), { recursive: true });
      if (plan.from && fs.existsSync(plan.from)) {
        await fsp.rename(plan.from, plan.dest);
      } else {
        const part = `${plan.dest}.part`;
        await fsp.copyFile(filePath, part);
        await fsp.rename(part, plan.dest);
      }
    }
    return plan.done();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Où va ce fichier et que reste-t-il à faire. `settled` = déjà rangé, rien à écrire ; sinon `dest`
 * (et `from` quand le contenu est déjà là sous un autre rangement) puis `done()` pour l'index.
 * Partagé par les deux adoptions : une seule règle de placement, deux façons d'écrire les octets.
 */
function planAdoption(netsuPath, filePath, opts, hash) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`pas un fichier : ${filePath}`);
  const dir = sidecarDirFor(netsuPath);
  const options = opts || {};
  // À plat, le nom de contenu du fichier source est repris TEL QUEL quand il en porte déjà un :
  // le Carnet a des tokens qui citent ce nom, le raccourcir les casserait.
  const flatName = hashFromName(filePath) ? path.basename(filePath) : `${hash}.${extOf(filePath)}`;
  const relative = options.place ? placeFor({ ...options.place, sourcePath: filePath, hash }) : flatName;
  const known = options.index ? options.index.get(hash) : null;

  // Déjà rangé au bon endroit : rien à faire. Le nom lisible peut différer (l'item a été renommé
  // depuis) — le déplacer à chaque enregistrement coûterait une écriture disque pour un détail
  // cosmétique, et ferait clignoter le dossier ouvert dans l'explorateur.
  if (known && path.dirname(known) === path.dirname(relative) && fs.existsSync(path.join(dir, known))) {
    return {
      settled: { ok: true, token: sidecarToken(known), path: path.join(dir, known), relative: known, bytes: stat.size },
    };
  }
  return {
    settled: null,
    dest: path.join(dir, relative),
    from: known ? path.join(dir, known) : null,
    done: () => {
      if (options.index) options.index.set(hash, relative);
      return { ok: true, token: sidecarToken(relative), path: path.join(dir, relative), relative, bytes: stat.size };
    },
  };
}

/**
 * Retire du dossier compagnon les médias qu'aucun item ne réclame plus, puis les dossiers restés
 * vides. Sans ce ménage, supprimer une image d'un board laisserait ses octets peser dans le projet
 * pour toujours, et une séquence effacée laisserait son dossier derrière elle.
 * @param {string} netsuPath @param {Set<string>} keep chemins RELATIFS encore référencés
 * @returns {{ removed: number, bytes: number }}
 */
function sweep(netsuPath, keep) {
  const dir = sidecarDirFor(netsuPath);
  let removed = 0;
  let bytes = 0;
  for (const rel of walkFiles(dir)) {
    if (keep.has(rel) || keep.has(rel.split(path.sep).join('/'))) continue;
    const target = path.join(dir, rel);
    try {
      bytes += fs.statSync(target).size;
      fs.rmSync(target, { force: true });
      removed += 1;
    } catch (_) { /* fichier verrouillé (lecture en cours) : il repassera au prochain ménage */ }
  }
  pruneEmptyDirs(dir);
  return { removed, bytes };
}

/** Retire les sous-dossiers vides, des feuilles vers la racine. La racine, elle, reste. */
function pruneEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    try { fs.rmdirSync(child); } catch (_) { /* pas vide : il reste */ }
  }
}

module.exports = {
  TOKEN, DIR_SUFFIX, BUCKETS, SEQ_ROOT,
  sidecarDirFor, isSidecarToken, sidecarToken, resolveSidecar, isInSidecar, isInAnySidecar,
  slugify, indexSidecar, adopt, adoptAsync, sweep,
};
