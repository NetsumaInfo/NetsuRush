// @ts-check
// core/boardStorage.js
// Le MAGASIN D'ASSETS du board de référence : distinguer ce que l'app peut refabriquer de ce
// qu'elle est seule à détenir.
//
// Les caches (vignettes, proxies, analyses) ont déjà leur page — ils se refabriquent depuis la
// source, les vider ne coûte que du temps. Le magasin `reference/assets`, lui, n'est PAS un cache
// malgré les apparences : il reçoit l'image collée, le média récupéré d'un lien, les frames
// extraites, la sortie d'un upscale. Pour un board resté dans la bibliothèque, ces octets sont la
// SEULE copie qui existe au monde.
//
// Le DOSSIER COMPAGNON d'un projet .netsu (`core/netsu/sidecar`) adopte les assets de l'app à
// l'enregistrement. Le magasin garde alors un double dont plus personne n'a besoin — c'est ce
// double, et lui seul, qu'on peut libérer sans rien perdre.
//
// RECONNAÎTRE LE DOUBLE SANS RELIRE UN OCTET. Un asset s'appelle `<md5>.<ext>`
// (reference.js#saveAsset) et son adoption le nomme `<lisible>-<md5 sur 12>.<ext>`
// (sidecar.js#placeFor). Lire les noms du dossier compagnon suffit donc à savoir qui est déjà rangé
// ailleurs ; la taille le confirme. Un asset au nom LISIBLE (sortie d'upscale) n'a pas cette
// chance : son empreinte est un sha256, qu'on ne calcule que si un fichier compagnon a exactement
// sa taille.
//
// RÈGLE DE SÛRETÉ. Un faux négatif coûte quelques mégaoctets gardés pour rien ; un faux positif
// détruit le travail de quelqu'un. Tout doute classe donc l'asset du côté qu'on ne supprime pas, et
// le renderer ne désigne JAMAIS un fichier à supprimer : il demande une portée, le core recalcule
// lui-même ce qui y entre.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const sidecar = require('./netsu/sidecar');
const { hashFileAsync } = require('./netsu/blobs');
const recents = require('./netsu/recents');
const { yieldLoop } = require('./config');
const { diskInfo } = require('./optimize');

// Sous Windows, quelques milliers de `stat` en SÉRIE coûtent des dizaines de secondes. Le même
// travail en parallèle borné tient sous la seconde ; la borne évite d'ouvrir des milliers de
// descripteurs d'un coup.
const STAT_BATCH = 64;
// Longueur de l'empreinte portée par un nom rangé (sidecar.js#HASH_HEX).
const HASH_HEX = 12;
// Nom déjà porteur d'une empreinte de contenu (sidecar.js#LEGACY_NAME_RE).
const HASHED_NAME_RE = /^[0-9a-f]{16,64}$/i;
// Un fichier écrit à l'instant peut appartenir à un import que le board n'a pas encore posé : il
// n'est référencé nulle part et passerait pour un orphelin. Rien d'aussi jeune n'est proposé.
const SETTLE_MS = 5 * 60 * 1000;
// Au-delà, la liste ne sert plus l'utilisateur : les totaux restent exacts, seuls les exemples
// affichés sont bornés.
const SAMPLE_MAX = 200;

/** Empreinte de rangement déjà lisible dans le nom d'un asset, ou '' s'il n'en porte pas. */
function fingerprintFromName(file) {
  const base = path.basename(file, path.extname(file));
  return HASHED_NAME_RE.test(base) ? base.slice(0, HASH_HEX).toLowerCase() : '';
}

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

/** Un chemin est-il à l'intérieur de `root` (jamais la racine elle-même) ? */
function inside(root, candidate) {
  try {
    const r = path.resolve(root).toLowerCase();
    const c = path.resolve(String(candidate || '')).toLowerCase();
    return c !== r && c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * @param {{ refStore: any, netsu: any }} deps
 */
function createBoardStorage({ refStore, netsu }) {
  const assetsDir = refStore.assetsDir;

  /**
   * Ce que les dossiers compagnons des projets connus contiennent déjà : empreinte ⇒ où, et
   * l'ensemble des tailles présentes (prefiltre pour les assets au nom lisible).
   * Un projet dont le fichier a disparu (disque externe débranché) rend un index vide : ses assets
   * retombent alors du côté « copie unique », ce qui est exactement le repli voulu.
   */
  async function projectCopies() {
    /** @type {Map<string, { project: string, file: string, bytes: number }>} */
    const byHash = new Map();
    /** @type {Set<number>} */
    const sizes = new Set();
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
        byHash.set(String(wanted.get(found.file)), { project: entry.path, file: found.file, bytes: found.stat.size });
        sizes.add(found.stat.size);
      }
    }
    return { byHash, sizes };
  }

  /**
   * Qui réclame encore quoi. Les scènes réservées comptent AUTANT que les autres : `__autosave__`
   * porte la session en cours, `__handoff__` le passage vers la fenêtre détachée. Les ignorer
   * effacerait les médias du board actuellement ouvert.
   * @param {string[]} liveRefs localisateurs du board affiché, que rien n'a encore enregistré
   */
  function referencedAssets(liveRefs) {
    /** @type {Map<string, { id: string, name: string, collaborative: boolean }[]>} */
    const used = new Map();
    const note = (ref, scene) => {
      if (!ref) return;
      const key = path.resolve(String(ref)).toLowerCase();
      if (!refStore.isAppAsset(key)) return;
      const holders = used.get(key);
      if (holders) {
        if (!holders.some((holder) => holder.id === scene.id)) holders.push(scene);
      } else {
        used.set(key, [scene]);
      }
    };

    for (const meta of refStore.listScenes()) {
      const scene = refStore.loadScene(meta.id);
      if (!scene) continue;
      const holder = {
        id: String(meta.id),
        name: String(scene.name || meta.name || ''),
        collaborative: !!(scene.collaboration && scene.collaboration.projectId),
      };
      const refs = new Set();
      refStore.sceneRefs(scene, refs);
      for (const ref of refs) note(ref, holder);
    }

    const live = new Set();
    for (const ref of Array.isArray(liveRefs) ? liveRefs : []) {
      if (typeof ref !== 'string' || !ref) continue;
      const key = path.resolve(ref).toLowerCase();
      if (refStore.isAppAsset(key)) live.add(key);
    }
    return { used, live };
  }

  /**
   * Classe chaque fichier du magasin. Quatre issues :
   *   `freeable` — plus réclamé, et ses octets sont dans le dossier compagnon d'un projet ;
   *   `orphan`   — plus réclamé, et cette copie est la seule qui existe ;
   *   `held`     — encore réclamé par une scène ou par le board affiché ;
   *   ignoré     — trop récent pour qu'on sache (import en cours).
   * @param {string[]} liveRefs
   */
  async function classify(liveRefs) {
    const copies = await projectCopies();
    const { used, live } = referencedAssets(liveRefs);
    const now = Date.now();

    const freeable = [];
    const orphans = [];
    /** @type {Map<string, { id: string, name: string, collaborative: boolean, files: number, bytes: number, soleFiles: number, soleBytes: number }>} */
    const holders = new Map();
    let heldFiles = 0;
    let heldBytes = 0;
    let settling = 0;

    let names = [];
    try { names = await fsp.readdir(assetsDir); } catch (_) { names = []; }

    for (const { file, stat } of await statAll(names.map((name) => path.join(assetsDir, name)))) {
      const name = path.basename(file);
      const key = file.toLowerCase();
      const scenes = used.get(key);
      const isHeld = live.has(key) || (scenes && scenes.length > 0);

      // Empreinte : gratuite quand le nom la porte déjà. Sinon on ne relit le fichier que si le
      // dossier compagnon d'un projet contient un fichier d'exactement cette taille — sans ce
      // prefiltre, un magasin plein de sorties d'upscale se relirait entier à chaque ouverture.
      let hash = fingerprintFromName(name);
      if (!hash && copies.sizes.has(stat.size)) {
        try { hash = (await hashFileAsync(file)).sha.slice(0, HASH_HEX); }
        catch (_) { hash = ''; }
      }
      const copy = hash ? copies.byHash.get(hash) : undefined;
      // La taille confirme le nom : elle écarte aussi bien une collision d'empreinte tronquée qu'un
      // fichier compagnon resté tronqué par une écriture interrompue.
      const duplicated = !!copy && copy.bytes === stat.size;

      if (isHeld) {
        heldFiles += 1;
        heldBytes += stat.size;
        for (const scene of scenes || []) {
          let entry = holders.get(scene.id);
          if (!entry) {
            entry = { ...scene, files: 0, bytes: 0, soleFiles: 0, soleBytes: 0 };
            holders.set(scene.id, entry);
          }
          entry.files += 1;
          entry.bytes += stat.size;
          if (!duplicated) {
            entry.soleFiles += 1;
            entry.soleBytes += stat.size;
          }
        }
        continue;
      }

      if (now - stat.mtimeMs < SETTLE_MS) { settling += 1; continue; }
      if (duplicated) freeable.push({ path: file, name, bytes: stat.size, project: copy.project });
      else orphans.push({ path: file, name, bytes: stat.size });
    }

    return { freeable, orphans, holders: [...holders.values()], heldFiles, heldBytes, settling };
  }

  const sum = (entries) => entries.reduce((total, entry) => total + entry.bytes, 0);
  const sample = (entries) => entries
    .slice()
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, SAMPLE_MAX)
    .map((entry) => ({ name: entry.name, bytes: entry.bytes, ...(entry.project ? { project: entry.project } : {}) }));

  /**
   * L'état du magasin, tel que le panneau l'affiche. Les caches ne sont PAS mesurés ici : ils ont
   * leur propre page (Paramètres › Stockage › Médias), qui suit chaque type par entrée.
   * @param {{ liveRefs?: string[] }} [opts] localisateurs du board affiché (travail non enregistré)
   */
  async function audit(opts) {
    try {
      const { freeable, orphans, holders, heldFiles, heldBytes, settling } = await classify((opts || {}).liveRefs || []);
      return {
        ok: true,
        disk: await diskInfo(assetsDir).catch(() => null),
        assets: {
          dir: assetsDir,
          freeable: { files: freeable.length, bytes: sum(freeable), entries: sample(freeable) },
          orphans: { files: orphans.length, bytes: sum(orphans), entries: sample(orphans) },
          held: {
            files: heldFiles,
            bytes: heldBytes,
            // Un board partagé n'a pas de version « projet » à écrire : son document fait foi et ses
            // items ne vivent pas dans la scène. Il est signalé, jamais proposé à l'archivage.
            scenes: holders
              .filter((scene) => scene.soleFiles > 0)
              .sort((left, right) => right.soleBytes - left.soleBytes),
          },
          settling,
        },
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * Libère les doubles. Le renderer demande une PORTÉE, jamais des chemins : la liste des fichiers
   * effacés est recalculée ici, à l'instant de la suppression. Un asset devenu utile entre
   * l'affichage du panneau et le clic n'est donc pas emporté par une classification périmée.
   * @param {{ liveRefs?: string[] }} [opts]
   */
  async function free(opts) {
    const options = opts || {};
    let bytes = 0;
    let files = 0;
    try {
      const { freeable } = await classify(options.liveRefs || []);
      for (const entry of freeable) {
        // Dernière barrière : rien hors du magasin ne peut être atteint par ce canal.
        if (!inside(assetsDir, entry.path)) continue;
        try {
          await fsp.rm(entry.path, { force: true });
          bytes += entry.bytes;
          files += 1;
        } catch (_) { /* verrouillé : il repassera au prochain nettoyage */ }
      }
      return { ok: true, bytes, files };
    } catch (e) {
      return { ok: false, bytes, files, error: String((e && e.message) || e) };
    }
  }

  /**
   * Sort les orphelins du magasin vers un dossier choisi par l'utilisateur. C'est un DÉPLACEMENT :
   * copie, vérification de la taille écrite, puis retrait — l'app cesse de les détenir au moment
   * précis où quelqu'un d'autre les détient. Un fichier dont la copie ne se vérifie pas reste où
   * il est, et son échec est nommé.
   * @param {{ destDir: string, liveRefs?: string[] }} opts
   */
  async function moveOrphans(opts) {
    const destDir = String((opts || {}).destDir || '');
    if (!destDir) return { ok: false, error: 'destination manquante' };
    // Sortir les fichiers DANS le magasin ne les sortirait de rien du tout.
    if (inside(assetsDir, destDir) || path.resolve(destDir).toLowerCase() === path.resolve(assetsDir).toLowerCase()) {
      return { ok: false, error: "destination à l'intérieur du magasin" };
    }
    try {
      const stat = await fsp.stat(destDir);
      if (!stat.isDirectory()) return { ok: false, error: 'destination invalide' };
    } catch (_) {
      return { ok: false, error: 'destination introuvable' };
    }

    let bytes = 0;
    let files = 0;
    const failed = [];
    try {
      const { orphans } = await classify((opts || {}).liveRefs || []);
      for (const entry of orphans) {
        if (!inside(assetsDir, entry.path)) continue;
        // Homonyme déjà présent : on suffixe plutôt que d'écraser un fichier de l'utilisateur.
        const ext = path.extname(entry.name);
        const base = path.basename(entry.name, ext);
        let dest = path.join(destDir, entry.name);
        for (let n = 2; fs.existsSync(dest); n += 1) dest = path.join(destDir, `${base}-${n}${ext}`);
        try {
          const part = `${dest}.part`;
          await fsp.copyFile(entry.path, part);
          const written = await fsp.stat(part);
          if (written.size !== entry.bytes) {
            await fsp.rm(part, { force: true });
            failed.push(entry.name);
            continue;
          }
          await fsp.rename(part, dest);
          await fsp.rm(entry.path, { force: true });
          bytes += entry.bytes;
          files += 1;
        } catch (_) {
          failed.push(entry.name);
        }
      }
      return { ok: true, bytes, files, failed };
    } catch (e) {
      return { ok: false, bytes, files, failed, error: String((e && e.message) || e) };
    }
  }

  /**
   * Écrit une scène de la bibliothèque dans un projet .netsu. Le chemin normal d'enregistrement
   * adopte SANS CONDITION les assets possédés par l'app (core/netsu/project.js) : leurs octets
   * rejoignent le dossier compagnon, la scène interne disparaît, et le magasin ne garde plus qu'un
   * double — libérable au tour suivant. C'est ce que veut dire « l'app l'enregistre au bon endroit ».
   *
   * `adoptLocal` reste FAUX : les rushs de l'utilisateur ne sont pas concernés, il ne les a pas
   * confiés à l'app et un board peut en désigner des dizaines de Go.
   * @param {{ sceneId: string, destPath: string }} opts
   */
  async function archiveScene(opts) {
    const sceneId = String((opts || {}).sceneId || '');
    const destPath = String((opts || {}).destPath || '');
    if (!sceneId || !destPath) return { ok: false, error: 'scène ou destination manquante' };
    if (path.extname(destPath).toLowerCase() !== '.netsu') return { ok: false, error: 'destination invalide' };
    const scene = refStore.loadScene(sceneId);
    if (!scene) return { ok: false, error: 'scène introuvable' };
    // Un board partagé ne garde aucun item : l'archiver écrirait un projet vide et effacerait la
    // liaison au document, seule autorité sur son contenu.
    if (scene.collaboration && scene.collaboration.projectId) {
      return { ok: false, error: "un board partagé ne s'archive pas en projet" };
    }
    return netsu.saveProjectAs(refStore, {
      scene: {
        name: scene.name,
        items: scene.items || [],
        view: scene.view || null,
        retain: [],
        adoptLocal: false,
        adoptLocalMax: 0,
      },
      destPath,
      sourceSceneId: sceneId,
    });
  }

  /**
   * Retrouve les octets d'un média dont le chemin est mort. AUCUNE écriture : rend, pour chaque
   * chemin introuvable dont le nom porte une empreinte de contenu (`<lisible>-<md5 sur 12>` ou
   * `<md5>` — sidecar.js#hashFromName), un chemin existant qui porte la même. Sources, dans
   * l'ordre : le dossier compagnon du projet ouvert (le .netsu a bougé, ses médias avec lui), le
   * magasin d'assets, puis les dossiers compagnons des projets connus.
   *
   * L'appariement est par nom, jamais par relecture d'octets : l'import de partage recalcule de
   * toute façon la vraie empreinte de contenu, donc un homonyme de hasard ne peut au pire
   * qu'exposer un autre média de l'utilisateur — visible immédiatement sur le board — jamais
   * corrompre un document.
   *
   * `dead` liste les chemins qui manquent ET pour lesquels aucune source n'a rien rendu : c'est
   * l'entrée du recours suivant (retéléchargement depuis le lien d'origine, relocalisation par
   * dossier).
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
      const print = sidecar.hashFromName(ref).slice(0, HASH_HEX);
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
        const print = sidecar.hashFromName(found.file).slice(0, HASH_HEX);
        if (print && wanted.has(print)) claim(print, found.file);
      }
    }
    if (unresolved()) {
      const copies = await projectCopies();
      for (const [print, copy] of copies.byHash) {
        if (wanted.has(print) && copy.bytes > 0) claim(print, copy.file);
      }
    }
    for (const deadRefs of wanted.values()) {
      for (const ref of deadRefs) {
        if (!moves[ref]) dead.push(ref);
      }
    }
    return { ok: true, moves, dead };
  }

  return { audit, free, moveOrphans, archiveScene, locateMedia };
}

module.exports = { createBoardStorage };
