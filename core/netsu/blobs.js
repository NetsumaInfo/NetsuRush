// @ts-check
// core/netsu/blobs.js
// Octets stockés dans un .netsu, adressés par CONTENU et tranchés.
//
// Deux contraintes dictent tout ce fichier :
//
//   1. `node:sqlite` n'expose pas l'API blob incrémentale de SQLite. Écrire un BLOB, c'est le
//      passer entier en paramètre — donc le tenir entier en mémoire. Embarquer un rush de 4 Go
//      ferait exploser le process (c'est le défaut de l'ancien writer ZIP, qui faisait
//      `readFileSync` puis `Buffer.concat`). On tranche donc en morceaux de taille fixe : la
//      mémoire reste plate quelle que soit la taille du média.
//   2. L'adressage par contenu donne la déduplication gratuitement. Le même plan posé dix fois sur
//      un board n'occupe qu'une place, et un ré-export ne réécrit que ce qui a changé.
//
// Les tranches permettent aussi de relire une PLAGE d'octets (`readRange`) sans tout recoller :
// c'est ce qui rendra possible, plus tard, de servir une vidéo embarquée en HTTP Range depuis le
// fichier de projet.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// 8 Mio : assez gros pour que le surcoût par ligne soit négligeable, assez petit pour qu'une
// tranche en mémoire ne se voie pas.
const CHUNK_BYTES = 8 * 1024 * 1024;

/** @param {Buffer|Uint8Array} bytes */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** @param {unknown} value @returns {Buffer} */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

/** @param {any} db @param {string} sha @returns {{ sha: string, ext: string, size: number, chunked: boolean }|null} */
function blobInfo(db, sha) {
  const row = db.prepare('SELECT sha, ext, size, chunked FROM blobs WHERE sha = ?').get(sha);
  if (!row) return null;
  return { sha: String(row.sha), ext: String(row.ext), size: Number(row.size), chunked: !!row.chunked };
}

/** @param {any} db @param {string} sha */
function hasBlob(db, sha) {
  return !!db.prepare('SELECT 1 FROM blobs WHERE sha = ?').get(sha);
}

/**
 * Range des octets déjà en mémoire (poster, vignette, petite image collée).
 * @param {any} db @param {Buffer} buf @param {string} ext @returns {string} sha
 */
function putBuffer(db, buf, ext) {
  const sha = sha256(buf);
  if (hasBlob(db, sha)) return sha; // même contenu = même ligne, on ne réécrit rien
  if (buf.length <= CHUNK_BYTES) {
    db.prepare('INSERT INTO blobs (sha, ext, size, chunked, data) VALUES (?, ?, ?, 0, ?)')
      .run(sha, ext, buf.length, buf);
    return sha;
  }
  db.prepare('INSERT INTO blobs (sha, ext, size, chunked, data) VALUES (?, ?, ?, 1, NULL)')
    .run(sha, ext, buf.length);
  const insert = 'INSERT INTO blob_chunks (sha, idx, data) VALUES (?, ?, ?)';
  for (let offset = 0, idx = 0; offset < buf.length; offset += CHUNK_BYTES, idx += 1) {
    db.prepare(insert).run(sha, idx, buf.subarray(offset, Math.min(offset + CHUNK_BYTES, buf.length)));
  }
  return sha;
}

/**
 * Empreinte d'un fichier, lue par tranches — un fichier de plusieurs Go ne passe jamais en entier
 * par la mémoire.
 * @param {string} filePath @returns {{ sha: string, size: number }}
 */
function hashFile(filePath) {
  const size = fs.statSync(filePath).size;
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let offset = 0; offset < size; ) {
      const read = fs.readSync(fd, buf, 0, CHUNK_BYTES, offset);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha: hash.digest('hex'), size };
}

/**
 * Range un fichier du disque. Deux passes assumées : la première calcule l'empreinte, la seconde
 * n'écrit QUE si ce contenu est absent. Dédupliquer avant d'écrire est ce qui compte — sur un
 * ré-export, le cas courant est justement de ne rien réécrire du tout.
 * @param {any} db @param {string} filePath @param {string} [ext] @returns {{ sha: string, size: number }}
 */
function putFile(db, filePath, ext) {
  const extension = String(ext || path.extname(filePath).slice(1) || 'bin').toLowerCase();
  const { sha, size } = hashFile(filePath);
  if (hasBlob(db, sha)) return { sha, size };

  if (size <= CHUNK_BYTES) {
    db.prepare('INSERT INTO blobs (sha, ext, size, chunked, data) VALUES (?, ?, ?, 0, ?)')
      .run(sha, extension, size, fs.readFileSync(filePath));
    return { sha, size };
  }

  db.prepare('INSERT INTO blobs (sha, ext, size, chunked, data) VALUES (?, ?, ?, 1, NULL)')
    .run(sha, extension, size);
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let offset = 0, idx = 0; offset < size; idx += 1) {
      const read = fs.readSync(fd, buf, 0, CHUNK_BYTES, offset);
      if (read <= 0) break;
      db.prepare('INSERT INTO blob_chunks (sha, idx, data) VALUES (?, ?, ?)')
        .run(sha, idx, buf.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha, size };
}

/** @param {any} db @param {string} sha @returns {Buffer|null} */
function getBuffer(db, sha) {
  const info = blobInfo(db, sha);
  if (!info) return null;
  if (!info.chunked) {
    const row = db.prepare('SELECT data FROM blobs WHERE sha = ?').get(sha);
    return row ? toBuffer(row.data) : null;
  }
  const rows = db.prepare('SELECT data FROM blob_chunks WHERE sha = ? ORDER BY idx').all(sha);
  return Buffer.concat(rows.map((r) => toBuffer(r.data)));
}

/**
 * Plage d'octets, bornes INCLUSIVES — même convention que l'en-tête HTTP Range servi par
 * core/media-server.js. Ne recolle que les tranches concernées.
 * @param {any} db @param {string} sha @param {number} start @param {number} end
 * @returns {Buffer|null}
 */
function readRange(db, sha, start, end) {
  const info = blobInfo(db, sha);
  if (!info) return null;
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(info.size - 1, Math.floor(end));
  if (to < from) return Buffer.alloc(0);
  if (!info.chunked) {
    const whole = getBuffer(db, sha);
    return whole ? whole.subarray(from, to + 1) : null;
  }

  const firstIdx = Math.floor(from / CHUNK_BYTES);
  const lastIdx = Math.floor(to / CHUNK_BYTES);
  const rows = db
    .prepare('SELECT idx, data FROM blob_chunks WHERE sha = ? AND idx BETWEEN ? AND ? ORDER BY idx')
    .all(sha, firstIdx, lastIdx);
  const out = Buffer.allocUnsafe(to - from + 1);
  let written = 0;
  for (const row of rows) {
    const chunkStart = Number(row.idx) * CHUNK_BYTES;
    const data = toBuffer(row.data);
    const sliceFrom = Math.max(0, from - chunkStart);
    const sliceTo = Math.min(data.length - 1, to - chunkStart);
    if (sliceTo < sliceFrom) continue;
    written += data.copy(out, written, sliceFrom, sliceTo + 1);
  }
  return out.subarray(0, written);
}

/**
 * Écrit un blob sur le disque, tranche par tranche (rien de gros en mémoire).
 * @param {any} db @param {string} sha @param {string} destPath @returns {boolean}
 */
function extractTo(db, sha, destPath) {
  const info = blobInfo(db, sha);
  if (!info) return false;
  fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
  if (!info.chunked) {
    const buf = getBuffer(db, sha);
    if (!buf) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  }
  const fd = fs.openSync(destPath, 'w');
  try {
    for (let idx = 0; ; idx += 1) {
      const row = db.prepare('SELECT data FROM blob_chunks WHERE sha = ? AND idx = ?').get(sha, idx);
      if (!row) break;
      const data = toBuffer(row.data);
      fs.writeSync(fd, data, 0, data.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** @param {any} db @param {string} sha */
function removeBlob(db, sha) {
  // blob_chunks part en cascade (cf. core/netsu/schema.js) tant que foreign_keys est actif.
  db.prepare('DELETE FROM blob_chunks WHERE sha = ?').run(sha);
  db.prepare('DELETE FROM blobs WHERE sha = ?').run(sha);
}

/**
 * Retire les octets que plus personne ne réclame et rend les pages libérées. Sans ce ménage, un
 * fichier ne fait que grossir : ouvrir un board reçu puis l'enregistrer recopie ses médias dans le
 * dossier compagnon, et les blobs d'origine resteraient là, invisibles et payés au poids.
 * @param {any} handle @param {Set<string>} keep empreintes encore référencées
 * @returns {{ removed: number, bytes: number }}
 */
function sweepBlobs(handle, keep) {
  const rows = handle.db.prepare('SELECT sha, size FROM blobs').all();
  const orphans = rows.filter((row) => !keep.has(String(row.sha)));
  if (!orphans.length) return { removed: 0, bytes: 0 };
  let bytes = 0;
  handle.write((db) => {
    for (const row of orphans) {
      removeBlob(db, String(row.sha));
      bytes += Number(row.size) || 0;
    }
  });
  handle.reclaim();
  return { removed: orphans.length, bytes };
}

// --- Variantes ASYNCHRONES ---------------------------------------------------------------------
// Le core est mono-thread : hacher puis recopier 4 Go en lecture synchrone, c'est geler l'app
// entière (aperçus, serveur de médias, autres modules) le temps du transfert. Les versions ci-
// dessous font les mêmes octets, mais rendent la main entre deux tranches. Les versions synchrones
// restent pour les appelants qui ne peuvent pas attendre (rebase du Carnet).

/** @param {string} filePath @returns {Promise<{ sha: string, size: number }>} */
async function hashFileAsync(filePath) {
  const stat = await fsp.stat(filePath);
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const file = await fsp.open(filePath, 'r');
  try {
    for (let offset = 0; offset < stat.size; ) {
      const { bytesRead } = await file.read(buf, 0, CHUNK_BYTES, offset);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  return { sha: hash.digest('hex'), size: stat.size };
}

/**
 * Range un fichier du disque sans bloquer le core. Une transaction PAR TRANCHE (via `write`, donc
 * sans révision) : le fichier reste cohérent à tout instant, et un échec en cours de route retire
 * le blob à moitié écrit plutôt que de le laisser passer pour valide.
 * @param {any} handle @param {string} filePath @param {string} [ext]
 * @returns {Promise<{ sha: string, size: number }>}
 */
async function putFileAsync(handle, filePath, ext) {
  const extension = String(ext || path.extname(filePath).slice(1) || 'bin').toLowerCase();
  const { sha, size } = await hashFileAsync(filePath);
  if (hasBlob(handle.db, sha)) return { sha, size };

  if (size <= CHUNK_BYTES) {
    const buf = await fsp.readFile(filePath);
    handle.write((db) => {
      db.prepare('INSERT INTO blobs (sha, ext, size, chunked, data) VALUES (?, ?, ?, 0, ?)')
        .run(sha, extension, size, buf);
    });
    return { sha, size };
  }

  handle.write((db) => {
    db.prepare('INSERT INTO blobs (sha, ext, size, chunked, data) VALUES (?, ?, ?, 1, NULL)')
      .run(sha, extension, size);
  });
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const file = await fsp.open(filePath, 'r');
  try {
    for (let offset = 0, idx = 0; offset < size; idx += 1) {
      const { bytesRead } = await file.read(buf, 0, CHUNK_BYTES, offset);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      handle.write((db) => {
        db.prepare('INSERT INTO blob_chunks (sha, idx, data) VALUES (?, ?, ?)').run(sha, idx, slice);
      });
      offset += bytesRead;
    }
  } catch (e) {
    try { handle.write((db) => removeBlob(db, sha)); } catch (_) { /* base déjà en vrac : rien à sauver */ }
    throw e;
  } finally {
    await file.close();
  }
  return { sha, size };
}

module.exports = {
  CHUNK_BYTES,
  sha256,
  putBuffer,
  putFile,
  putFileAsync,
  hashFile,
  hashFileAsync,
  getBuffer,
  readRange,
  extractTo,
  removeBlob,
  sweepBlobs,
  blobInfo,
  hasBlob,
};
