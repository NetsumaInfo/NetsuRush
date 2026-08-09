"""Schéma SQLite : embeddings de plans (frame_embeddings_v1), marqueurs de complétion
d'indexation (index_runs_v1), embeddings de visages (face_embeddings_v2) et bibliothèque de
personnages nommés (characters_v1 + character_samples_v1 + labels face_labels_v1). La base est
la source de vérité ; les index RAM (store.py) sont des accélérateurs reconstructibles."""
import sqlite3
import sys
import time

from detect import db_path

from .config import LEGACY_MODEL_TAGS, MODEL_TAG


def db_emb():
    con = sqlite3.connect(db_path(), timeout=30.0)
    # Concurrence : plusieurs daemons d'indexation (plans + visages, mode parallèle) écrivent la MÊME
    # base. WAL = lecteurs et 1 écrivain simultanés (au lieu du verrou exclusif par défaut) ; busy_timeout
    # = un écrivain ATTEND le verrou (jusqu'à 30 s) au lieu d'échouer « database is locked ».
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=30000")
        con.execute("PRAGMA synchronous=NORMAL")   # WAL : durable au checkpoint, bien plus rapide en écriture
    except Exception:  # noqa: BLE001
        pass
    con.execute(
        """CREATE TABLE IF NOT EXISTS frame_embeddings_v1(
            file_path TEXT, mtime REAL, model TEXT, scene_index INTEGER,
            start_frame INTEGER, end_frame INTEGER, mid_frame INTEGER,
            start_sec REAL, end_sec REAL, fps REAL, src_frames INTEGER,
            embedding BLOB, dim INTEGER, created_at REAL, thumb BLOB,
            PRIMARY KEY(file_path, model, scene_index))"""
    )
    # migration : ajoute thumb si table créée avant (vignette JPEG stockée à l'indexation).
    cols = [r[1] for r in con.execute("PRAGMA table_info(frame_embeddings_v1)")]
    if "thumb" not in cols:
        con.execute("ALTER TABLE frame_embeddings_v1 ADD COLUMN thumb BLOB")
    # Marqueur de complétion : écrit UNIQUEMENT quand un clip est traité jusqu'au bout. Permet de
    # distinguer "entièrement indexé" d'un clip interrompu (app fermée en plein traitement) dont
    # les embeddings partiels existent mais qui ne doit PAS être considéré comme fait.
    con.execute(
        """CREATE TABLE IF NOT EXISTS index_runs_v1(
            file_path TEXT, model TEXT, mtime REAL, total INTEGER, indexed INTEGER,
            created_at REAL, sampling TEXT, PRIMARY KEY(file_path, model))"""
    )
    # migration : `sampling` distingue les clips indexés en adaptatif (3 frames) des anciens
    # 1-frame ("legacy") → le picker propose un ré-index pour la précision.
    rcols = [r[1] for r in con.execute("PRAGMA table_info(index_runs_v1)")]
    if "sampling" not in rcols:
        con.execute("ALTER TABLE index_runs_v1 ADD COLUMN sampling TEXT")
    # Recherche par visage : 1 ligne par visage détecté dans un plan. `domain` (anime/real)
    # + `engine` (tag du modèle d'identité) — les espaces d'embedding ne se mélangent pas
    # (CCIP 768-d brut / SFace 128-d L2). L'ancienne face_embeddings_v1 (SigLIP) est ignorée.
    con.execute(
        """CREATE TABLE IF NOT EXISTS face_embeddings_v2(
            file_path TEXT, mtime REAL, domain TEXT, engine TEXT,
            scene_index INTEGER, face_index INTEGER,
            start_frame INTEGER, end_frame INTEGER, mid_frame INTEGER,
            start_sec REAL, end_sec REAL, fps REAL, src_frames INTEGER,
            bbox TEXT, embedding BLOB, dim INTEGER, created_at REAL, thumb BLOB,
            PRIMARY KEY(file_path, domain, engine, scene_index, face_index))"""
    )
    # Marqueur de complétion visage lié à la configuration de découpe. Sans cette clé, changer
    # OmniShotCut/AutoShot ou leurs réglages pouvait réutiliser des visages alignés sur d’anciens plans.
    con.execute(
        """CREATE TABLE IF NOT EXISTS face_index_runs_v1(
            file_path TEXT, engine_key TEXT, mtime REAL, cut_key TEXT,
            faces INTEGER, created_at REAL, PRIMARY KEY(file_path, engine_key))"""
    )
    # Bibliothèque de personnages nommés : mémorise un visage → nom + métadonnées. La recherche
    # future reconnaît et propose le nom, et permet de filtrer « tous les plans de X » (via labels).
    con.execute(
        """CREATE TABLE IF NOT EXISTS characters_v1(
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, notes TEXT, tags TEXT,
            color TEXT, avatar BLOB, created_at REAL, updated_at REAL)"""
    )
    # Échantillons de visage d'un personnage (embeddings + vignette). Plusieurs par (perso, domaine)
    # → requête multi-réf plus robuste. Copie l'embedding (survit à la ré-indexation / suppression fichier).
    con.execute(
        """CREATE TABLE IF NOT EXISTS character_samples_v1(
            id INTEGER PRIMARY KEY AUTOINCREMENT, char_id INTEGER, domain TEXT, engine TEXT,
            embedding BLOB, dim INTEGER, thumb BLOB, created_at REAL,
            file_path TEXT, scene_index INTEGER, face_index INTEGER)"""
    )
    # migration : provenance (file_path/scene_index/face_index) des échantillons pris dans l'index —
    # affiche le plan d'origine et permet de re-cropper la vignette. NULL = réf image externe.
    scols = [r[1] for r in con.execute("PRAGMA table_info(character_samples_v1)")]
    for col, typ in (("file_path", "TEXT"), ("scene_index", "INTEGER"), ("face_index", "INTEGER")):
        if col not in scols:
            con.execute("ALTER TABLE character_samples_v1 ADD COLUMN %s %s" % (col, typ))
    # Auto-étiquetage : associe un visage indexé (face_embeddings_v2) à un personnage. Table SÉPARÉE
    # recalculable (ne touche pas les embeddings) → filtre instantané « tous les plans de X ».
    # `domain` dans la PK : face_index redémarre à 0 PAR domaine dans face_embeddings_v2 (un plan
    # peut avoir visage animé 0 ET visage réel 0 → sans domaine, un label écraserait l'autre).
    con.execute(
        """CREATE TABLE IF NOT EXISTS face_labels_v1(
            file_path TEXT, scene_index INTEGER, face_index INTEGER, domain TEXT,
            char_id INTEGER, score REAL,
            PRIMARY KEY(file_path, scene_index, face_index, domain))"""
    )
    # migration : table créée avant l'ajout de `domain` → on la recrée (recalculable, zéro perte).
    lcols = [r[1] for r in con.execute("PRAGMA table_info(face_labels_v1)")]
    if "domain" not in lcols:
        con.execute("DROP TABLE face_labels_v1")
        con.execute(
            """CREATE TABLE face_labels_v1(
                file_path TEXT, scene_index INTEGER, face_index INTEGER, domain TEXT,
                char_id INTEGER, score REAL,
                PRIMARY KEY(file_path, scene_index, face_index, domain))"""
        )
    migrate_legacy_model_tags(con)
    return con


def migrate_legacy_model_tags(con):
    """Récupère l'index écrit sous un ancien tag de modèle (cf. LEGACY_MODEL_TAGS) en le renommant
    vers le tag courant : les poids sont les mêmes, l'espace vectoriel aussi, il n'y a rien à
    ré-indexer. Sans ça, la bascule vers le gestionnaire de modèles rendait invisible TOUT l'index
    déjà construit — les rushs indexés ressortaient « jamais indexés ».

    Passe UNE fois par tag (marqueur) : la table des embeddings n'a pas d'index sur `model`, la
    rescanner à chaque ouverture de base coûterait cher. Un plan déjà ré-indexé sous le tag courant
    gagne (OR IGNORE) ; sa version legacy reste en place, inerte, plus jamais lue."""
    legacy = LEGACY_MODEL_TAGS.get(MODEL_TAG) or ()
    if not legacy:
        return 0
    con.execute("CREATE TABLE IF NOT EXISTS index_migrations_v1(name TEXT PRIMARY KEY, created_at REAL)")
    marker = "model_tag:%s" % MODEL_TAG
    if con.execute("SELECT 1 FROM index_migrations_v1 WHERE name=?", (marker,)).fetchone():
        return 0
    ph = ",".join("?" * len(legacy))
    moved = 0
    for table in ("frame_embeddings_v1", "index_runs_v1"):
        cur = con.execute("UPDATE OR IGNORE %s SET model=? WHERE model IN (%s)" % (table, ph),
                          (MODEL_TAG, *legacy))
        moved += cur.rowcount or 0
    con.execute("INSERT OR REPLACE INTO index_migrations_v1 VALUES (?,?)", (marker, time.time()))
    con.commit()
    if moved:
        sys.stderr.write("index repris sous le tag %s: %d ligne(s)\n" % (MODEL_TAG, moved))
        sys.stderr.flush()
    return moved


def usable_embeddings(rows, blob_index):
    """Lignes dont l'embedding a la longueur MAJORITAIRE du lot. Les autres sont des reliquats
    d'une indexation tuée en pleine écriture, et il suffit d'une pour que np.stack refuse le lot
    entier (« all input arrays must have the same shape »). Les écarter garde la requête exacte sur
    ce qui est lisible, sans faire dépendre chaque recherche d'un balayage de toute la table — la
    base, elle, est nettoyée au démarrage du processus (cf. purge_malformed_embeddings)."""
    sizes = {}
    for row in rows:
        blob = row[blob_index]
        sizes[len(blob) if blob else 0] = sizes.get(len(blob) if blob else 0, 0) + 1
    if len(sizes) <= 1:
        return rows
    keep = max(sizes, key=sizes.get)
    return [row for row in rows if row[blob_index] and len(row[blob_index]) == keep]


_PURGED = False   # le balayage d'auto-guérison a déjà eu lieu dans CE processus


def purge_malformed_embeddings(con):
    """Auto-guérison : supprime les embeddings corrompus (dim aberrante vs la dim MAJORITAIRE du
    modèle, ou blob tronqué ≠ dim×4 octets) — une indexation interrompue peut écrire des lignes
    poubelle. Les plans purgés redeviennent « à indexer » (aucun marqueur index_runs_v1 n'est posé
    sur un run incomplet). Renvoie le nb de lignes supprimées.

    UNE passe par processus. Le balayage parcourt toute la table (aucun index ne couvre
    `model`/`dim`) : MESURÉ 0,29 s à chaud et 3,4 s à froid sur une base de 336 Mo, et il était
    payé par CHAQUE recherche. Seul un processus tué en pleine écriture laisse ces lignes derrière
    lui — donc au démarrage, jamais entre deux requêtes ; `usable_embeddings` couvre le cas rare où
    un autre processus en sème pendant la session."""
    global _PURGED
    if _PURGED:
        return 0
    _PURGED = True
    dominant = {}
    for model, dim, _cnt in con.execute(
        "SELECT model, dim, COUNT(*) AS c FROM frame_embeddings_v1 GROUP BY model, dim ORDER BY c DESC"
    ).fetchall():
        dominant.setdefault(model, dim)
    removed = 0
    for model, dim in dominant.items():
        cur = con.execute(
            "DELETE FROM frame_embeddings_v1 WHERE model=? AND (dim<>? OR LENGTH(embedding)<>4*?)",
            (model, int(dim), int(dim)),
        )
        removed += cur.rowcount
    if removed:
        con.commit()
        import sys
        sys.stderr.write("purge embeddings corrompus: %d ligne(s)\n" % removed)
        sys.stderr.flush()
    return removed
