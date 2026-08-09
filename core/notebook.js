// @ts-check
// Persistance du module Carnet (Notebook) : carnets (multi) → pages imbriquées (arbre) → databases.
// Espace « brouillon en vrac » — chaque page = un document par blocs (BlockNote,
// sérialisé en JSON dans la colonne `data`). SQLite via `node:sqlite` si dispo, sinon repli JSON-file —
// MÊME API publique (le renderer ne voit pas la différence). Feuille du graphe : ne dépend que d'un
// répertoire de données injecté, jamais de main.js. Même schéma que core/reference.js et core/script.js.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { t } = require('./i18n');

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// Extensions d'asset autorisées (images collées/uploadées + vidéos courtes sans chemin disque).
const EXT_OK = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'tif', 'tiff',
  'mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv', 'mp3', 'wav', 'ogg', 'm4a', 'pdf',
]);

// GET HTML plafonné (256 Ko suffisent pour les <meta>) avec UA navigateur + suivi de redirections —
// certains sites renvoient 403 sur un User-Agent nu. Sert au preview de lien (signet).
function fetchHtml(url, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('trop de redirections'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
    };
    const req = mod.get(u, { headers }, (res) => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchHtml(new URL(res.headers.location, u).toString(), (redirects || 0) + 1));
      }
      if (sc !== 200) { res.resume(); return reject(new Error('HTTP ' + sc)); }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        html += c;
        if (html.length > 256 * 1024) { req.destroy(); resolve(html); }
      });
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('délai dépassé')));
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x2[fF];/g, '/').replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function htmlAttr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:["\\\']([^"\\\']*)["\\\']|([^\\s>]+))', 'i'));
  return decodeEntities(m ? (m[1] ?? m[2] ?? '') : '');
}

// <meta property|name|itemprop="k" content="v"> → { k: v } (robuste à l'ordre des attributs).
function parseMeta(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = htmlAttr(tag, 'property') || htmlAttr(tag, 'name') || htmlAttr(tag, 'itemprop');
    const val = htmlAttr(tag, 'content');
    if (key && val != null) map[key.toLowerCase()] = decodeEntities(val);
  }
  return map;
}

// Quelques sites ne publient pas og:image mais gardent l'image canonique dans un <link> ou un
// JSON-LD. On les lit aussi afin que le bloc Signet ne devienne pas une carte vide.
function parseImageHints(html) {
  const out = {};
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = htmlAttr(tag, 'rel');
    const href = htmlAttr(tag, 'href');
    if (!href) continue;
    const rels = rel.toLowerCase().split(/\s+/);
    if (rels.includes('image_src') || (rels.includes('preload') && htmlAttr(tag, 'as').toLowerCase() === 'image')) out.image = href;
    if (rels.some((r) => r === 'icon' || r === 'shortcut' || r === 'apple-touch-icon')) out.icon = decodeEntities(href);
  }
  for (const script of html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || []) {
    const body = script.replace(/^.*?>/, '').replace(/<\/script>\s*$/i, '').trim();
    try {
      const walk = (value) => {
        if (!value || out.image) return;
        if (typeof value === 'string' && /^(https?:|\/)/i.test(value)) { out.image = decodeEntities(value); return; }
        if (Array.isArray(value)) { for (const item of value) walk(item); return; }
        if (typeof value === 'object') {
          if (value.image) walk(value.image);
          if (value.thumbnailUrl) walk(value.thumbnailUrl);
          if (value.contentUrl) walk(value.contentUrl);
          if (value.url) walk(value.url);
        }
      };
      walk(JSON.parse(body));
    } catch (_) { /* JSON-LD invalide */ }
    if (out.image) break;
  }
  // Dernier repli : les pages sans OpenGraph ont souvent une image éditoriale dans le premier <img>.
  if (!out.image) {
    for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
      const srcset = htmlAttr(tag, 'srcset');
      const firstSrcset = srcset ? srcset.split(',')[0].trim().split(/\s+/)[0] : '';
      const src = htmlAttr(tag, 'src') || htmlAttr(tag, 'data-src') || htmlAttr(tag, 'data-lazy-src') || htmlAttr(tag, 'data-original') || firstSrcset;
      if (src && !/^data:image\/(?:gif|svg\+xml);base64,/i.test(src)) { out.image = src; break; }
    }
  }
  return out;
}

// --- Backend SQLite (node:sqlite) --------------------------------------------------------------
// StatementSync NEUF à chaque appel (jamais mémorisé) : un statement conservé peut être finalisé par
// le GC entre deux appels → « statement has been finalized ». Préparer à la demande est bon marché.
// Backend SQLite. Prend un HANDLE, pas un chemin : les mêmes tables vivent soit dans la base de
// NR_HOME, soit dans un conteneur .netsu quand le carnet est un document sur disque. Une seule
// écriture de SQL pour les deux — un second jeu de requêtes finirait par diverger du premier.
function sqliteBackend(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS notebook (id TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT, script_id TEXT, kind TEXT NOT NULL DEFAULT \'notes\', language TEXT NOT NULL DEFAULT \'fr\', updated_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS page (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, icon TEXT, cover TEXT, order_idx INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS nb_database (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS page_notebook ON page(notebook_id);' +
    'CREATE INDEX IF NOT EXISTS database_page ON nb_database(page_id);',
  );
  // Migration corbeille : colonne deleted_at (soft-delete). Idempotent (déjà présente → ignore).
  try { db.exec('ALTER TABLE page ADD COLUMN deleted_at INTEGER'); } catch (_) { /* colonne existante */ }
  try { db.exec("ALTER TABLE notebook ADD COLUMN kind TEXT NOT NULL DEFAULT 'notes'"); } catch (_) { /* colonne existante */ }
  try { db.exec("ALTER TABLE notebook ADD COLUMN language TEXT NOT NULL DEFAULT 'fr'"); } catch (_) { /* colonne existante */ }
  const NB_UPSERT =
    'INSERT INTO notebook (id, title, icon, script_id, kind, language, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET title=excluded.title, icon=excluded.icon, script_id=excluded.script_id, kind=excluded.kind, language=excluded.language, updated_at=excluded.updated_at';
  const PG_UPSERT =
    'INSERT INTO page (id, notebook_id, parent_id, title, icon, cover, order_idx, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id, parent_id=excluded.parent_id, title=excluded.title, icon=excluded.icon, cover=excluded.cover, order_idx=excluded.order_idx, data=excluded.data, updated_at=excluded.updated_at';
  const DB_UPSERT =
    'INSERT INTO nb_database (id, page_id, data, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, data=excluded.data, updated_at=excluded.updated_at';
  return {
    listNotebooks: () => db.prepare('SELECT id, title, icon, script_id, kind, language, updated_at FROM notebook ORDER BY updated_at DESC').all(),
    getNotebook: (id) => db.prepare('SELECT id, title, icon, script_id, kind, language, updated_at FROM notebook WHERE id = ?').get(id) || null,
    notebookByScript: (sid) => db.prepare('SELECT id, title, icon, script_id, kind, language, updated_at FROM notebook WHERE script_id = ? ORDER BY updated_at DESC').get(sid) || null,
    putNotebook: (id, title, icon, sid, kind, language, ts) => db.prepare(NB_UPSERT).run(id, title, icon ?? null, sid ?? null, kind || 'notes', language || 'fr', ts),
    delNotebook: (id) => {
      db.prepare('DELETE FROM nb_database WHERE page_id IN (SELECT id FROM page WHERE notebook_id = ?)').run(id);
      db.prepare('DELETE FROM page WHERE notebook_id = ?').run(id);
      db.prepare('DELETE FROM notebook WHERE id = ?').run(id);
    },
    listPages: (nbId) => db.prepare('SELECT id, notebook_id, parent_id, title, icon, cover, order_idx, updated_at FROM page WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY order_idx ASC').all(nbId),
    // Toutes les pages, corbeille incluse (parcours de sous-arbre pour restore/purge).
    listPagesAll: (nbId) => db.prepare('SELECT id, notebook_id, parent_id, title, icon, cover, order_idx, updated_at, deleted_at FROM page WHERE notebook_id = ? ORDER BY order_idx ASC').all(nbId),
    listTrash: (nbId) => db.prepare('SELECT id, notebook_id, parent_id, title, icon, cover, order_idx, updated_at, deleted_at FROM page WHERE notebook_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(nbId),
    setDeleted: (ids, ts) => { for (const id of ids) db.prepare('UPDATE page SET deleted_at = ? WHERE id = ?').run(ts, id); },
    listPagesFull: (nbId) => db.prepare('SELECT id, notebook_id, parent_id, title, icon, cover, order_idx, data, updated_at FROM page WHERE notebook_id = ? AND deleted_at IS NULL').all(nbId),
    getPage: (id) => db.prepare('SELECT id, notebook_id, parent_id, title, icon, cover, order_idx, data, updated_at FROM page WHERE id = ?').get(id) || null,
    putPage: (p) => db.prepare(PG_UPSERT).run(p.id, p.notebook_id, p.parent_id ?? null, p.title, p.icon ?? null, p.cover ?? null, p.order_idx, p.data, p.updated_at),
    delPage: (id, childIds) => {
      const ids = [id, ...(childIds || [])];
      for (const pid of ids) {
        db.prepare('DELETE FROM nb_database WHERE page_id = ?').run(pid);
        db.prepare('DELETE FROM page WHERE id = ?').run(pid);
      }
    },
    listDatabases: (pageId) => db.prepare('SELECT id, page_id, data, updated_at FROM nb_database WHERE page_id = ?').all(pageId),
    getDatabase: (id) => db.prepare('SELECT id, page_id, data, updated_at FROM nb_database WHERE id = ?').get(id) || null,
    putDatabase: (id, pageId, data, ts) => db.prepare(DB_UPSERT).run(id, pageId, data, ts),
    delDatabase: (id) => db.prepare('DELETE FROM nb_database WHERE id = ?').run(id),
  };
}

// --- Backend JSON (repli) : un seul fichier { notebooks, pages, databases } --------------------
function jsonBackend(filePath) {
  const read = () => {
    try {
      const o = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { notebooks: o.notebooks || {}, pages: o.pages || {}, databases: o.databases || {} };
    } catch (_) {
      return { notebooks: {}, pages: {}, databases: {} };
    }
  };
  const write = (obj) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath); // rename atomique
  };
  return {
    listNotebooks: () => Object.values(read().notebooks).sort((a, b) => b.updated_at - a.updated_at),
    getNotebook: (id) => read().notebooks[id] || null,
    notebookByScript: (sid) => Object.values(read().notebooks).filter((n) => n.script_id === sid).sort((a, b) => b.updated_at - a.updated_at)[0] || null,
    putNotebook: (id, title, icon, sid, kind, language, ts) => {
      const o = read();
      o.notebooks[id] = { id, title, icon: icon ?? null, script_id: sid ?? null, kind: kind || 'notes', language: language || 'fr', updated_at: ts };
      write(o);
    },
    delNotebook: (id) => {
      const o = read();
      delete o.notebooks[id];
      for (const p of Object.values(o.pages)) if (p.notebook_id === id) { delete o.pages[p.id]; for (const d of Object.values(o.databases)) if (d.page_id === p.id) delete o.databases[d.id]; }
      write(o);
    },
    listPages: (nbId) => Object.values(read().pages).filter((p) => p.notebook_id === nbId && !p.deleted_at).sort((a, b) => a.order_idx - b.order_idx),
    listPagesAll: (nbId) => Object.values(read().pages).filter((p) => p.notebook_id === nbId).sort((a, b) => a.order_idx - b.order_idx),
    listTrash: (nbId) => Object.values(read().pages).filter((p) => p.notebook_id === nbId && p.deleted_at).sort((a, b) => b.deleted_at - a.deleted_at),
    setDeleted: (ids, ts) => {
      const o = read();
      for (const id of ids) if (o.pages[id]) o.pages[id].deleted_at = ts;
      write(o);
    },
    listPagesFull: (nbId) => Object.values(read().pages).filter((p) => p.notebook_id === nbId && !p.deleted_at),
    getPage: (id) => read().pages[id] || null,
    putPage: (p) => {
      const o = read();
      o.pages[p.id] = { ...p, parent_id: p.parent_id ?? null, icon: p.icon ?? null, cover: p.cover ?? null };
      write(o);
    },
    delPage: (id, childIds) => {
      const o = read();
      for (const pid of [id, ...(childIds || [])]) {
        delete o.pages[pid];
        for (const d of Object.values(o.databases)) if (d.page_id === pid) delete o.databases[d.id];
      }
      write(o);
    },
    listDatabases: (pageId) => Object.values(read().databases).filter((d) => d.page_id === pageId),
    getDatabase: (id) => read().databases[id] || null,
    putDatabase: (id, pageId, data, ts) => {
      const o = read();
      o.databases[id] = { id, page_id: pageId, data, updated_at: ts };
      write(o);
    },
    delDatabase: (id) => {
      const o = read();
      delete o.databases[id];
      write(o);
    },
  };
}

// Ligne notebook (colonnes) → méta renderer (camelCase).
function nbMeta(r) {
  return { id: r.id, title: r.title, icon: r.icon || null, scriptId: r.script_id || null, kind: r.kind || 'notes', language: r.language || 'fr', updatedAt: r.updated_at };
}
// Ligne page → méta d'arbre (SANS le doc de blocs, léger pour la sidebar).
function pageMeta(r) {
  return { id: r.id, notebookId: r.notebook_id, parentId: r.parent_id || null, title: r.title, icon: r.icon || null, cover: r.cover || null, orderIdx: r.order_idx, updatedAt: r.updated_at };
}

/**
 * Un magasin de carnets sur un backend donné. Extrait de `createNotebookStore` pour qu'un carnet
 * puisse vivre AILLEURS que dans la base de NR_HOME — un conteneur .netsu, quand le carnet est un
 * document sur disque. Le backend et le dossier d'assets sont les deux seules choses qui changent
 * d'un magasin à l'autre ; tout le reste est identique, et le rester est le but de cette extraction.
 * @param {{ backend: any, assetsDir: string, kind: string }} args
 */
function makeNotebookStore({ backend, assetsDir, kind }) {
  fs.mkdirSync(assetsDir, { recursive: true });

  // --- Carnets -------------------------------------------------------------------------------
  function listNotebooks() {
    try { return backend.listNotebooks().map(nbMeta); } catch (_) { return []; }
  }

  function saveNotebook(nb) {
    try {
      const id = nb.id || uid();
      const ts = Date.now();
      backend.putNotebook(id, nb.title || 'Nouveau carnet', nb.icon ?? null, nb.scriptId ?? null, nb.kind || 'notes', nb.language || 'fr', ts);
      return { ok: true, id, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function deleteNotebook(id) {
    try { backend.delNotebook(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Carnet lié à un script (bouton « Carnet » du module Script) : renvoie l'existant ou en crée un.
  function notebookForScript(scriptId, title) {
    try {
      const existing = backend.notebookByScript(scriptId);
      if (existing) return { ok: true, notebook: nbMeta(existing), created: false };
      const id = uid();
      const ts = Date.now();
      backend.putNotebook(id, title || t('projectFolderDefault'), null, scriptId, 'script', 'fr', ts);
      return { ok: true, notebook: nbMeta({ id, title: title || t('projectFolderDefault'), icon: null, script_id: scriptId, kind: 'script', language: 'fr', updated_at: ts }), created: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Carnet + arbre de pages (métas seules, sans les docs de blocs → sidebar légère).
  function loadNotebook(id) {
    try {
      const nb = backend.getNotebook(id);
      if (!nb) return null;
      const pages = backend.listPages(id).map(pageMeta);
      return { notebook: nbMeta(nb), pages };
    } catch (_) {
      return null;
    }
  }

  // --- Pages ---------------------------------------------------------------------------------
  function loadPage(id) {
    const row = backend.getPage(id);
    if (!row) return null;
    let blocks = [];
    try { blocks = JSON.parse(row.data) || []; } catch (_) {}
    const databases = {};
    try {
      for (const d of backend.listDatabases(id)) {
        try { databases[d.id] = JSON.parse(d.data); } catch (_) {}
      }
    } catch (_) {}
    return { page: { ...pageMeta(row), blocks }, databases };
  }

  function savePage(page) {
    try {
      const id = page.id || uid();
      const ts = Date.now();
      backend.putPage({
        id,
        notebook_id: page.notebookId,
        parent_id: page.parentId ?? null,
        title: page.title || t('untitled'),
        icon: page.icon ?? null,
        cover: page.cover ?? null,
        order_idx: typeof page.orderIdx === 'number' ? page.orderIdx : Date.now(),
        data: JSON.stringify(page.blocks || []),
        updated_at: ts,
      });
      // Touche le carnet pour le tri « récents » de la sidebar.
      const nb = backend.getNotebook(page.notebookId);
      if (nb) backend.putNotebook(nb.id, nb.title, nb.icon, nb.script_id, nb.kind, nb.language, ts);
      return { ok: true, id, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Suppression DOUCE (corbeille) : marque deleted_at sur toute la sous-arborescence. Les pages
  // restent en base (restaurables) ; les listes/rétroliens/recherche les excluent.
  function deletePage(id) {
    try {
      const all = collectSubtree(id);
      backend.setDeleted(all, Date.now());
      return { ok: true, removed: all };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Ids d'une page et de toute sa descendance (via les parent_id du carnet, corbeille incluse —
  // restore/purge doivent parcourir les enfants déjà supprimés).
  function collectSubtree(rootId) {
    const root = backend.getPage(rootId);
    if (!root) return [rootId];
    const siblings = backend.listPagesAll(root.notebook_id);
    const childrenOf = (pid) => siblings.flatMap((p) => (p.parent_id || null) === pid ? [p.id] : []);
    const out = [];
    const walk = (pid) => { out.push(pid); for (const c of childrenOf(pid)) walk(c); };
    walk(rootId);
    return out;
  }

  // Duplique une page et toute sa descendance (+ databases). Ids régénérés ; les références internes
  // au sous-arbre (sous-pages, mentions, blocs database) sont remappées vers les copies par
  // remplacement textuel dans le JSON des blocs (ids = 12 hex aléatoires → collision négligeable).
  function duplicatePage(id) {
    try {
      const src = backend.getPage(id);
      if (!src) return { ok: false, error: t('pageMissing') };
      const ids = collectSubtree(id);
      const idMap = new Map(ids.map((x) => [x, uid()]));
      const ts = Date.now();
      for (const pid of ids) {
        const row = backend.getPage(pid);
        if (!row || row.deleted_at) continue; // enfants déjà en corbeille → pas copiés
        const dbMap = new Map();
        for (const d of backend.listDatabases(pid)) {
          const nid = uid();
          dbMap.set(d.id, nid);
          backend.putDatabase(nid, idMap.get(pid), d.data, ts);
        }
        let data = row.data;
        for (const [oldId, newId] of [...idMap, ...dbMap]) data = data.split(oldId).join(newId);
        backend.putPage({
          id: idMap.get(pid),
          notebook_id: row.notebook_id,
          parent_id: pid === id ? (row.parent_id ?? null) : (idMap.get(row.parent_id) ?? row.parent_id ?? null),
          title: pid === id ? `${row.title} (${t('copySuffix')})` : row.title,
          icon: row.icon ?? null,
          cover: row.cover ?? null,
          order_idx: pid === id ? row.order_idx + 1 : row.order_idx,
          data,
          updated_at: ts,
        });
      }
      return { ok: true, id: idMap.get(id) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // --- Corbeille ------------------------------------------------------------------------------
  function trashList(notebookId) {
    try { return backend.listTrash(notebookId).map(pageMeta); } catch (_) { return []; }
  }

  function restorePage(id) {
    try {
      const all = collectSubtree(id);
      backend.setDeleted(all, null);
      // Parent encore en corbeille (ou disparu) → re-racine la page restaurée (sinon orpheline).
      const row = backend.getPage(id);
      if (row && row.parent_id) {
        const parent = backend.getPage(row.parent_id);
        if (!parent || parent.deleted_at) backend.putPage({ ...row, parent_id: null });
      }
      return { ok: true, restored: all };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Suppression DÉFINITIVE (depuis la corbeille) : hard-delete sous-arbre + databases.
  function purgePage(id) {
    try {
      const all = collectSubtree(id);
      backend.delPage(id, all.filter((x) => x !== id));
      return { ok: true, removed: all };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function emptyTrash(notebookId) {
    try {
      const rows = backend.listTrash(notebookId);
      for (const row of rows) backend.delPage(row.id, []);
      return { ok: true, removed: rows.length };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // --- Recherche plein-texte (titres + texte des blocs) ----------------------------------------
  // Renvoie [{pageId,title,icon,snippet,blockId}] — blockId = 1er bloc contenant le terme (ancre).
  function searchNotebook(notebookId, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    try {
      for (const row of backend.listPagesFull(notebookId)) {
        let blocks = [];
        try { blocks = JSON.parse(row.data) || []; } catch (_) { continue; }
        const titleHit = String(row.title || '').toLowerCase().includes(q);
        /** @type {{blockId:string,text:string}|null} */
        let hit = null;
        const walk = (bs) => {
          for (const b of bs || []) {
            if (hit) return;
            if (!b || typeof b !== 'object') continue;
            const txt = blockText(b);
            if (txt && txt.toLowerCase().includes(q)) { hit = { blockId: b.id || '', text: txt }; return; }
            if (Array.isArray(b.children)) walk(b.children);
          }
        };
        walk(blocks);
        if (titleHit || hit) {
          let snippet = '';
          if (hit) {
            const i = hit.text.toLowerCase().indexOf(q);
            const start = Math.max(0, i - 40);
            const end = Math.min(hit.text.length, i + q.length + 60);
            snippet = (start > 0 ? '…' : '') + hit.text.slice(start, end) + (end < hit.text.length ? '…' : '');
          }
          out.push({ pageId: row.id, title: row.title, icon: row.icon || null, snippet, blockId: hit ? hit.blockId : '' });
          if (out.length >= 50) break;
        }
      }
    } catch (_) { /* backend indisponible */ }
    return out;
  }

  // --- Databases (bloc /database d'une page) -------------------------------------------------
  function saveDatabase(db) {
    try {
      const id = db.id || uid();
      const ts = Date.now();
      backend.putDatabase(id, db.pageId, JSON.stringify(stripPageId(db)), ts);
      return { ok: true, id, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function deleteDatabase(id) {
    try { backend.delDatabase(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  }

  // --- Rétroliens (@mention) : pages du carnet qui mentionnent la page cible -------------------
  function backlinks(notebookId, targetPageId) {
    try {
      const out = [];
      for (const row of backend.listPagesFull(notebookId)) {
        if (row.id === targetPageId) continue;
        let blocks = [];
        try { blocks = JSON.parse(row.data) || []; } catch (_) { continue; }
        if (mentionsPage(blocks, targetPageId)) out.push(pageMeta(row));
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  // --- Assets (médias uploadés/collés depuis l'ordinateur) -----------------------------------
  // Écrit un blob sur disque sous un nom = hash de contenu (dédup naturelle). Le renderer le sert
  // ensuite via /media (coreClient.mediaUrl). Alimente l'uploadFile de BlockNote (image/vidéo/fichier).
  function saveAsset(bytes, ext) {
    try {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const e = EXT_OK.has(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : 'png';
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      const out = path.join(assetsDir, `${hash}.${e}`);
      if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Lit un asset local et renvoie ses octets en base64 (le renderer ne peut PAS `fetch` /media :
  // cross-origin sans CORS → « Failed to fetch »). Passe donc par RPC (CORS ouvert). Chemin borné au
  // dossier assets du carnet (anti-traversée) → seuls les fichiers qu'on a écrits sont lisibles.
  function readAsset(filePath) {
    try {
      const abs = path.resolve(String(filePath || ''));
      const root = path.resolve(assetsDir);
      if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: false, error: t('assetOutside') };
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: t('notFound') };
      return { ok: true, b64: fs.readFileSync(abs).toString('base64') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Écrit un export de page (Markdown/HTML) sur disque — extensions texte seulement (garde-fou).
  function writeExport(filePath, text) {
    try {
      const abs = path.resolve(String(filePath || ''));
      const ext = path.extname(abs).toLowerCase();
      if (!['.md', '.html', '.txt'].includes(ext)) return { ok: false, error: t('extensionDenied') };
      fs.writeFileSync(abs, String(text ?? ''), 'utf8');
      return { ok: true, path: abs };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // --- Preview de lien (signet) : OpenGraph/Twitter Card → carte {title, description, image…} ---
  async function linkMeta(url) {
    try {
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: t('invalidUrl') };
      const u = new URL(url);
      const html = await fetchHtml(url);
      const m = parseMeta(html);
      const hints = parseImageHints(html);
      const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
      const abs = (v) => { if (!v) return null; try { return new URL(v, url).toString(); } catch (_) { return null; } };
      const meta = {
        url,
        title: m['og:title'] || m['twitter:title'] || decodeEntities(titleTag) || u.hostname,
        description: m['og:description'] || m['twitter:description'] || m['description'] || '',
        image: abs(m['og:image:secure_url'] || m['og:image:url'] || m['og:image'] || m['twitter:image'] || m['twitter:image:src'] || m.image || hints.image) || '',
        siteName: m['og:site_name'] || u.hostname,
        favicon: abs(hints.icon) || `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`,
      };
      return { ok: true, meta };
    } catch (e) {
      // Repli minimal : au moins le domaine (le renderer affiche une carte nue plutôt qu'un échec).
      try { const u = new URL(url); return { ok: true, meta: { url, title: u.hostname, description: '', image: '', siteName: u.hostname, favicon: `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64` } }; }
      catch (_) { return { ok: false, error: String(e) }; }
    }
  }

  // --- Recopie d'un carnet d'un magasin à l'autre (« Enregistrer sous… ») ---------------------
  // Le dump porte les pages de la CORBEILLE aussi : « enregistrer sous » doit rendre le même carnet,
  // pas une version amputée de ce que l'utilisateur croyait pouvoir restaurer.
  function dumpNotebook(notebookId) {
    const nb = backend.getNotebook(notebookId);
    if (!nb) return null;
    const pages = [];
    const databases = [];
    for (const meta of backend.listPagesAll(notebookId)) {
      const row = backend.getPage(meta.id);
      if (!row) continue;
      pages.push({ ...row, deleted_at: meta.deleted_at || null });
      for (const d of backend.listDatabases(meta.id)) databases.push(d);
    }
    return { notebook: nb, pages, databases };
  }

  /**
   * Écrit un dump dans ce magasin. `mapData` traduit les médias au passage (les URL du magasin
   * source ne veulent rien dire ici) ; sans lui, un carnet enregistré ailleurs pointerait encore
   * vers les fichiers de la machine d'origine.
   * @param {any} dump @param {{ notebookId?: string, mapData?: (json: string) => string }} [opts]
   */
  function restoreNotebook(dump, opts) {
    const options = opts || {};
    const mapData = options.mapData || ((json) => json);
    const nb = dump.notebook;
    const notebookId = options.notebookId || nb.id;
    const ts = Date.now();
    backend.putNotebook(notebookId, nb.title, nb.icon ?? null, nb.script_id ?? null, nb.kind || 'notes', nb.language || 'fr', ts);
    for (const page of dump.pages) {
      backend.putPage({ ...page, notebook_id: notebookId, data: mapData(page.data) });
    }
    for (const db of dump.databases) backend.putDatabase(db.id, db.page_id, mapData(db.data), db.updated_at || ts);
    // `putPage` n'écrit pas la corbeille (pas de colonne dans l'upsert) : on la repose ensuite.
    const trashed = dump.pages.filter((p) => p.deleted_at).map((p) => p.id);
    if (trashed.length) backend.setDeleted(trashed, ts);
    return { ok: true, notebookId, pages: dump.pages.length, databases: dump.databases.length };
  }

  // Appartenance : le routeur (createNotebookStore) doit savoir QUEL magasin détient un id quand
  // l'appel n'en porte pas le carnet — `loadPage(id)` n'a que l'id de la page.
  const ownsNotebook = (id) => { try { return !!backend.getNotebook(id); } catch (_) { return false; } };
  const ownsPage = (id) => { try { return !!backend.getPage(id); } catch (_) { return false; } };
  const ownsDatabase = (id) => { try { return !!backend.getDatabase(id); } catch (_) { return false; } };
  const ownsAsset = (p) => {
    const abs = path.resolve(String(p || ''));
    const root = path.resolve(assetsDir);
    return abs === root || abs.startsWith(root + path.sep);
  };

  return {
    kind, assetsDir,
    listNotebooks, saveNotebook, deleteNotebook, notebookForScript, loadNotebook,
    loadPage, savePage, deletePage, duplicatePage,
    trashList, restorePage, purgePage, emptyTrash, searchNotebook,
    saveDatabase, deleteDatabase,
    backlinks, saveAsset, readAsset, linkMeta, writeExport,
    dumpNotebook, restoreNotebook,
    ownsNotebook, ownsPage, ownsDatabase, ownsAsset,
  };
}

/**
 * Le magasin exposé au RPC : celui de NR_HOME, plus un par carnet-DOCUMENT ouvert.
 *
 * Les canaux du Carnet ne portent pas tous le carnet visé — `loadPage(id)` n'a que l'id de la page.
 * Le routage se fait donc par l'id le plus précis disponible, et à défaut en demandant aux magasins
 * lequel détient l'objet (un `SELECT` sur clé primaire, pas un parcours). Les fichiers passent
 * AVANT le magasin de NR_HOME : après « Enregistrer sous », c'est le fichier qui fait foi.
 */
function createNotebookStore(dataDir) {
  const dir = path.join(dataDir, 'notebook');
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true }); // avant d'ouvrir la base : elle vit dans ce dossier

  let backend;
  let kind;
  try {
    const { DatabaseSync } = require('node:sqlite');
    backend = sqliteBackend(new DatabaseSync(path.join(dir, 'notebook.db')));
    kind = 'sqlite';
  } catch (e) {
    backend = jsonBackend(path.join(dir, 'notebook.json'));
    kind = 'json';
  }
  const home = makeNotebookStore({ backend, assetsDir, kind });

  /** @type {Map<string, { path: string, store: any, session: any, notebookId: string }>} */
  const files = new Map();
  const fileKey = (filePath) => path.resolve(String(filePath || '')).toLowerCase();
  const fileStores = () => [...files.values()].map((f) => f.store);
  const find = (probe) => fileStores().find(probe) || home;

  const byNotebook = (id) => find((s) => s.ownsNotebook(id));
  const byPage = (id) => find((s) => s.ownsPage(id));
  const byDatabase = (id) => find((s) => s.ownsDatabase(id));

  // Les dépendances du format .netsu sont chargées À L'APPEL : elles-mêmes requièrent ce module
  // (sqliteBackend), et un require au sommet fermerait le cycle sur un module à moitié évalué.
  const netsuDeps = () => ({
    sessions: require('./netsu/session'),
    recents: require('./netsu/recents'),
    sidecar: require('./netsu/sidecar'),
    tokens: require('./netsu/mediaTokens'),
    doc: require('./netsu/notebookDoc'),
  });

  /**
   * Ouvre un carnet-document. `url` = gabarit d'URL /media du renderer : lui seul connaît sa base et
   * son jeton, et sans lui les médias du carnet ne peuvent pas être reconstruits (cf. mediaTokens).
   * @param {string} filePath @param {{ prefix?: string, suffix?: string }} [url]
   */
  function openProject(filePath, url) {
    const { sessions, recents, doc } = netsuDeps();
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: t('notFound') };
      const already = files.get(fileKey(filePath));
      if (already) return { ok: true, path: already.path, notebookId: already.notebookId, reused: true };

      const session = sessions.openSession(filePath, { create: false });
      // Un .netsu de board n'est pas un carnet : le dire plutôt que d'ouvrir un carnet vide à côté.
      const board = session.handle.db.prepare("SELECT id FROM docs WHERE type = 'board' LIMIT 1").get();
      if (board && !doc.hasNotebookDoc(session)) {
        sessions.closeSession(filePath);
        return { ok: false, error: t('unsupportedType') + ': board' };
      }
      const opened = doc.openNotebookDoc({ session, url });
      const store = makeNotebookStore({ backend: opened.backend, assetsDir: opened.assetsDir, kind: 'netsu' });
      const entry = { path: session.path, store, session, notebookId: opened.notebookId };
      files.set(fileKey(session.path), entry);
      const meta = store.loadNotebook(opened.notebookId);
      recents.remember({ path: session.path, title: meta ? meta.notebook.title : '', type: 'notebook' });
      return { ok: true, path: session.path, notebookId: opened.notebookId };
    } catch (e) {
      try { netsuDeps().sessions.closeSession(filePath); } catch (_) { /* jamais ouverte */ }
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * « Enregistrer sous… » : recopie le carnet dans un .netsu neuf, médias compris, et bascule
   * dessus. Le carnet SOURCE n'est retiré de NR_HOME qu'APRÈS vérification du nombre de pages
   * écrites — un disque plein ne doit pas laisser l'utilisateur sans carnet du tout.
   * @param {{ notebookId: string, destPath: string, url?: { prefix?: string, suffix?: string } }} args
   */
  function saveProjectAs({ notebookId, destPath, url }) {
    const { sessions, recents, sidecar, tokens, doc } = netsuDeps();
    if (!destPath) return { ok: false, error: t('destinationMissing') };
    const source = byNotebook(notebookId);
    const dump = source.dumpNotebook(notebookId);
    if (!dump) return { ok: false, error: t('notebookMissing') };
    const fromFile = [...files.values()].find((f) => f.store === source) || null;

    try {
      sessions.closeSession(destPath);
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(destPath + suffix, { force: true });

      const session = sessions.openSession(destPath, { create: true });
      const opened = doc.openNotebookDoc({ session, url, title: dump.notebook.title, notebookId });
      const store = makeNotebookStore({ backend: opened.backend, assetsDir: opened.assetsDir, kind: 'netsu' });
      // Les médias du magasin source déménagent dans le dossier compagnon du NOUVEAU fichier.
      const adopt = (abs) => {
        const moved = sidecar.adopt(session.path, abs);
        return moved.ok && moved.path ? moved.path : null;
      };
      const written = store.restoreNotebook(dump, {
        notebookId,
        mapData: (json) => tokens.rebase(json, source.assetsDir, adopt),
      });

      const check = store.loadNotebook(notebookId);
      const livePages = dump.pages.filter((p) => !p.deleted_at).length;
      if (!check || check.pages.length !== livePages) {
        sessions.closeSession(destPath);
        return { ok: false, error: t('saveFailed') };
      }

      files.set(fileKey(session.path), { path: session.path, store, session, notebookId });
      // Le document a DÉMÉNAGÉ : on retire la copie d'origine, sinon deux carnets du même id
      // vivraient côte à côte et divergeraient dès la frappe suivante.
      if (fromFile) {
        sessions.closeSession(fromFile.path);
        files.delete(fileKey(fromFile.path));
      } else {
        home.deleteNotebook(notebookId);
      }
      recents.remember({ path: session.path, title: dump.notebook.title, type: 'notebook' });
      return { ok: true, path: session.path, notebookId, ...written };
    } catch (e) {
      sessions.closeSession(destPath);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function closeProject(filePath) {
    const { sessions } = netsuDeps();
    const key = fileKey(filePath);
    const entry = files.get(key);
    if (!entry) return { ok: true, closed: false };
    files.delete(key);
    sessions.closeSession(entry.path);
    return { ok: true, closed: true };
  }

  /** Le carnet est-il un document sur disque ? Le renderer l'affiche (et propose « Enregistrer sous »). */
  function projectOf(notebookId) {
    const entry = [...files.values()].find((f) => f.notebookId === notebookId);
    return entry ? { path: entry.path } : null;
  }

  function closeAllProjects() {
    for (const key of [...files.keys()]) closeProject(key);
  }

  return {
    kind,
    // Carnets : la liste réunit NR_HOME et les documents ouverts, ces derniers en tête (ce sont ceux
    // sur lesquels on travaille), et dédoublonnée par id — un carnet ne doit apparaître qu'une fois.
    listNotebooks: () => {
      const seen = new Set();
      const out = [];
      for (const store of [...fileStores(), home]) {
        for (const nb of store.listNotebooks()) {
          if (seen.has(nb.id)) continue;
          seen.add(nb.id);
          out.push(nb);
        }
      }
      return out;
    },
    saveNotebook: (nb) => (nb && nb.id ? byNotebook(nb.id) : home).saveNotebook(nb),
    deleteNotebook: (id) => byNotebook(id).deleteNotebook(id),
    notebookForScript: (scriptId, title) => home.notebookForScript(scriptId, title),
    loadNotebook: (id) => byNotebook(id).loadNotebook(id),

    loadPage: (id) => byPage(id).loadPage(id),
    savePage: (page) => (page && page.notebookId ? byNotebook(page.notebookId) : home).savePage(page),
    deletePage: (id) => byPage(id).deletePage(id),
    duplicatePage: (id) => byPage(id).duplicatePage(id),
    trashList: (id) => byNotebook(id).trashList(id),
    restorePage: (id) => byPage(id).restorePage(id),
    purgePage: (id) => byPage(id).purgePage(id),
    emptyTrash: (id) => byNotebook(id).emptyTrash(id),
    searchNotebook: (id, query) => byNotebook(id).searchNotebook(id, query),

    saveDatabase: (db) => (db && db.pageId ? byPage(db.pageId) : home).saveDatabase(db),
    deleteDatabase: (id) => byDatabase(id).deleteDatabase(id),
    backlinks: (notebookId, pageId) => byNotebook(notebookId).backlinks(notebookId, pageId),

    // Un asset appartient au carnet où on le colle : dans un document, il va au dossier compagnon.
    saveAsset: (bytes, ext, notebookId) => (notebookId ? byNotebook(notebookId) : home).saveAsset(bytes, ext),
    readAsset: (filePath) => find((s) => s.ownsAsset(filePath)).readAsset(filePath),
    linkMeta: home.linkMeta,
    writeExport: home.writeExport,

    openProject, saveProjectAs, closeProject, closeAllProjects, projectOf,
  };
}

// Texte brut d'un bloc BlockNote : concatène les `text` du contenu inline (+ labels des mentions).
function blockText(b) {
  const content = b && b.content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.text === 'string') s += c.text;
    else if (c.props && typeof c.props.label === 'string') s += c.props.label;
    else if (Array.isArray(c.content)) { for (const cc of c.content) if (cc && typeof cc.text === 'string') s += cc.text; }
  }
  return s;
}

// pageId ne se persiste pas DANS le blob data (déjà en colonne).
function stripPageId(db) {
  const { pageId, ...rest } = db || {};
  return rest;
}

// Parcourt récursivement un arbre de blocs BlockNote à la recherche d'un inline `pageMention`
// pointant sur targetPageId (props.pageId). Robuste aux blocs imbriqués (children) et au contenu inline.
function mentionsPage(blocks, targetPageId) {
  if (!Array.isArray(blocks)) return false;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const content = b.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'pageMention' && c.props && c.props.pageId === targetPageId) return true;
      }
    }
    if (Array.isArray(b.children) && mentionsPage(b.children, targetPageId)) return true;
  }
  return false;
}

module.exports = { createNotebookStore, sqliteBackend };
