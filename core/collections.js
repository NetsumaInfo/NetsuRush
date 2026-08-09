// @ts-check
// Persistance des Collections : dossiers de plans gardés pour plus tard (bibliothèque de rushs).
// Une collection = { id, name, color, icon, shots[] } ; un shot = référence LÉGÈRE d'un plan
// (chemin fichier + in/out en secondes ET frames) — vignette/proxy régénérés à la demande par le
// même cache déterministe que le derush (clé MD5 input|start|end), donc rien à dupliquer sur disque.
// Calque exact de core/reference.js : SQLite via node:sqlite si dispo, sinon repli JSON-file —
// MÊME API publique. Feuille du graphe : ne dépend que d'un répertoire de données (injecté).

const path = require('path');
const { t } = require('./i18n');
const fs = require('fs');
const crypto = require('crypto');

// Extensions d'image acceptées pour une icône de dossier uploadée.
const ICON_EXT_OK = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// Clé de dédoublonnage d'un shot dans une collection : même fichier + même frame d'entrée (ou
// seconde d'entrée si pas de frame) → considéré identique (on ne range pas deux fois le même plan).
function shotKey(s) {
  const f = s && s.inFrame != null ? `f${s.inFrame}` : `s${Number(s && s.in || 0).toFixed(3)}`;
  return `${s && s.path}|${f}`;
}

// Étiquettes : tableau de chaînes non vides, dédoublonné, plafonné (frontière IPC = données libres).
function cleanTags(t) {
  if (!Array.isArray(t)) return undefined;
  const out = [...new Set(t.flatMap((x) => {
    const value = String(x || '').trim();
    return value ? [value] : [];
  }))].slice(0, 24);
  return out.length ? out : [];
}

// Normalise un shot entrant (frontière IPC, données libres) → garde les seuls champs attendus.
function cleanShot(s) {
  return {
    id: s.id || uid(),
    path: String(s.path || ''),
    name: String(s.name || ''),
    in: Number(s.in) || 0,
    out: Number(s.out) || 0,
    inFrame: s.inFrame != null ? Math.round(Number(s.inFrame)) : undefined,
    outFrame: s.outFrame != null ? Math.round(Number(s.outFrame)) : undefined,
    srcFrames: s.srcFrames != null ? Math.round(Number(s.srcFrames)) : undefined,
    fps: s.fps != null ? Number(s.fps) : undefined,
    addedAt: s.addedAt || Date.now(),
    tags: cleanTags(s.tags),
    label: s.label != null ? String(s.label) : undefined,
    rating: s.rating != null ? Math.max(0, Math.min(5, Math.round(Number(s.rating)))) : undefined,
    note: s.note != null ? String(s.note) : undefined,
  };
}

// --- Backend SQLite (node:sqlite, sans compilation native) -------------------------------------
// StatementSync NEUF à chaque appel (jamais mémorisé) : un statement conservé peut être finalisé
// par le GC → « statement has been finalized » à la sauvegarde suivante (cf. reference.js).
const UPSERT =
  'INSERT INTO collections (id, name, data, updated_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at';

function sqliteBackend(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
  return {
    list: () =>
      db
        .prepare('SELECT id, name, data, updated_at FROM collections ORDER BY updated_at DESC')
        .all(),
    get: (id) => db.prepare('SELECT id, name, data, updated_at FROM collections WHERE id = ?').get(id) || null,
    put: (id, name, data, ts) => db.prepare(UPSERT).run(id, name, data, ts),
    del: (id) => db.prepare('DELETE FROM collections WHERE id = ?').run(id),
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

function createCollectionStore(dataDir) {
  const dir = path.join(dataDir, 'collections');
  const iconsDir = path.join(dir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });

  let backend;
  let kind;
  try {
    backend = sqliteBackend(path.join(dir, 'collections.db'));
    kind = 'sqlite';
  } catch (e) {
    backend = jsonBackend(path.join(dir, 'collections.json'));
    kind = 'json';
  }

  // Décode une ligne → collection complète. data JSON = {color, icon, shots, description, tags,
  // folderId, archive}. Les champs d'organisation (description/tags collection/dossier parent/archive)
  // sont optionnels — anciennes collections sans eux se dégradent proprement.
  function decode(row) {
    if (!row) return null;
    let parsed = {};
    try { parsed = JSON.parse(row.data) || {}; } catch (_) {}
    return {
      id: row.id,
      name: row.name,
      color: parsed.color || null,
      icon: parsed.icon || null,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      tags: cleanTags(parsed.tags) || [],
      folderId: parsed.folderId || null,
      archive: parsed.archive && typeof parsed.archive === 'object' ? parsed.archive : null,
      shots: Array.isArray(parsed.shots) ? parsed.shots : [],
      updatedAt: row.updated_at,
    };
  }

  // Sérialise TOUS les champs persistés d'une collection (jamais perdre description/tags/dossier/archive
  // quand on ne touche qu'aux shots) → utilisé par tous les backend.put.
  function encode(c, shots) {
    return JSON.stringify({
      color: c.color || null,
      icon: c.icon || null,
      description: c.description || '',
      tags: c.tags || [],
      folderId: c.folderId || null,
      archive: c.archive || null,
      shots: Array.isArray(shots) ? shots : (c.shots || []),
    });
  }

  // Méta seule (sans la liste complète des shots) → liste légère pour la grille de dossiers.
  // `preview` = jusqu'à 4 plans (mosaïque Galerie) ; `tags` = tags des plans DEDANS (chips) ; `collTags`
  // = tags de la collection (groupes, pour trier/filtrer transversalement) ; + description/folderId +
  // état d'archivage.
  function meta(c) {
    const shots = Array.isArray(c.shots) ? c.shots : [];
    const preview = [...shots]
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 4)
      .map((s) => ({ path: s.path, in: s.in, inFrame: s.inFrame, fps: s.fps }));
    const tagSet = new Set();
    const labelSet = new Set();
    for (const s of shots) {
      for (const t of (s.tags || [])) tagSet.add(t);
      if (s.label) labelSet.add(s.label);
    }
    const tags = [...tagSet].sort((a, b) => String(a).localeCompare(String(b), 'fr')).slice(0, 12);
    return {
      id: c.id, name: c.name, color: c.color, icon: c.icon, count: shots.length, updatedAt: c.updatedAt,
      preview, tags, labels: [...labelSet], collTags: c.tags || [], description: c.description || '', folderId: c.folderId || null,
      archive: c.archive || null,
      archived: !!(c.archive && c.archive.lastAt), autoSync: !!(c.archive && c.archive.autoSync),
    };
  }

  function listCollections() {
    try {
      const out = [];
      for (const item of backend.list()) out.push(meta(decode(item)));
      return out;
    } catch (_) { return []; }
  }

  function loadCollection(id) {
    return decode(backend.get(id));
  }

  // Crée ou met à jour la MÉTA (name/color/icon/description/tags/folderId/archive) sans toucher aux
  // shots (préservés). Champ absent du patch = valeur précédente conservée. Renvoie l'id.
  function saveCollection(c) {
    try {
      const id = c.id || uid();
      const prev = c.id ? loadCollection(c.id) : null;
      const shots = prev ? prev.shots : [];
      const merged = {
        color: c.color !== undefined ? c.color : (prev ? prev.color : null),
        icon: c.icon !== undefined ? c.icon : (prev ? prev.icon : null),
        description: c.description !== undefined ? String(c.description || '') : (prev ? prev.description : ''),
        tags: c.tags !== undefined ? (cleanTags(c.tags) || []) : (prev ? prev.tags : []),
        folderId: c.folderId !== undefined ? (c.folderId || null) : (prev ? prev.folderId : null),
        archive: c.archive !== undefined ? c.archive : (prev ? prev.archive : null),
      };
      const name = c.name !== undefined ? (c.name || t('untitled')) : (prev ? prev.name : t('untitled'));
      const ts = Date.now();
      backend.put(id, name, encode(merged, shots), ts);
      return { ok: true, id, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function deleteCollection(id) {
    try {
      const c = loadCollection(id);
      if (c && c.icon && c.icon.kind === 'image') removeIcon(c.icon.path);
      backend.del(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Ajoute des plans à une collection (dédoublonnés par fichier+frame). Atomique côté core → le
  // bouton « Ranger » d'une carte n'a pas besoin de charger toute la collection.
  function addShots(id, shots) {
    try {
      const c = loadCollection(id);
      if (!c) return { ok: false, error: t('collectionMissing') };
      const seen = new Set(c.shots.map(shotKey));
      let added = 0;
      for (const raw of shots || []) {
        const s = cleanShot(raw);
        if (!s.path) continue;
        const k = shotKey(s);
        if (seen.has(k)) continue;
        seen.add(k);
        c.shots.push(s);
        added++;
      }
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, c.shots), ts);
      return { ok: true, id: c.id, added, count: c.shots.length, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function removeShot(id, shotId) {
    try {
      const c = loadCollection(id);
      if (!c) return { ok: false, error: t('collectionMissing') };
      const shots = c.shots.filter((s) => s.id !== shotId);
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, shots), ts);
      return { ok: true, count: shots.length, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Édite un plan : méta d'organisation (tags / label / note étoiles / annotation) ET le plan LUI-MÊME
  // (rognage in/out + frames, renommage, repointage vers un autre fichier source). Champ absent du
  // patch = inchangé ; null = effacé.
  function updateShot(id, shotId, patch) {
    try {
      const c = loadCollection(id);
      if (!c) return { ok: false, error: t('collectionMissing') };
      const p = patch || {};
      let found = false;
      const shots = c.shots.map((s) => {
        if (s.id !== shotId) return s;
        found = true;
        const next = { ...s };
        // Méta d'organisation
        if (p.tags !== undefined) next.tags = cleanTags(p.tags) || [];
        if (p.label !== undefined) next.label = p.label == null ? undefined : String(p.label);
        if (p.rating !== undefined) next.rating = p.rating == null ? undefined : Math.max(0, Math.min(5, Math.round(Number(p.rating))));
        if (p.note !== undefined) next.note = p.note == null ? undefined : String(p.note);
        // Le plan lui-même : bornes (rognage), nom, fichier source (repointage)
        if (p.in !== undefined) next.in = Number(p.in) || 0;
        if (p.out !== undefined) next.out = Number(p.out) || 0;
        if (p.inFrame !== undefined) next.inFrame = p.inFrame == null ? undefined : Math.round(Number(p.inFrame));
        if (p.outFrame !== undefined) next.outFrame = p.outFrame == null ? undefined : Math.round(Number(p.outFrame));
        if (p.srcFrames !== undefined) next.srcFrames = p.srcFrames == null ? undefined : Math.round(Number(p.srcFrames));
        if (p.fps !== undefined) next.fps = p.fps == null ? undefined : Number(p.fps);
        if (p.name !== undefined) next.name = String(p.name || '');
        if (p.path !== undefined && p.path) next.path = String(p.path);
        return next;
      });
      if (!found) return { ok: false, error: t('shotMissing') };
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, shots), ts);
      return { ok: true, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // --- Dossiers de rangement des collections (hiérarchie façon Media Pool) -----------------------
  // Petit fichier JSON dédié (les dossiers sont peu nombreux). Chaque dossier = {id, name, parentId}
  // (parentId null = racine). Une collection porte `folderId` (null = racine).
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
      // parentId absent du patch = conservé (renommage ne doit pas remonter le dossier à la racine).
      const parentId = f && f.parentId !== undefined ? (f.parentId || null) : (existing ? existing.parentId || null : null);
      const rec = { id, name: String((f && f.name) || (existing ? existing.name : t('folderDefault'))), parentId };
      const i = all.findIndex((x) => x.id === id);
      if (i >= 0) all[i] = rec; else all.push(rec);
      writeFolders(all);
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  // Supprime un dossier : ses sous-dossiers ET ses collections remontent au parent (jamais orphelins).
  function deleteFolder(id) {
    try {
      const all = readFolders();
      const target = all.find((x) => x.id === id);
      const parent = target ? (target.parentId || null) : null;
      writeFolders(all.flatMap((x) => x.id === id ? [] : [x.parentId === id ? { ...x, parentId: parent } : x]));
      for (const m of listCollections()) {
        if (m.folderId === id) {
          const c = loadCollection(m.id);
          if (c) { c.folderId = parent; backend.put(c.id, c.name, encode(c, c.shots), Date.now()); }
        }
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  // Déplace une collection dans un dossier (folderId null = racine).
  function moveCollection(collId, folderId) {
    try {
      const c = loadCollection(collId);
      if (!c) return { ok: false, error: t('collectionMissing') };
      c.folderId = folderId || null;
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, c.shots), ts);
      return { ok: true, updatedAt: ts };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Registre GLOBAL des tags (plans + collections) → autocomplétion + recherche transversale.
  function allTags() {
    try {
      const set = new Set();
      for (const c of backend.list().map(decode)) {
        for (const t of (c.tags || [])) set.add(t);
        for (const s of (c.shots || [])) for (const t of (s.tags || [])) set.add(t);
      }
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'fr'));
    } catch (_) { return []; }
  }

  // --- Médias hors-ligne + resynchronisation ----------------------------------------------------
  // Une collection ne stocke QUE des chemins de fichiers : elle s'ouvre même logiciels fermés, mais un
  // média déplacé devient « hors-ligne ». On liste les chemins manquants (dédupliqués : une source =
  // souvent plusieurs plans) pour les relier depuis les réglages.
  function offlineShots(id) {
    try {
      const c = loadCollection(id);
      if (!c) return { ok: false, error: t('collectionMissing') };
      const seen = new Set();
      const missing = [];
      for (const s of c.shots) {
        if (!s.path || seen.has(s.path)) continue;
        seen.add(s.path);
        let ok = false;
        try { ok = fs.existsSync(s.path); } catch (_) {}
        if (!ok) missing.push({ path: s.path, name: s.name || path.basename(s.path), count: 0 });
      }
      // Nombre de plans par source manquante (info UI).
      const missingByPath = new Map(missing.map((x) => [x.path, x]));
      for (const s of c.shots) { const m = missingByPath.get(s.path); if (m) m.count++; }
      return { ok: true, missing, offline: missing.length, total: seen.size };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Repointe TOUS les plans d'une source (ancien chemin → nouveau fichier choisi). Une source sert
  // souvent plusieurs plans → on relie par chemin, pas par plan.
  function relinkPath(id, oldPath, newPath) {
    try {
      const c = loadCollection(id);
      if (!c) return { ok: false, error: t('collectionMissing') };
      if (!newPath) return { ok: false, error: t('newFileMissing') };
      let relinked = 0;
      const shots = c.shots.map((s) => (s.path === oldPath ? (relinked++, { ...s, path: String(newPath) }) : s));
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, shots), ts);
      return { ok: true, relinked };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Resynchronise en masse : indexe les fichiers d'un dossier (récursif, plafonné) par nom de base et
  // repointe chaque source hors-ligne trouvée. « Dossier de renvoi » central pour retrouver des médias
  // déplacés en bloc.
  function relinkDir(id, dir) {
    try {
      const c = loadCollection(id);
      if (!c) return { ok: false, error: t('collectionMissing') };
      if (!dir || !fs.existsSync(dir)) return { ok: false, error: t('folderMissing') };
      const index = new Map(); // basename minuscule → chemin complet (premier trouvé)
      const stack = [dir];
      let scanned = 0;
      while (stack.length && scanned < 40000) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) stack.push(full);
          else { scanned++; const k = e.name.toLowerCase(); if (!index.has(k)) index.set(k, full); }
        }
      }
      let relinked = 0;
      const shots = c.shots.map((s) => {
        if (!s.path) return s;
        let exists = false;
        try { exists = fs.existsSync(s.path); } catch (_) {}
        if (exists) return s;
        const cand = index.get(path.basename(s.path).toLowerCase());
        return cand ? (relinked++, { ...s, path: cand }) : s;
      });
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, shots), ts);
      return { ok: true, relinked };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Enregistre l'état d'archivage (après un export réussi) : dossier de stockage, profil, synchro auto.
  function markArchived(collId, extra) {
    try {
      const c = loadCollection(collId);
      if (!c) return { ok: false, error: t('collectionMissing') };
      c.archive = { ...(c.archive || {}), ...(extra || {}), lastAt: Date.now() };
      const ts = Date.now();
      backend.put(c.id, c.name, encode(c, c.shots), ts);
      return { ok: true, updatedAt: ts, archive: c.archive };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Écrit une image d'icône (uploadée) sur disque sous un nom = hash du contenu (dédup naturelle).
  // Renvoie le chemin → le renderer le sert via coreClient.mediaUrl.
  function saveIcon(bytes, ext) {
    try {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const e = ICON_EXT_OK.has(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : 'png';
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      const out = path.join(iconsDir, `${hash}.${e}`);
      if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Supprime un fichier d'icône UNIQUEMENT s'il vit sous icons/ (jamais un fichier de l'utilisateur).
  function removeIcon(p) {
    try {
      const a = path.resolve(iconsDir).toLowerCase();
      const f = path.resolve(String(p || '')).toLowerCase();
      if (f.startsWith(a + path.sep) && fs.existsSync(f)) { fs.unlinkSync(f); return { ok: true, removed: true }; }
      return { ok: true, removed: false };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return {
    kind, listCollections, loadCollection, saveCollection, deleteCollection,
    addShots, removeShot, updateShot, saveIcon, removeIcon,
    listFolders, saveFolder, deleteFolder, moveCollection, allTags, markArchived,
    offlineShots, relinkPath, relinkDir,
  };
}

module.exports = { createCollectionStore };
