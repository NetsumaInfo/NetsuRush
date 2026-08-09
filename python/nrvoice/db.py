"""Cache SQLite du module voix : transcription + silences.

Même base que la détection de plans (~/.netsurush/netsurush.db) : on réutilise
detect.db_path() et detect.file_mtime() pour le contrôle de péremption (mtime > 1 s).
Clé = (chemin source, hash des paramètres, modèle) → un changement de modèle ou de
réglage (seuil VAD, langue ASR) ne réutilise jamais un cache d'un autre réglage.
"""
import hashlib
import json
import sqlite3
import time

from detect import db_path, file_mtime  # source unique du chemin de base + mtime


def params_hash(params):
    """Hash stable d'un dict de paramètres (clé de cache déterministe)."""
    blob = json.dumps(params or {}, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(blob.encode("utf-8")).hexdigest()


def _con():
    con = sqlite3.connect(db_path())
    con.execute(
        """CREATE TABLE IF NOT EXISTS transcript_cache_v1(
            file_path TEXT, mtime REAL, params_hash TEXT, model TEXT,
            result_json TEXT, created_at REAL,
            PRIMARY KEY(file_path, params_hash, model))"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS silence_cache_v1(
            file_path TEXT, mtime REAL, params_hash TEXT, model TEXT,
            result_json TEXT, created_at REAL,
            PRIMARY KEY(file_path, params_hash, model))"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS filler_cache_v1(
            file_path TEXT, mtime REAL, params_hash TEXT, model TEXT,
            result_json TEXT, created_at REAL,
            PRIMARY KEY(file_path, params_hash, model))"""
    )
    return con


def cache_get(table, path, phash, model):
    """Lit le cache (None si absent ou périmé). `table` = transcript|silence."""
    con = _con()
    row = con.execute(
        "SELECT mtime, result_json FROM %s_cache_v1 "
        "WHERE file_path=? AND params_hash=? AND model=? "
        "ORDER BY created_at DESC LIMIT 1" % table,
        (path, phash, model),
    ).fetchone()
    con.close()
    if not row:
        return None
    mtime, result_json = row
    if abs((mtime or 0) - file_mtime(path)) > 1.0:  # source modifiée → cache périmé
        return None
    try:
        return json.loads(result_json)
    except Exception:  # noqa: BLE001
        return None


def cache_store(table, path, phash, model, result):
    con = _con()
    con.execute(
        "INSERT OR REPLACE INTO %s_cache_v1 VALUES (?,?,?,?,?,?)" % table,
        (path, file_mtime(path), phash, model, json.dumps(result), time.time()),
    )
    con.commit()
    con.close()
