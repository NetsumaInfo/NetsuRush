// @ts-check
// core/netsu/notebookDoc.js
// Un carnet DANS un conteneur .netsu : mêmes tables, mêmes requêtes, autre base.
//
// Le Carnet est déjà en SQLite (`NR_HOME/notebook/notebook.db`). Le rendre enregistrable dans un
// fichier n'a donc pas demandé d'inventer un format : on pose les MÊMES tables dans le conteneur et
// on réutilise `sqliteBackend` tel quel. C'est aussi ce qui distingue un document d'une archive —
// taper une lettre écrit UNE ligne (`page`), là où le ZIP re-sérialisait puis recompressait toutes
// les pages du carnet à chaque pause de frappe (700 ms, cf. useNotebookAutosave).
//
// Seule différence de comportement : les médias. Ils vivent dans le dossier compagnon du fichier
// (core/netsu/sidecar.js) et leur URL est rangée en token relatif (core/netsu/mediaTokens.js) —
// sinon un carnet déplacé perdrait ses images, dont l'URL porte un chemin absolu et un port.

const crypto = require('node:crypto');
const { sqliteBackend } = require('../notebook');
const { collapse, expand } = require('./mediaTokens');
const sidecar = require('./sidecar');

const DOC_TYPE = 'notebook';

/**
 * Enrobe le backend pour traduire les URL de médias dans les deux sens. Toutes les lectures qui
 * rendent des BLOCS passent par `expand`, toutes les écritures par `collapse` — en oublier une
 * laisserait fuir un chemin absolu dans le fichier, ce qui ne se voit qu'après un déplacement.
 * @param {any} backend @param {string} assetsDir @param {{ prefix?: string, suffix?: string }} url
 */
function withMediaTokens(backend, assetsDir, url) {
  const outPage = (row) => (row ? { ...row, data: expand(row.data, assetsDir, url) } : row);
  const outDb = (row) => (row ? { ...row, data: expand(row.data, assetsDir, url) } : row);
  return {
    ...backend,
    getPage: (id) => outPage(backend.getPage(id)),
    listPagesFull: (nbId) => backend.listPagesFull(nbId).map(outPage),
    putPage: (p) => backend.putPage({ ...p, data: collapse(p.data, assetsDir) }),
    getDatabase: (id) => outDb(backend.getDatabase(id)),
    listDatabases: (pageId) => backend.listDatabases(pageId).map(outDb),
    putDatabase: (id, pageId, data, ts) => backend.putDatabase(id, pageId, collapse(data, assetsDir), ts),
  };
}

/**
 * Ouvre (ou crée) le document carnet d'un conteneur. Rend le backend prêt à l'emploi et l'id du
 * carnet qu'il contient — un fichier de projet n'en porte qu'UN, c'est ce qui en fait un document.
 * `notebookId` sert à « Enregistrer sous… » : le carnet GARDE son id en déménageant, sinon les
 * `notebook_id` de ses pages, ses mentions et ses sous-pages désigneraient un carnet disparu.
 * @param {{ session: any, url?: { prefix?: string, suffix?: string }, title?: string,
 *           notebookId?: string }} args
 */
function openNotebookDoc({ session, url, title, notebookId: wanted }) {
  const assetsDir = sidecar.sidecarDirFor(session.path);
  const raw = sqliteBackend(session.handle.db);
  const backend = withMediaTokens(raw, assetsDir, url || {});

  const existing = raw.listNotebooks()[0] || null;
  const now = Date.now();
  const notebookId = existing ? String(existing.id) : (wanted || crypto.randomUUID().replace(/-/g, '').slice(0, 12));
  if (!existing) {
    raw.putNotebook(notebookId, String(title || 'Carnet'), null, null, 'notes', 'fr', now);
  }

  // Ligne `docs` : c'est elle qui fait du fichier un carnet aux yeux du reste du format (le board
  // en pose une du type `board`). Un conteneur peut donc porter les deux — le schéma est pluriel.
  session.handle.tx((db) => {
    db.prepare(
      `INSERT INTO docs (id, type, title, is_primary, data, updated_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
    ).run(notebookId, DOC_TYPE, String((existing && existing.title) || title || 'Carnet'), '{}', now);
  });

  return { backend, assetsDir, notebookId };
}

/** Le conteneur porte-t-il un carnet ? Sert à refuser d'ouvrir un board comme s'il en était un. */
function hasNotebookDoc(session) {
  const row = session.handle.db.prepare('SELECT id FROM docs WHERE type = ? LIMIT 1').get(DOC_TYPE);
  return !!row;
}

module.exports = { openNotebookDoc, hasNotebookDoc, DOC_TYPE };
