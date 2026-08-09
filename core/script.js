// @ts-check
// core/script.js
// Persistance du module Script : documents multi (1+ par projet Resolve), blocs
// (= paragraphes = coupes) et médias attachés (référence d'un MediaPoolItem + in/out frames).
// SQLite via `node:sqlite` (schéma normalisé sync-ready : UUID + updated_at + soft-delete), sinon
// repli sur un fichier JSON — MÊME API publique (le renderer ne voit pas la différence). Calque
// core/reference.js. Feuille du graphe : ne dépend que d'un répertoire de données injecté.

const path = require('path');
const { t } = require('./i18n');
const fs = require('fs');
const crypto = require('crypto');

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// Forme canonique d'un document : ids/ordre assignés, champs nettoyés. Les deux backends partent de
// là (SQLite explose en lignes, JSON stocke l'objet entier).
function normalizeDoc(full) {
  const f = full || {};
  const COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'cyan'];
  const blocks = (Array.isArray(f.blocks) ? f.blocks : []).map((b, i) => {
    const bb = b || {};
    // Compat : ancien modèle = media unique (objet) → tableau ; nouveau = tableau.
    const rawList = Array.isArray(bb.media) ? bb.media : bb.media ? [bb.media] : [];
    const media = rawList.flatMap((m, mi) => {
        if (!m || !m.filePath) return [];
        const kind = m.kind === 'audio' ? 'audio' : 'video';
        return [{
          id: m.id || uid(),
          kind,
          track: typeof m.track === 'string' ? m.track : kind === 'audio' ? 'A1' : 'V1',
          color: COLORS.includes(m.color) ? m.color : COLORS[mi % COLORS.length],
          filePath: String(m.filePath),
          resolveItemId: m.resolveItemId || null,
          inFrame: Number.isFinite(m.inFrame) ? Math.round(m.inFrame) : 0,
          outFrame: Number.isFinite(m.outFrame) ? Math.round(m.outFrame) : null,
          fps: Number(m.fps) || 0,
          label: m.label || '',
          source: ['mediapool', 'folder', 'recording'].includes(m.source) ? m.source : undefined,
          side: m.side === 'left' ? 'left' : 'block',
          mini: !!m.mini,
        }];
      });
    const level = Number.isFinite(bb.level) ? Math.min(3, Math.max(1, Math.round(bb.level))) : null;
    return {
      id: bb.id || uid(),
      type: bb.type || 'text',
      text: typeof bb.text === 'string' ? bb.text : '',
      level,
      tags: Array.isArray(bb.tags) ? bb.tags : [],
      checked: !!bb.checked,
      data: typeof bb.data === 'string' ? bb.data : '',
      order: i,
      media,
    };
  });
  // Réglages par document (surcharge de prefs + sections repliées) : objet JSON libre, nettoyé a
  // minima (objet plain ou null — jamais de valeur scalaire parasite).
  const settings = f.settings && typeof f.settings === 'object' && !Array.isArray(f.settings) ? f.settings : null;
  return {
    id: f.id || uid(),
    title: f.title || t('untitled'),
    resolveProject: f.resolveProject || null,
    settings,
    blocks,
  };
}

// --- Statistiques de document (accueil) --------------------------------------------------------
// MÊMES règles que la barre de stats du renderer (scriptShared : narrationWords/blockDurationSec) :
// titres, storyboards, encadrés et séparateurs ne sont pas narrés ; un plan vidéo trimé impose sa
// durée réelle, sinon on estime la lecture. Un chiffre différent entre la carte et le document
// ouvert serait lu comme un bug — d'où la duplication assumée de la règle (le core n'a pas de DOM).
const WPM = 200;
const NON_NARRATED = new Set(['heading', 'storyboard', 'divider', 'callout']);

// Le texte d'un bloc est du HTML. Les @mentions sont de la métadonnée, pas de la narration : on les
// retire avant comptage (le renderer supprime les mêmes nœuds `[data-page-id]`).
function plainWords(html) {
  const text = String(html || '')
    .replace(/<span[^>]*data-page-id[^>]*>[\s\S]*?<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

// Durée d'un média trimé, ou null si la coupe n'est pas connue (clip entier / audio non probé).
function cutSeconds(m) {
  if (m.kind !== 'video' || m.outFrame == null || !m.fps) return null;
  return (m.outFrame - m.inFrame + 1) / m.fps;
}

// blocks = { type, text, media[] } — accepte les deux backends (lignes SQL regroupées ou doc JSON).
function statsFromBlocks(blocks) {
  let words = 0;
  let seconds = 0;
  let media = 0;
  let sections = 0;
  for (const b of blocks) {
    const list = Array.isArray(b.media) ? b.media : [];
    media += list.length;
    if (b.type === 'heading') sections += 1;
    if (NON_NARRATED.has(b.type)) continue;
    const w = plainWords(b.text);
    words += w;
    const cuts = list.map(cutSeconds).filter((s) => s != null);
    seconds += cuts.length ? Math.max(...cuts) : (w / WPM) * 60;
  }
  return { blocks: blocks.length, words, seconds: Math.round(seconds), media, sections };
}

// --- Backend SQLite (node:sqlite, expérimental, sans compilation native) -----------------------
// IMPORTANT : on prépare un StatementSync NEUF à chaque appel (jamais mémorisé) — un statement
// conservé peut être finalisé par le GC entre deux appels → « statement has been finalized ».
function sqliteBackend(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS script_doc (' +
      'id TEXT PRIMARY KEY, resolve_project TEXT, title TEXT NOT NULL, ' +
      'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);' +
    'CREATE TABLE IF NOT EXISTS script_block (' +
      'id TEXT PRIMARY KEY, doc_id TEXT, order_index REAL, type TEXT, text TEXT, tags TEXT, ' +
      'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);' +
    'CREATE TABLE IF NOT EXISTS block_media (' +
      'id TEXT PRIMARY KEY, block_id TEXT, kind TEXT, track TEXT, color TEXT, resolve_item_id TEXT, file_path TEXT, ' +
      'in_frame INTEGER, out_frame INTEGER, fps REAL, label TEXT, order_index REAL, ' +
      'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);' +
    'CREATE TABLE IF NOT EXISTS script_version (' +
      'id TEXT PRIMARY KEY, doc_id TEXT, label TEXT, snapshot TEXT, created_at INTEGER);'
  );
  // Migration douce : colonnes ajoutées après coup (CREATE IF NOT EXISTS ne touche pas une table
  // déjà créée). Ignore « duplicate column » sur une base à jour.
  try { db.exec("ALTER TABLE block_media ADD COLUMN kind TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE block_media ADD COLUMN track TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE block_media ADD COLUMN color TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE script_block ADD COLUMN checked INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE script_block ADD COLUMN data TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE block_media ADD COLUMN side TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE block_media ADD COLUMN mini INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE script_block ADD COLUMN level INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE script_doc ADD COLUMN settings TEXT"); } catch (_) {}

  const DOC_UPSERT =
    'INSERT INTO script_doc (id, resolve_project, title, settings, created_at, updated_at, deleted_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET ' +
    'resolve_project = excluded.resolve_project, title = excluded.title, settings = excluded.settings, ' +
    'updated_at = excluded.updated_at, deleted_at = NULL';
  const BLOCK_UPSERT =
    'INSERT INTO script_block (id, doc_id, order_index, type, text, level, tags, checked, data, created_at, updated_at, deleted_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET ' +
    'order_index = excluded.order_index, type = excluded.type, text = excluded.text, ' +
    'level = excluded.level, tags = excluded.tags, checked = excluded.checked, data = excluded.data, ' +
    'updated_at = excluded.updated_at, deleted_at = NULL';
  const MEDIA_UPSERT =
    'INSERT INTO block_media (id, block_id, kind, track, color, resolve_item_id, file_path, in_frame, out_frame, fps, label, side, mini, order_index, created_at, updated_at, deleted_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET ' +
    'kind = excluded.kind, track = excluded.track, color = excluded.color, resolve_item_id = excluded.resolve_item_id, ' +
    'file_path = excluded.file_path, in_frame = excluded.in_frame, out_frame = excluded.out_frame, fps = excluded.fps, ' +
    'label = excluded.label, side = excluded.side, mini = excluded.mini, order_index = excluded.order_index, ' +
    'updated_at = excluded.updated_at, deleted_at = NULL';

  return {
    listDocs: (resolveProject) => {
      const rows = resolveProject
        ? db
            .prepare('SELECT id, title, resolve_project, updated_at FROM script_doc WHERE deleted_at IS NULL AND resolve_project = ? ORDER BY updated_at DESC')
            .all(resolveProject)
        : db
            .prepare('SELECT id, title, resolve_project, updated_at FROM script_doc WHERE deleted_at IS NULL ORDER BY updated_at DESC')
            .all();
      if (!rows.length) return [];
      // Stats des cartes d'accueil : DEUX requêtes pour toute la liste (jamais une par document).
      // La jointure sur script_block évite de lier les ids de blocs un par un — leur nombre n'est
      // pas borné, celui des documents l'est de fait.
      const ids = rows.map((r) => r.id);
      const ph = ids.map(() => '?').join(',');
      const brows = db
        .prepare(`SELECT id, doc_id, type, text FROM script_block WHERE deleted_at IS NULL AND doc_id IN (${ph})`)
        .all(...ids);
      const mrows = db
        .prepare(
          'SELECT m.block_id, m.kind, m.in_frame, m.out_frame, m.fps FROM block_media m ' +
            'JOIN script_block b ON b.id = m.block_id ' +
            `WHERE m.deleted_at IS NULL AND b.deleted_at IS NULL AND b.doc_id IN (${ph})`,
        )
        .all(...ids);
      const mediaByBlock = new Map();
      for (const m of mrows) {
        const list = mediaByBlock.get(m.block_id) || [];
        list.push({ kind: m.kind === 'audio' ? 'audio' : 'video', inFrame: m.in_frame, outFrame: m.out_frame, fps: m.fps });
        mediaByBlock.set(m.block_id, list);
      }
      const blocksByDoc = new Map();
      for (const b of brows) {
        const list = blocksByDoc.get(b.doc_id) || [];
        list.push({ type: b.type || 'text', text: b.text || '', media: mediaByBlock.get(b.id) || [] });
        blocksByDoc.set(b.doc_id, list);
      }
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        resolveProject: r.resolve_project,
        updatedAt: r.updated_at,
        stats: statsFromBlocks(blocksByDoc.get(r.id) || []),
      }));
    },
    loadDoc: (id) => {
      const doc = db.prepare('SELECT id, title, resolve_project, settings, updated_at FROM script_doc WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!doc) return null;
      let settings = null;
      try { settings = doc.settings ? JSON.parse(String(doc.settings)) : null; } catch (_) {}
      const brows = db
        .prepare('SELECT id, type, text, level, tags, checked, data, order_index FROM script_block WHERE doc_id = ? AND deleted_at IS NULL ORDER BY order_index')
        .all(id);
      const blocks = brows.map((b) => {
        const mrows = db
          .prepare('SELECT id, kind, track, color, resolve_item_id, file_path, in_frame, out_frame, fps, label, side, mini FROM block_media WHERE block_id = ? AND deleted_at IS NULL ORDER BY order_index')
          .all(b.id);
        let tags = [];
        try { tags = JSON.parse(String(b.tags || '[]')); } catch (_) {}
        return {
          id: b.id,
          type: b.type || 'text',
          text: b.text || '',
          level: b.level || null,
          tags: Array.isArray(tags) ? tags : [],
          checked: !!b.checked,
          data: b.data || '',
          order: b.order_index,
          media: mrows.map((m) => ({
            id: m.id,
            kind: m.kind === 'audio' ? 'audio' : 'video',
            track: m.track || (m.kind === 'audio' ? 'A1' : 'V1'),
            color: m.color || 'blue',
            filePath: m.file_path,
            resolveItemId: m.resolve_item_id || null,
            inFrame: m.in_frame,
            outFrame: m.out_frame,
            fps: m.fps,
            label: m.label || '',
            side: m.side === 'left' ? 'left' : 'block',
            mini: !!m.mini,
          })),
        };
      });
      return { id: doc.id, title: doc.title, resolveProject: doc.resolve_project, settings, updatedAt: doc.updated_at, blocks };
    },
    saveDoc: (full) => {
      const d = normalizeDoc(full);
      const ts = Date.now();
      db.prepare(DOC_UPSERT).run(d.id, d.resolveProject, d.title, d.settings ? JSON.stringify(d.settings) : null, ts, ts);
      const keep = [];
      for (const b of d.blocks) {
        keep.push(b.id);
        db.prepare(BLOCK_UPSERT).run(b.id, d.id, b.order, b.type, b.text, b.level, JSON.stringify(b.tags), b.checked ? 1 : 0, b.data || '', ts, ts);
        const keepMedia = [];
        b.media.forEach((m, mi) => {
          keepMedia.push(m.id);
          db.prepare(MEDIA_UPSERT).run(m.id, b.id, m.kind, m.track, m.color, m.resolveItemId, m.filePath, m.inFrame, m.outFrame, m.fps, m.label, m.side, m.mini ? 1 : 0, mi, ts, ts);
        });
        const mph = keepMedia.map(() => '?').join(',');
        const mNotIn = keepMedia.length ? ` AND id NOT IN (${mph})` : '';
        db.prepare(`UPDATE block_media SET deleted_at = ? WHERE block_id = ? AND deleted_at IS NULL${mNotIn}`).run(ts, b.id, ...keepMedia);
      }
      // Soft-delete des blocs (et leurs médias) retirés du document.
      const ph = keep.map(() => '?').join(',');
      const notIn = keep.length ? ` AND id NOT IN (${ph})` : '';
      db.prepare(`UPDATE script_block SET deleted_at = ? WHERE doc_id = ? AND deleted_at IS NULL${notIn}`).run(ts, d.id, ...keep);
      const mNotIn = keep.length ? ` AND id NOT IN (${ph})` : '';
      db.prepare(
        `UPDATE block_media SET deleted_at = ? WHERE deleted_at IS NULL AND block_id IN (SELECT id FROM script_block WHERE doc_id = ?${mNotIn})`
      ).run(ts, d.id, ...keep);
      return { ok: true, id: d.id, updatedAt: ts };
    },
    deleteDoc: (id) => {
      const ts = Date.now();
      db.prepare('UPDATE script_doc SET deleted_at = ? WHERE id = ?').run(ts, id);
      db.prepare('UPDATE script_block SET deleted_at = ? WHERE doc_id = ? AND deleted_at IS NULL').run(ts, id);
      db.prepare(
        'UPDATE block_media SET deleted_at = ? WHERE deleted_at IS NULL AND block_id IN (SELECT id FROM script_block WHERE doc_id = ?)'
      ).run(ts, id);
      db.prepare('DELETE FROM script_version WHERE doc_id = ?').run(id);
      return { ok: true };
    },
    listVersions: (docId) =>
      db
        .prepare('SELECT id, doc_id, label, created_at FROM script_version WHERE doc_id = ? ORDER BY created_at DESC')
        .all(docId)
        .map((r) => ({ id: r.id, docId: r.doc_id, label: r.label || '', createdAt: r.created_at })),
    saveVersion: (docId, label, doc) => {
      const id = uid();
      const ts = Date.now();
      db.prepare('INSERT INTO script_version (id, doc_id, label, snapshot, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, docId, label || '', JSON.stringify(normalizeDoc(doc)), ts);
      return { ok: true, id, createdAt: ts };
    },
    getVersion: (id) => {
      const r = db.prepare('SELECT id, doc_id, label, snapshot, created_at FROM script_version WHERE id = ?').get(id);
      if (!r) return null;
      let doc = null;
      try { doc = JSON.parse(String(r.snapshot || 'null')); } catch (_) {}
      return { id: r.id, docId: r.doc_id, label: r.label || '', createdAt: r.created_at, doc };
    },
    deleteVersion: (id) => {
      db.prepare('DELETE FROM script_version WHERE id = ?').run(id);
      return { ok: true };
    },
  };
}

// --- Backend JSON (repli) : un seul fichier { [id]: { ...doc, updatedAt, deletedAt } } ----------
function jsonBackend(filePath) {
  const versionsPath = path.join(path.dirname(filePath), 'versions.json');
  const read = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return {}; }
  };
  const write = (obj) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath); // rename atomique
  };
  const readVersions = () => {
    try { return JSON.parse(fs.readFileSync(versionsPath, 'utf8')); } catch (_) { return {}; }
  };
  const writeVersions = (obj) => {
    const tmp = versionsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, versionsPath);
  };
  return {
    listDocs: (resolveProject) =>
      Object.values(read()).flatMap((d) => !d.deletedAt && (!resolveProject || d.resolveProject === resolveProject)
        ? [{
            id: d.id,
            title: d.title,
            resolveProject: d.resolveProject || null,
            updatedAt: d.updatedAt,
            stats: statsFromBlocks(Array.isArray(d.blocks) ? d.blocks : []),
          }]
        : [])
        .sort((a, b) => b.updatedAt - a.updatedAt),
    loadDoc: (id) => {
      const d = read()[id];
      if (!d || d.deletedAt) return null;
      return { id: d.id, title: d.title, resolveProject: d.resolveProject || null, settings: d.settings || null, updatedAt: d.updatedAt, blocks: d.blocks || [] };
    },
    saveDoc: (full) => {
      const d = normalizeDoc(full);
      const ts = Date.now();
      const o = read();
      o[d.id] = { ...d, updatedAt: ts, deletedAt: null };
      write(o);
      return { ok: true, id: d.id, updatedAt: ts };
    },
    deleteDoc: (id) => {
      const o = read();
      if (o[id]) { o[id].deletedAt = Date.now(); write(o); }
      const v = readVersions();
      let touched = false;
      for (const k of Object.keys(v)) if (v[k].docId === id) { delete v[k]; touched = true; }
      if (touched) writeVersions(v);
      return { ok: true };
    },
    listVersions: (docId) =>
      Object.values(readVersions()).flatMap((v) => v.docId === docId
        ? [{ id: v.id, docId: v.docId, label: v.label || '', createdAt: v.createdAt }]
        : [])
        .sort((a, b) => b.createdAt - a.createdAt),
    saveVersion: (docId, label, doc) => {
      const v = readVersions();
      const id = uid();
      const ts = Date.now();
      v[id] = { id, docId, label: label || '', createdAt: ts, doc: normalizeDoc(doc) };
      writeVersions(v);
      return { ok: true, id, createdAt: ts };
    },
    getVersion: (id) => {
      const v = readVersions()[id];
      if (!v) return null;
      return { id: v.id, docId: v.docId, label: v.label || '', createdAt: v.createdAt, doc: v.doc || null };
    },
    deleteVersion: (id) => {
      const v = readVersions();
      if (v[id]) { delete v[id]; writeVersions(v); }
      return { ok: true };
    },
  };
}

function createScriptStore(dataDir) {
  const dir = path.join(dataDir, 'script');
  fs.mkdirSync(dir, { recursive: true });

  let backend;
  let kind;
  try {
    backend = sqliteBackend(path.join(dir, 'script.db'));
    kind = 'sqlite';
  } catch (_) {
    backend = jsonBackend(path.join(dir, 'docs.json'));
    kind = 'json';
  }

  return {
    kind,
    listDocs: (resolveProject) => {
      try { return backend.listDocs(resolveProject); } catch (_) { return []; }
    },
    loadDoc: (id) => {
      try { return backend.loadDoc(id); } catch (_) { return null; }
    },
    saveDoc: (full) => {
      try { return backend.saveDoc(full); } catch (e) { return { ok: false, error: String(e) }; }
    },
    deleteDoc: (id) => {
      try { return backend.deleteDoc(id); } catch (e) { return { ok: false, error: String(e) }; }
    },
    listVersions: (docId) => {
      try { return backend.listVersions(docId); } catch (_) { return []; }
    },
    saveVersion: (docId, label, doc) => {
      try { return backend.saveVersion(docId, label, doc); } catch (e) { return { ok: false, error: String(e) }; }
    },
    getVersion: (id) => {
      try { return backend.getVersion(id); } catch (_) { return null; }
    },
    deleteVersion: (id) => {
      try { return backend.deleteVersion(id); } catch (e) { return { ok: false, error: String(e) }; }
    },
  };
}

module.exports = { createScriptStore };
