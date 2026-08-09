// @ts-check
// Bibliothèque de rushs importés : les médias déposés dans l'app SANS passer par le Media Pool d'un
// logiciel de montage. Une entrée = un rush ENTIER (chemin + métadonnées sondées), rangeable dans une
// hiérarchie de dossiers. C'est l'ENTRÉE du derush — à ne pas confondre avec core/collections.js, qui
// garde des PLANS découpés (in/out) et constitue la SORTIE. Deux granularités, deux stores.
// Calque exact de core/collections.js : SQLite via node:sqlite si dispo, sinon repli JSON-file —
// MÊME API publique. Feuille du graphe : ne dépend que d'un répertoire de données + des sondes ffmpeg
// (injectés), jamais de Resolve.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { isMediaPath } = require('./utils');
const { t } = require('./i18n');

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// Parcours récursif d'un dossier, plafonné. Un seul scanner pour les DEUX usages (import d'un dossier
// et relocalisation en masse) — la version dupliquée dans collections.js:408 était le doublon à éviter.
function scanDir(root, onFile, cap = 40000) {
  const stack = [root];
  let scanned = 0;
  while (stack.length && scanned < cap) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else { scanned++; onFile(full, e.name); }
    }
  }
  return scanned;
}

// Durée en timecode HH:MM:SS:FF, comme Resolve la renvoie (GetClipProperty("Duration")).
// OBLIGATOIRE : rushSort.ts trie la durée par localeCompare — un format « 1:23 » se placerait n'importe
// où face aux clips du Media Pool dans la même grille. Le timecode, lui, se trie lexicographiquement.
function fmtTimecode(sec, fps) {
  const f = Math.max(1, Math.round(Number(fps) || 25));
  let total = Math.max(0, Math.round((Number(sec) || 0) * f));
  const ff = total % f; total = Math.floor(total / f);
  const ss = total % 60; total = Math.floor(total / 60);
  const mm = total % 60;
  const hh = Math.floor(total / 60);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

// --- Backend SQLite (node:sqlite, sans compilation native) -------------------------------------
// StatementSync NEUF à chaque appel (jamais mémorisé) : un statement conservé peut être finalisé par
// le GC → « statement has been finalized » à la sauvegarde suivante (cf. reference.js/collections.js).
const UPSERT =
  'INSERT INTO library_items (id, name, data, updated_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at';

function sqliteBackend(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS library_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
  return {
    list: () => db.prepare('SELECT id, name, data, updated_at FROM library_items ORDER BY updated_at DESC').all(),
    get: (id) => db.prepare('SELECT id, name, data, updated_at FROM library_items WHERE id = ?').get(id) || null,
    put: (id, name, data, ts) => db.prepare(UPSERT).run(id, name, data, ts),
    del: (id) => db.prepare('DELETE FROM library_items WHERE id = ?').run(id),
  };
}

// --- Backend JSON (repli) : un seul fichier { [id]: {id,name,data,updated_at} } ----------------
function jsonBackend(filePath) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return {}; }
  };
  const write = (obj) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath); // rename atomique
  };
  return {
    list: () => Object.values(read()).sort((a, b) => b.updated_at - a.updated_at),
    get: (id) => read()[id] || null,
    put: (id, name, data, ts) => {
      const o = read();
      o[id] = { id, name, data, updated_at: ts };
      write(o);
    },
    del: (id) => {
      const o = read();
      delete o[id];
      write(o);
    },
  };
}

/**
 * @param {string} dataDir
 * @param {{ probeMedia?: (p: string) => Promise<any>, playInfo?: (p: string) => Promise<any> }} [deps]
 */
function createLibraryStore(dataDir, deps = {}) {
  const dir = path.join(dataDir, 'library');
  fs.mkdirSync(dir, { recursive: true });

  let backend;
  let kind;
  try {
    backend = sqliteBackend(path.join(dir, 'library.db'));
    kind = 'sqlite';
  } catch (e) {
    backend = jsonBackend(path.join(dir, 'library.json'));
    kind = 'json';
  }

  // Modèle NU, volontairement : ni tags, ni notes, ni étoiles, ni archive — c'est le rôle de
  // collections.js. Ici on indexe des rushs, comme un Media Pool.
  function decode(row) {
    if (!row) return null;
    let p = {};
    try { p = JSON.parse(row.data) || {}; } catch (_) {}
    return {
      id: row.id,
      name: row.name,
      path: String(p.path || ''),
      folderId: p.folderId || null,
      duration: p.duration || null,
      fps: p.fps || null,
      resolution: p.resolution || null,
      format: p.format || null,
      addedAt: p.addedAt || row.updated_at,
    };
  }

  function encode(it) {
    return JSON.stringify({
      path: it.path,
      folderId: it.folderId || null,
      duration: it.duration || null,
      fps: it.fps || null,
      resolution: it.resolution || null,
      format: it.format || null,
      addedAt: it.addedAt || Date.now(),
    });
  }

  function listItems() {
    try { return backend.list().flatMap((item) => { const decoded = decode(item); return decoded ? [decoded] : []; }); } catch (_) { return []; }
  }

  // Sonde un fichier et met les métadonnées AU FORMAT de Resolve (cf. resolve.js:103-111) : les cartes
  // importées voisinent celles du Media Pool dans la même grille, elles doivent se lire pareil.
  // ffmpeg.probeMedia ne rend que {duration,width,height} ; le fps et le codec viennent de playInfo.
  async function makeItem(p, folderId) {
    const it = {
      id: uid(),
      name: path.basename(p),
      path: String(p),
      folderId: folderId || null,
      duration: null, fps: null, resolution: null, format: null,
      addedAt: Date.now(),
    };
    try {
      const m = deps.probeMedia ? await deps.probeMedia(p) : null;
      const pi = deps.playInfo ? await deps.playInfo(p) : null;
      const fps = pi && pi.fps ? Number(pi.fps) : 0;
      const dur = (m && m.duration) || (pi && pi.duration) || 0;
      if (dur) it.duration = fmtTimecode(dur, fps || 25);
      if (fps) it.fps = String(Math.round(fps * 1000) / 1000);
      if (m && m.width && m.height) it.resolution = `${m.width}x${m.height}`;
      if (pi && pi.codec) it.format = String(pi.codec);
    } catch (_) {
      // Sonde en échec (fichier illisible, codec exotique) → l'entrée existe quand même, sans métas.
      // Perdre le rush parce que ffprobe a toussé serait pire que l'afficher nu.
    }
    return it;
  }

  async function addPaths(paths) {
    try {
      if (!Array.isArray(paths) || !paths.length) return { ok: true, added: 0 };
      const known = new Set(listItems().map((i) => i.path.toLowerCase()));
      let added = 0;
      for (const p of paths) {
        if (!p) continue;
        let stat;
        try { stat = fs.statSync(p); } catch (_) { continue; }
        if (stat.isDirectory()) {
          const result = await addDir(p);
          if (!result.ok) return result;
          added += result.added || 0;
          continue;
        }
        if (!stat.isFile() || !isMediaPath(p) || known.has(String(p).toLowerCase())) continue;
        known.add(String(p).toLowerCase());
        const it = await makeItem(p, null);
        backend.put(it.id, it.name, encode(it), Date.now());
        added++;
      }
      return { ok: true, added };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Importe un dossier : scan récursif des rushs, l'arborescence disque est recréée en sous-dossiers
  // de bibliothèque (le dossier lâché devient un dossier racine).
  async function addDir(root) {
    try {
    if (!root || !fs.existsSync(root)) return { ok: false, error: t('folderMissing') };
      /** @type {{full: string, rel: string}[]} */
      const files = [];
      scanDir(root, (full) => { if (isMediaPath(full)) files.push({ full, rel: path.relative(root, path.dirname(full)) }); });
      if (!files.length) return { ok: true, added: 0, folders: 0 };

      const folders = readFolders();
      // DEUX index séparés : `byRel` est indexé sur le chemin relatif au dossier importé, `byAcc` sur le
      // chemin absolu dans l'arbre de bibliothèque. Les mélanger dans une seule Map les fait se percuter
      // dès qu'un chemin relatif vaut le nom du dossier racine (importer « Rushs\Anime » qui contient un
      // sous-dossier « Anime ») → tout le sous-dossier était aplati dans le parent, sans un mot.
      const byRel = new Map();
      const byAcc = new Map();
      let created = 0;
      const ensure = (rel) => {
        if (byRel.has(rel)) return byRel.get(rel);
        const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
        let parentId = null;
        let acc = '';
        // Le dossier racine porte le nom du dossier choisi, puis un niveau par segment relatif.
        for (const name of [path.basename(root), ...parts]) {
          acc = acc ? `${acc}/${name}` : name;
          if (byAcc.has(acc)) { parentId = byAcc.get(acc); continue; }
          const found = folders.find((f) => f.name === name && (f.parentId || null) === parentId);
          const id = found ? found.id : uid();
          if (!found) { folders.push({ id, name, parentId }); created++; }
          byAcc.set(acc, id);
          parentId = id;
        }
        byRel.set(rel, parentId);
        return parentId;
      };

      const known = new Set(listItems().map((i) => i.path.toLowerCase()));
      let added = 0;
      for (const f of files) {
        if (known.has(f.full.toLowerCase())) continue;
        known.add(f.full.toLowerCase());
        const it = await makeItem(f.full, ensure(f.rel));
        backend.put(it.id, it.name, encode(it), Date.now());
        added++;
      }
      if (created) writeFolders(folders);
      return { ok: true, added, folders: created };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Retire les ENTRÉES seulement. La bibliothèque n'est qu'un index de chemins : elle ne possède pas
  // les rushs de l'utilisateur et n'a donc aucune raison de toucher au disque (même esprit que le
  // garde-fou isAppAsset de reference.js:282, qui n'efface que les assets créés par l'app).
  // Rend `undo` = les enregistrements COMPLETS d'avant la suppression, seule matière capable de les
  // restaurer à l'identique (cf. restore).
  function removeItems(ids) {
    try {
      const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
      const items = [];
      for (const id of wanted) {
        const it = decode(backend.get(id));
        if (!it) continue;
        items.push(it);
        backend.del(id);
      }
      return { ok: true, undo: { items, folders: [] } };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  function removeItem(id) {
    return removeItems([id]);
  }

  function moveItem(id, folderId) {
    try {
      const it = decode(backend.get(id));
      if (!it) return { ok: false, error: t('rushMissing') };
      it.folderId = folderId || null;
      const ts = Date.now();
      backend.put(it.id, it.name, encode(it), ts);
      return { ok: true, updatedAt: ts };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // --- Dossiers de rangement (hiérarchie façon Media Pool) ---------------------------------------
  // Petit fichier JSON dédié : {id, name, parentId} (parentId null = racine « Importés »).
  const foldersFile = path.join(dir, 'folders.json');
  function readFolders() {
    try { const a = JSON.parse(fs.readFileSync(foldersFile, 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function writeFolders(a) {
    const tmp = foldersFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(a));
    fs.renameSync(tmp, foldersFile);
  }
  function listFolders() {
    return readFolders().map((f) => ({ id: f.id, name: f.name, parentId: f.parentId || null }));
  }
  function saveFolder(f) {
    try {
      const all = readFolders();
      const id = (f && f.id) || uid();
      const existing = all.find((x) => x.id === id);
      // parentId absent du patch = conservé (un renommage ne doit pas remonter le dossier à la racine).
      const parentId = f && f.parentId !== undefined ? (f.parentId || null) : (existing ? existing.parentId || null : null);
      const name = String((f && f.name) || (existing ? existing.name : t('folderDefault'))).trim();
      // Deux refus, parce que l'ARBRE du navigateur s'adresse par chemin de noms (« Importés/Anime/OP ») :
      // un « / » dans un nom y fabriquerait un faux niveau intermédiaire que rien ne piloterait (et un
      // rush glissé dessus partirait à la racine), et deux frères homonymes produiraient une rangée
      // unique manipulant un seul des deux dossiers, l'autre devenant invisible et inatteignable.
      if (!name) return { ok: false, error: t('emptyFolderName') };
      if (/[\\/]/.test(name)) return { ok: false, error: t('invalidFolderName') };
      if (all.some((x) => x.id !== id && (x.parentId || null) === parentId && x.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: `${t('duplicateFolder')}: ${name}` };
      }
      const rec = { id, name, parentId };
      const i = all.findIndex((x) => x.id === id);
      if (i >= 0) all[i] = rec; else all.push(rec);
      writeFolders(all);
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  // Tous les dossiers du sous-arbre (`id` inclus). Garde anti-cycle : un parentId corrompu ne doit pas
  // faire tourner la descente en boucle.
  function subtree(all, id) {
    const out = [];
    const seen = new Set();
    const walk = (fid) => {
      if (seen.has(fid)) return;
      seen.add(fid);
      const f = all.find((x) => x.id === fid);
      if (f) out.push(f);
      for (const c of all.filter((x) => (x.parentId || null) === fid)) walk(c.id);
    };
    walk(id);
    return out;
  }

  // Supprime un dossier. Deux régimes, choisis par l'appelant (l'UI demande à chaque fois) :
  //  - withItems=false (défaut) : ses sous-dossiers ET ses rushs remontent au parent — jamais
  //    d'orphelin, jamais de perte.
  //  - withItems=true : le SOUS-ARBRE entier part (dossiers descendants + tous leurs rushs).
  // Dans les deux cas seules des entrées d'index disparaissent — aucun fichier n'est touché.
  // Rend `undo` = les enregistrements d'avant l'opération (rushs AVEC leur folderId d'origine, donc
  // les restaurer verbatim rétablit à la fois leur existence et leur rangement).
  function deleteFolder(id, withItems) {
    try {
      const all = readFolders();
      const target = all.find((x) => x.id === id);
      const parent = target ? (target.parentId || null) : null;
      const items = listItems();

      if (withItems) {
        const doomed = subtree(all, id);
        const ids = new Set(doomed.map((f) => f.id));
        const hit = items.filter((it) => it.folderId && ids.has(it.folderId));
        writeFolders(all.filter((x) => !ids.has(x.id)));
        for (const it of hit) backend.del(it.id);
        return { ok: true, undo: { items: hit, folders: doomed } };
      }

      const moved = items.filter((it) => it.folderId === id);
      writeFolders(all.flatMap((x) => x.id === id ? [] : [x.parentId === id ? { ...x, parentId: parent } : x]));
      for (const it of moved) backend.put(it.id, it.name, encode({ ...it, folderId: parent }), Date.now());
      // `moved` porte encore le folderId d'AVANT (listItems a été lu en amont) → restaurable tel quel.
      // Les sous-dossiers remontés se restaurent en réécrivant leur enregistrement d'origine.
      const reparented = all.filter((x) => x.parentId === id);
      return { ok: true, undo: { items: moved, folders: target ? [target, ...reparented] : reparented } };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Remet en place ce qu'une suppression a retiré, à l'IDENTIQUE : même id, même dossier, mêmes
  // métadonnées. C'est la raison d'être de cette fonction — addPaths re-sonde les fichiers et forge de
  // NOUVEAUX ids à la racine, il ne peut donc pas servir d'annulation.
  function restore(undo) {
    try {
      const items = (undo && Array.isArray(undo.items)) ? undo.items : [];
      const folders = (undo && Array.isArray(undo.folders)) ? undo.folders : [];
      if (folders.length) {
        const all = readFolders();
        for (const f of folders) {
          const rec = { id: f.id, name: f.name, parentId: f.parentId || null };
          const i = all.findIndex((x) => x.id === rec.id);
          if (i >= 0) all[i] = rec; else all.push(rec);
        }
        writeFolders(all);
      }
      const ts = Date.now();
      for (const it of items) backend.put(it.id, it.name, encode(it), ts);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // --- Médias hors-ligne + relocalisation --------------------------------------------------------
  // La bibliothèque ne stocke que des chemins : elle s'ouvre logiciels fermés, mais un fichier déplacé
  // devient « hors-ligne ». JAMAIS de purge automatique — un disque externe débranché viderait la
  // bibliothèque toute seule.
  function offlineItems() {
    try {
      const items = listItems();
      const missing = [];
      for (const it of items) {
        if (!it.path) continue;
        let ok = false;
        try { ok = fs.existsSync(it.path); } catch (_) {}
        if (!ok) missing.push({ path: it.path, name: it.name });
      }
      return { ok: true, missing, offline: missing.length, total: items.length };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  function relinkPath(oldPath, newPath) {
    try {
      if (!newPath) return { ok: false, error: t('newFileMissing') };
      let relinked = 0;
      for (const it of listItems()) {
        if (it.path !== oldPath) continue;
        it.path = String(newPath);
        it.name = path.basename(newPath);
        backend.put(it.id, it.name, encode(it), Date.now());
        relinked++;
      }
      return { ok: true, relinked };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Relocalisation en masse : indexe un dossier par nom de base et repointe chaque rush hors-ligne
  // trouvé. « Dossier de renvoi » pour retrouver des médias déplacés en bloc (disque changé de lettre).
  function relinkDir(root) {
    try {
      if (!root || !fs.existsSync(root)) return { ok: false, error: t('folderMissing') };
      const index = new Map(); // basename minuscule → chemin complet (premier trouvé)
      scanDir(root, (full, name) => { const k = name.toLowerCase(); if (!index.has(k)) index.set(k, full); });
      let relinked = 0;
      for (const it of listItems()) {
        if (!it.path) continue;
        let exists = false;
        try { exists = fs.existsSync(it.path); } catch (_) {}
        if (exists) continue;
        const cand = index.get(path.basename(it.path).toLowerCase());
        if (!cand) continue;
        it.path = cand;
        backend.put(it.id, it.name, encode(it), Date.now());
        relinked++;
      }
      return { ok: true, relinked };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  return {
    kind,
    listItems, addPaths, addDir, removeItem, removeItems, moveItem, restore,
    listFolders, saveFolder, deleteFolder,
    offlineItems, relinkPath, relinkDir,
  };
}

module.exports = { createLibraryStore };
