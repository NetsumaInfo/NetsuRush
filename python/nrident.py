#!/usr/bin/env python3
"""Content identity for media files: the same rush is the same rush, wherever it sits on disk.

Every expensive cache in `~/.netsurush/netsurush.db` is keyed by `file_path` (shot detection,
SigLIP embeddings, face embeddings, transcripts). That key is a STRING: copy a rush to another
drive, rename it, or simply let a copy bump its mtime, and hours of GPU work are silently thrown
away and recomputed. Nothing about the file changed — only the way we named it.

This module adds the missing layer: a cheap content signature, a table that remembers which paths
carry which signature, and a transfer step that hands an existing cache over to the new path.

  signature = sha256("nrident1|<size>|" + first 8 MiB + last 8 MiB)   (whole file if <= 16 MiB)

Deliberately STRICT: it identifies byte-identical files, not "visually the same shot". A remux
produces different bytes, hence a different signature, hence a fresh analysis — which is correct,
because a remux can change frame count and timing. Reading 16 MiB costs ~30 ms against minutes of
detection or indexing, and the `size` index means the hash is only computed when a same-sized file
is already known: browsing a folder of brand-new rushes hashes nothing at all.

`core/mediaIdent.js` is the Node twin of this file — SAME signature format, same table. Any change
to the framing or the truncation must land in both, or the two stop recognising each other.
"""
import hashlib
import os
import sqlite3
import time

# Head and tail slice. 8 MiB is far past any container header, so two files that agree on size,
# first 8 MiB and last 8 MiB are the same file in every practical sense.
CHUNK = 8 * 1024 * 1024

# Bounds for the discovery scan (a cache miss must never turn into a disk sweep).
MAX_STAT_CANDIDATES = 2000   # cached paths we are willing to stat()
MAX_HASH_CANDIDATES = 8      # of those, how many we are willing to hash

DDL = [
    "CREATE TABLE IF NOT EXISTS media_ident_v1("
    "file_path TEXT PRIMARY KEY, path_key TEXT, sig TEXT, size INTEGER, mtime REAL, seen_at REAL)",
    "CREATE INDEX IF NOT EXISTS media_ident_v1_sig ON media_ident_v1(sig)",
    "CREATE INDEX IF NOT EXISTS media_ident_v1_key ON media_ident_v1(path_key)",
    "CREATE INDEX IF NOT EXISTS media_ident_v1_size ON media_ident_v1(size)",
]


def path_key(p):
    """Comparison form of a path: absolute, forward slashes, case-folded on Windows.

    Resolve, drag-and-drop and the board hand us the same file with different casing and different
    separators; without this, `S:\\rush\\a.mp4` and `s:/rush/a.mp4` are two unrelated cache keys.
    Only ever used for MATCHING — the stored `file_path` stays verbatim, because it is what the UI
    displays and what ffmpeg opens.
    """
    q = os.path.abspath(str(p or "")).replace("\\", "/")
    return q.lower() if os.name == "nt" else q


def file_stat(p):
    """(size, mtime) or (0, 0.0) when the file is gone."""
    try:
        st = os.stat(p)
        return int(st.st_size), float(st.st_mtime)
    except OSError:
        return 0, 0.0


def signature(p):
    """(sig, size, mtime) for a file, or (None, 0, 0.0) if it cannot be read."""
    size, mtime = file_stat(p)
    if not size:
        return None, 0, 0.0
    h = hashlib.sha256()
    h.update(("nrident1|%d|" % size).encode("ascii"))
    try:
        with open(p, "rb", buffering=0) as f:
            if size <= 2 * CHUNK:  # small file: hash it whole, no blind middle
                while True:
                    block = f.read(1024 * 1024)
                    if not block:
                        break
                    h.update(block)
            else:
                h.update(f.read(CHUNK))
                f.seek(size - CHUNK)
                h.update(f.read(CHUNK))
    except OSError:
        return None, 0, 0.0
    return "s1:%d:%s" % (size, h.hexdigest()[:24]), size, mtime


def ensure(con):
    """Create the identity table. Never fatal: a failure here only costs the linking."""
    try:
        for sql in DDL:
            con.execute(sql)
        return True
    except sqlite3.Error:
        return False


def remember(con, path, sig=None, size=None, mtime=None):
    """Record what `path` currently holds. Returns the signature, or None.

    Called on every cache WRITE: this row is the witness that lets a later visit tell "the file was
    copied" (same signature, new mtime) from "the file was re-encoded" (new signature).
    """
    if sig is None:
        sig, size, mtime = signature(path)
    if not sig:
        return None
    if not ensure(con):
        return None
    try:
        con.execute(
            "INSERT OR REPLACE INTO media_ident_v1 (file_path, path_key, sig, size, mtime, seen_at) "
            "VALUES (?,?,?,?,?,?)",
            (path, path_key(path), sig, int(size or 0), float(mtime or 0.0), time.time()),
        )
        con.commit()
    except sqlite3.Error:
        return None
    return sig


def lookup(con, path):
    """Identity row known for this exact path, or None."""
    try:
        ensure(con)
        row = con.execute(
            "SELECT sig, size, mtime FROM media_ident_v1 WHERE file_path=?", (path,),
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    return {"sig": row[0], "size": int(row[1] or 0), "mtime": float(row[2] or 0.0)}


def same_bytes_as_cached(con, path, cached_mtime, tolerance=1.0):
    """True when the file changed mtime but NOT content since the cache was written.

    The classic false invalidation: a copy, a restore from backup or a sync tool rewrites the
    timestamp and every cache keyed on mtime is thrown away for bytes that never moved.
    """
    if cached_mtime is None:
        return False
    known = lookup(con, path)
    if not known or not known["sig"]:
        return False
    if abs(known["mtime"] - float(cached_mtime)) > tolerance:
        return False  # the witness describes another revision than the cached one
    size, _mtime = file_stat(path)
    if not size or size != known["size"]:
        return False  # size alone settles it, no need to hash
    sig, _size, mtime = signature(path)
    if not sig or sig != known["sig"]:
        return False
    remember(con, path, sig, size, mtime)  # witness now describes the current timestamp
    return True


def realign(con, path, tables, cached_mtime):
    """Cache written for THIS path, only the timestamp moved: bring the rows back into date.

    Returns True when the content was proven identical (and the rows realigned), False otherwise.
    """
    if not same_bytes_as_cached(con, path, cached_mtime):
        return False
    for table in tables:
        if "mtime" not in _columns(con, table):
            continue
        try:
            con.execute(
                "UPDATE %s SET mtime=? WHERE file_path=?" % table,
                (float(file_stat(path)[1]), path),
            )
        except sqlite3.Error:
            pass
    try:
        con.commit()
    except sqlite3.Error:
        pass
    return True


def _columns(con, table):
    try:
        return [r[1] for r in con.execute("PRAGMA table_info(%s)" % table)]
    except sqlite3.Error:
        return []


def note(con, path, size, mtime):
    """Record the CHEAP half of an identity (size only, no hash).

    Signatures are computed lazily, but a `stat()` is nearly free, so every path we look at is
    written down with its size. The next lookup then filters candidates in SQL instead of walking
    the disk again — the scan below is self-consuming and stops happening once the pre-existing
    cache has been surveyed.
    """
    if not ensure(con):
        return False
    try:
        con.execute(
            "INSERT OR IGNORE INTO media_ident_v1 (file_path, path_key, sig, size, mtime, seen_at) "
            "VALUES (?,?,NULL,?,?,?)",
            (path, path_key(path), int(size or 0), float(mtime or 0.0), time.time()),
        )
        con.commit()
        return True
    except sqlite3.Error:
        return False


def _unsurveyed_paths(con, tables, exclude, limit):
    """Cached paths this table has never heard of (built before it existed, or by another tool)."""
    seen, out = set(), []
    for table in tables:
        try:
            rows = con.execute(
                "SELECT DISTINCT c.file_path FROM %s c "
                "LEFT JOIN media_ident_v1 i ON i.file_path = c.file_path "
                "WHERE i.file_path IS NULL" % table,
            ).fetchall()
        except sqlite3.Error:
            continue
        for (p,) in rows:
            if not p or p in seen:
                continue
            seen.add(p)
            if p == exclude:
                continue
            out.append(p)
            if len(out) >= limit:
                return out
    return out


def twins(con, path, sig, size, tables=()):
    """Other paths that hold the same bytes, best candidates first.

    Cheapest source first: paths already recorded under this signature, then paths differing only
    by casing or separators, then paths of the same SIZE whose signature was never computed, and
    finally — only if all of those come up empty — a bounded survey of cached paths this table has
    never seen. Nothing is hashed until a same-sized file has been found.
    """
    ensure(con)
    key = path_key(path)
    # Deduplicated on the EXACT string, not on the key: a path that differs only by casing or
    # separators is precisely the twin we are after — the cache is filed under THAT spelling.
    out, seen = [], {str(path)}

    def push(p):
        if p in seen:
            return False
        seen.add(p)
        out.append(p)
        return True

    try:
        for (p,) in con.execute("SELECT file_path FROM media_ident_v1 WHERE sig=?", (sig,)):
            push(p)
        for (p,) in con.execute("SELECT file_path FROM media_ident_v1 WHERE path_key=?", (key,)):
            push(p)
    except sqlite3.Error:
        pass
    if out:
        return out

    def weigh(candidate, c_size, c_mtime):
        """Hash a same-sized candidate, record what we learn, keep it if it matches."""
        c_sig, _s, _m = signature(candidate)
        if not c_sig:
            return False
        remember(con, candidate, c_sig, c_size, c_mtime)
        return c_sig == sig and push(candidate)

    hashed = 0
    try:
        pending = con.execute(
            "SELECT file_path FROM media_ident_v1 WHERE size=? AND sig IS NULL LIMIT ?",
            (int(size), MAX_HASH_CANDIDATES),
        ).fetchall()
    except sqlite3.Error:
        pending = []
    for (candidate,) in pending:
        if candidate in seen:
            continue
        c_size, c_mtime = file_stat(candidate)
        if c_size != size:
            continue  # file gone (0) or resized since it was noted
        hashed += 1
        if weigh(candidate, c_size, c_mtime):
            return out
    if out or not tables:
        return out

    for candidate in _unsurveyed_paths(con, tables, str(path), MAX_STAT_CANDIDATES):
        c_size, c_mtime = file_stat(candidate)
        if not c_size:
            continue  # offline: nothing to stat, nothing to hash — its identity stays unknown
        note(con, candidate, c_size, c_mtime)
        if c_size != size or hashed >= MAX_HASH_CANDIDATES:
            continue
        hashed += 1
        if weigh(candidate, c_size, c_mtime):
            return out
    return out


def _transfer(con, table, src, dst, mtime, move):
    """Hand every row of `table` belonging to `src` over to `dst`. Returns the row count.

    `move` (the source path no longer exists — a rename or a relocation) UPDATEs in place: no
    duplicated embeddings on disk, and the rowids stay valid for the FAISS index. Otherwise both
    files are live and the rows are copied.
    """
    cols = _columns(con, table)
    if "file_path" not in cols:
        return 0
    has_mtime = "mtime" in cols
    try:
        # Nothing to hand over: leave the destination alone. Its rows may be a partial run, which is
        # still worth more than the empty set we would replace them with.
        if not con.execute("SELECT 1 FROM %s WHERE file_path=? LIMIT 1" % table, (src,)).fetchone():
            return 0
        con.execute("DELETE FROM %s WHERE file_path=?" % table, (dst,))
        if move:
            sets = "file_path=?" + (", mtime=?" if has_mtime else "")
            params = [dst] + ([float(mtime)] if has_mtime else []) + [src]
            cur = con.execute("UPDATE %s SET %s WHERE file_path=?" % (table, sets), params)
            return cur.rowcount or 0
        select, params = [], []
        for c in cols:
            if c == "file_path":
                select.append("?")
                params.append(dst)
            elif c == "mtime":
                select.append("?")
                params.append(float(mtime))
            else:
                select.append(c)
        cur = con.execute(
            "INSERT INTO %s (%s) SELECT %s FROM %s WHERE file_path=?"
            % (table, ",".join(cols), ",".join(select), table),
            params + [src],
        )
        return cur.rowcount or 0
    except sqlite3.Error:
        return 0


def rescue(con, path, tables):
    """Give `path` the cache of an identical file already known under another name.

    `tables` are the tables to hand over, in dependency order (data first, completion marker last —
    a marker without its rows would advertise work that is not there). Returns None when nothing
    matched, otherwise {"from": src, "moved": bool, "rows": n}.
    """
    tables = [t for t in tables if t]
    if not tables:
        return None
    sig, size, mtime = signature(path)
    if not sig:
        return None  # file unreadable: nothing to link, and nothing to break
    remember(con, path, sig, size, mtime)
    for src in twins(con, path, sig, size, tables):
        moved = not os.path.exists(src)
        rows = 0
        try:
            for table in tables:
                rows += _transfer(con, table, src, path, mtime, moved)
            if rows:
                con.commit()
            else:
                con.rollback()
        except sqlite3.Error:
            try:
                con.rollback()
            except sqlite3.Error:
                pass
            continue
        if rows:
            if moved:
                try:
                    con.execute("DELETE FROM media_ident_v1 WHERE file_path=?", (src,))
                    con.commit()
                except sqlite3.Error:
                    pass
            return {"from": src, "moved": moved, "rows": rows}
    return None
