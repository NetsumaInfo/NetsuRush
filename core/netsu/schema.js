// @ts-check
// core/netsu/schema.js
// Schéma du conteneur .netsu v2 (SQLite) + migrations versionnées.
//
// Le fichier .netsu n'est plus une archive écrite d'un bloc : c'est une base qu'on modifie en
// continu. D'où deux choix de structure qui portent tout le reste :
//
//   1. `board_items` = UNE LIGNE PAR ITEM. L'ancien stockage (core/reference.js, table `scenes`)
//      garde une scène entière dans une colonne TEXT : déplacer une note réécrit tout le document
//      à chaque autosave. Une ligne par item, c'est quelques centaines d'octets touchés.
//   2. `blobs` / `blob_chunks` = octets adressés par CONTENU, tranchés. Le même média posé dix fois
//      n'est stocké qu'une fois, et un gros fichier n'a jamais besoin de tenir en mémoire.
//
// `docs` est pluriel dès maintenant : un .netsu à un document est un board qu'on partage, un .netsu
// à N documents est un projet. Même format, même code — c'est le nombre de lignes qui diffère.

const SCHEMA_VERSION = 1;

const META_KEYS = {
  schemaVersion: 'schema_version',
  format: 'format',
  docId: 'doc_id',
  appVersion: 'app_version',
  createdAt: 'created_at',
  rev: 'rev',
};

const FORMAT = 'netsu';

// Les suppressions en cascade évitent les orphelins : retirer un document emporte ses items, ses
// niveaux d'embarquement et ses liens ; retirer un blob emporte ses tranches. Sans ça, un fichier
// grossit indéfiniment au fil des scènes supprimées.
const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS docs (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     is_primary INTEGER NOT NULL DEFAULT 0,
     data TEXT,
     updated_at INTEGER NOT NULL
   )`,

  // Liaison vers un AUTRE fichier .netsu : on garde son identité stable (target_doc_id) et son
  // dernier chemin connu. Le chemin seul ne suffit pas — un fichier déplacé casserait le lien.
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY,
     doc_id TEXT NOT NULL,
     target_doc_id TEXT,
     target_type TEXT,
     last_path TEXT,
     title TEXT,
     mode TEXT NOT NULL DEFAULT 'ref',
     FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
   )`,
  'CREATE INDEX IF NOT EXISTS links_by_doc ON links (doc_id)',

  // Description du média D'ORIGINE, même quand ce qui est embarqué est un dérivé (clip réencodé).
  // C'est ce qui permet au destinataire qui possède le rush de le retrouver par empreinte plutôt
  // que par chemin absolu — un chemin ne survit pas au changement de machine.
  `CREATE TABLE IF NOT EXISTS media (
     id TEXT PRIMARY KEY,
     path TEXT,
     name TEXT,
     size INTEGER NOT NULL DEFAULT 0,
     mtime INTEGER NOT NULL DEFAULT 0,
     head_sha TEXT,
     duration REAL,
     width INTEGER,
     height INTEGER,
     fps_num INTEGER,
     fps_den INTEGER,
     frames INTEGER,
     codec TEXT
   )`,

  // `chunked = 0` → les octets sont dans `data`. `chunked = 1` → ils sont dans blob_chunks.
  `CREATE TABLE IF NOT EXISTS blobs (
     sha TEXT PRIMARY KEY,
     ext TEXT NOT NULL,
     size INTEGER NOT NULL,
     chunked INTEGER NOT NULL DEFAULT 0,
     data BLOB
   )`,

  `CREATE TABLE IF NOT EXISTS blob_chunks (
     sha TEXT NOT NULL,
     idx INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (sha, idx),
     FOREIGN KEY (sha) REFERENCES blobs(sha) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS item_media (
     doc_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     level TEXT NOT NULL,
     quality TEXT,
     margin_sec REAL,
     media_id TEXT,
     poster_sha TEXT,
     clip_sha TEXT,
     clip_in REAL,
     clip_out REAL,
     PRIMARY KEY (doc_id, item_id),
     FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS board_items (
     doc_id TEXT NOT NULL,
     id TEXT NOT NULL,
     data TEXT NOT NULL,
     z REAL NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (doc_id, id),
     FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
   )`,
  'CREATE INDEX IF NOT EXISTS board_items_by_doc ON board_items (doc_id, z)',
];

// Une entrée par passage de version : MIGRATIONS[n] fait passer de la version n à n+1. Jamais de
// DROP ni de suppression de colonne — un .netsu ouvert par une version plus ancienne de l'app doit
// au pire ignorer ce qu'il ne connaît pas, jamais perdre des données.
/** @type {((db: any) => void)[]} */
const MIGRATIONS = [];

/** @param {any} db */
function applySchema(db) {
  for (const statement of DDL) db.exec(statement);
}

/**
 * Amène la base à SCHEMA_VERSION. Une version FUTURE (fichier écrit par une app plus récente) est
 * refusée explicitement : l'ouvrir quand même risquerait d'écraser des tables inconnues.
 * @param {any} db @param {number} from @returns {number} version atteinte
 */
function migrate(db, from) {
  if (from > SCHEMA_VERSION) {
    throw new Error(`.netsu écrit par une version plus récente (schéma ${from} > ${SCHEMA_VERSION})`);
  }
  let version = from;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break; // création initiale : applySchema a déjà tout posé
    step(db);
    version += 1;
  }
  return SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, META_KEYS, FORMAT, applySchema, migrate };
