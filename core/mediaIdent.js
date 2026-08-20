// @ts-check
// Node side of the media identity table — READ-ONLY twin of `python/nrident.py`.
//
// The caches that matter (shot cuts, embeddings, faces, transcripts) are keyed by `file_path`, so a
// rush copied to another drive or simply renamed looks brand new and costs its analysis again.
// Python owns that table: it writes the witnesses and performs the transfers. Node only needs to
// ANSWER FAST on the read path — "is this file the one that was already cut, under another name or
// another timestamp?" — without spawning python for a question SQLite can settle.
//
//   signature = sha256("nrident1|<size>|" + first 8 MiB + last 8 MiB)   (whole file if <= 16 MiB)
//
// That framing is a CONTRACT with python/nrident.py#signature: change it here and the two stop
// recognising the same file (both sides are pinned by a shared fixture in the tests).
//
// Nothing here writes: the identity table is refreshed by python on the next real detection or
// indexing pass. A miss only costs a hash, never correctness.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const CHUNK = 8 * 1024 * 1024;
const TWIN_LIMIT = 4; // candidates worth re-querying; a file has one or two copies, not twenty

/** Comparison form of a path: absolute, forward slashes, case-folded on Windows. */
function pathKey(p) {
  const q = path.resolve(String(p || '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? q.toLowerCase() : q;
}

/** @returns {{size:number, mtime:number}|null} */
function fileStat(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtime: st.mtimeMs / 1000 };
  } catch (_) { return null; }
}

/** Content signature of a file, or null when it cannot be read. */
function signature(filePath) {
  const st = fileStat(filePath);
  if (!st || !st.size) return null;
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(`nrident1|${st.size}|`, 'ascii'));
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    if (st.size <= 2 * CHUNK) { // small file: hashed whole, no blind middle
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let pos = 0;
      while (pos < st.size) {
        const read = fs.readSync(fd, buf, 0, buf.length, pos);
        if (read <= 0) break;
        h.update(buf.subarray(0, read));
        pos += read;
      }
    } else {
      const head = Buffer.allocUnsafe(CHUNK);
      h.update(head.subarray(0, fs.readSync(fd, head, 0, CHUNK, 0)));
      const tail = Buffer.allocUnsafe(CHUNK);
      h.update(tail.subarray(0, fs.readSync(fd, tail, 0, CHUNK, st.size - CHUNK)));
    }
  } catch (_) {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return { sig: `s1:${st.size}:${h.digest('hex').slice(0, 24)}`, size: st.size, mtime: st.mtime };
}

// Shared read-only handle on the cache database. Same path as python/detect.py#db_path — hard-coded
// there, so it does not follow the relocatable cache folder either.
/** @type {any} */
let handle = null;   // DatabaseSync | null (not opened yet) | false (unavailable)
function sharedDb() {
  if (handle === false) return null;
  if (handle) return handle;
  try {
    const p = path.join(os.homedir(), '.netsurush', 'netsurush.db');
    if (!fs.existsSync(p)) return null;  // nothing analysed yet: retry later, never create it here
    const { DatabaseSync } = require('node:sqlite');
    handle = new DatabaseSync(p, { readOnly: true });
    return handle;
  } catch (_) {
    handle = false;
    return null;
  }
}

// Statements are prepared PER CALL (never memoised): a kept StatementSync can be finalised by the
// GC → « statement has been finalized » on the next read (same trap as core/reference.js).
/** @param {any} db @param {string} sql @param {any[]} params */
function query(db, sql, params) {
  try { return /** @type {any[]} */ (db.prepare(sql).all(...params)); } catch (_) { return []; }
}

/** Identity row recorded by python for this exact path, or null. */
function identRow(db, filePath) {
  if (!db) return null;
  const rows = query(db, 'SELECT sig, size, mtime FROM media_ident_v1 WHERE file_path=?', [filePath]);
  return rows.length ? rows[0] : null;
}

/**
 * Paths that hold the same bytes as `filePath`, cheapest source first.
 *
 * The size index is what keeps this free: a rush nobody has ever analysed shares its size with
 * nothing, so the walk stops before hashing. Only a plausible twin is worth 16 MiB of reading.
 * @returns {string[]}
 */
function twinPaths(db, filePath) {
  if (!db) return [];
  const key = pathKey(filePath);
  const out = [];
  // Deduplicated on the EXACT string, not on the key: a path differing only by casing or separators
  // is precisely the twin we are after — the cache is filed under THAT spelling, so dropping it as
  // "the same path" would throw away the only way to reach those rows.
  const seen = new Set([String(filePath)]);
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const row of query(db, 'SELECT file_path FROM media_ident_v1 WHERE path_key=?', [key])) push(row.file_path);
  if (out.length) return out.slice(0, TWIN_LIMIT);
  const st = fileStat(filePath);
  if (!st || !st.size) return out;
  const sized = query(db, 'SELECT file_path, sig FROM media_ident_v1 WHERE size=? AND sig IS NOT NULL LIMIT ?',
    [st.size, TWIN_LIMIT * 4]);
  if (!sized.length) return out; // nothing of this size is known → no twin, and nothing hashed
  const mine = signature(filePath);
  if (!mine) return out;
  for (const row of sized) if (row.sig === mine.sig) push(row.file_path);
  return out.slice(0, TWIN_LIMIT);
}

/**
 * True when a cache written at `cachedMtime` still describes the current bytes of `filePath`.
 * Rescues the copy / restore / sync case, where only the timestamp moved.
 */
function sameBytesAsCached(db, filePath, cachedMtime, tolerance = 1.0) {
  if (!db || cachedMtime == null) return false;
  const known = identRow(db, filePath);
  if (!known || !known.sig) return false;
  if (Math.abs(Number(known.mtime) - Number(cachedMtime)) > tolerance) return false;
  const st = fileStat(filePath);
  if (!st || !st.size || st.size !== Number(known.size)) return false; // size alone settles it
  const mine = signature(filePath);
  return !!mine && mine.sig === known.sig;
}

/**
 * Signature recorded for a path, even one that is now OFFLINE — that is the whole point: the file
 * is gone, only the witness written when it was analysed can say what it held.
 * @returns {{sig:string, size:number}|null}
 */
function recordedIdent(filePath, db = sharedDb()) {
  const row = identRow(db, filePath);
  return row && row.sig ? { sig: String(row.sig), size: Number(row.size) || 0 } : null;
}

/**
 * A file that EXISTS on disk holding the same bytes as `filePath`, or null.
 *
 * Relocation without asking anything: the rush moved to another drive was analysed there too (or
 * simply seen), so the table already knows where the same bytes live now.
 */
function liveTwin(filePath, db = sharedDb()) {
  const known = recordedIdent(filePath, db);
  if (!known) return null;
  for (const row of query(db, 'SELECT file_path FROM media_ident_v1 WHERE sig=? LIMIT 32', [known.sig])) {
    const candidate = String(row.file_path || '');
    if (!candidate || candidate === filePath) continue;
    const st = fileStat(candidate);
    if (st && st.size === known.size) return candidate;
  }
  return null;
}

/**
 * First file of `candidates` whose content matches what `filePath` used to hold, or null.
 *
 * `candidates` are paths freshly scanned from a folder, so only same-sized ones are ever hashed —
 * a relink folder holding thousands of files costs a handful of reads, not a full sweep.
 */
function matchByContent(filePath, candidates, db = sharedDb(), cap = 8) {
  const known = recordedIdent(filePath, db);
  if (!known || !candidates || !candidates.length) return null;
  let hashed = 0;
  for (const candidate of candidates) {
    if (hashed >= cap) break;
    const st = fileStat(candidate);
    if (!st || st.size !== known.size) continue;
    hashed++;
    const sig = signature(candidate);
    if (sig && sig.sig === known.sig) return candidate;
  }
  return null;
}

module.exports = {
  pathKey, fileStat, signature, identRow, twinPaths, sameBytesAsCached,
  sharedDb, recordedIdent, liveTwin, matchByContent, CHUNK,
};
