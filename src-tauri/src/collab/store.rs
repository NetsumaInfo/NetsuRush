use rusqlite::{params, Connection, OptionalExtension as _, TransactionBehavior};
use std::path::Path;

use super::error::CollabError;

pub type RosterCache = Option<(Vec<u8>, Vec<u8>)>;

const STORE_SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableEnvelope {
    pub sequence: u64,
    pub header: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub signature: Vec<u8>,
    pub base_version: Vec<u8>,
}

pub struct ProjectStore {
    connection: Connection,
}

impl ProjectStore {
    pub fn open(path: &Path) -> Result<Self, CollabError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path).map_err(storage)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA synchronous=FULL;
                 PRAGMA busy_timeout=5000;",
            )
            .map_err(storage)?;
        migrate(&connection)?;
        Ok(Self { connection })
    }

    pub fn commit_local(
        &mut self,
        update: &[u8],
        envelope: &DurableEnvelope,
    ) -> Result<(), CollabError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let previous = read_u64_meta(&transaction, "local_sequence")?.unwrap_or(0);
        if envelope.sequence <= previous {
            return Err(CollabError::validation(
                "outbox sequence must increase monotonically",
            ));
        }
        transaction
            .execute(
                "INSERT INTO updates(origin, bytes) VALUES ('local', ?1)",
                params![update],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO outbox(
                    sequence, header, ciphertext, signature, base_version, published
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![
                    to_sql_u64(envelope.sequence)?,
                    &envelope.header,
                    &envelope.ciphertext,
                    &envelope.signature,
                    &envelope.base_version,
                ],
            )
            .map_err(storage)?;
        write_u64_meta(&transaction, "local_sequence", envelope.sequence)?;
        transaction.commit().map_err(storage)
    }

    pub fn next_sequence(&self) -> Result<u64, CollabError> {
        read_u64_meta(&self.connection, "local_sequence")?
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| CollabError::storage("outbox sequence exhausted"))
    }

    pub fn publication_base(&self) -> Result<Vec<u8>, CollabError> {
        read_blob_meta(&self.connection, "publication_base").map(|value| value.unwrap_or_default())
    }

    pub fn set_publication_base(&mut self, version: &[u8]) -> Result<(), CollabError> {
        write_blob_meta(&self.connection, "publication_base", version)
    }

    pub fn checkpoint_generation(&self) -> Result<u64, CollabError> {
        Ok(read_u64_meta(&self.connection, "checkpoint_generation")?.unwrap_or(0))
    }

    pub fn local_checkpoint(&self) -> Result<Option<Vec<u8>>, CollabError> {
        self.connection
            .query_row(
                "SELECT snapshot FROM checkpoint WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)
    }

    pub fn save_checkpoint(
        &mut self,
        generation: u64,
        version: &[u8],
        snapshot: &[u8],
    ) -> Result<(), CollabError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO checkpoint(singleton, generation, version_vector, snapshot)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(singleton) DO UPDATE SET
                   generation = excluded.generation,
                   version_vector = excluded.version_vector,
                   snapshot = excluded.snapshot",
                params![to_sql_u64(generation)?, version, snapshot],
            )
            .map_err(storage)?;
        write_u64_meta(&transaction, "checkpoint_generation", generation)?;
        transaction.commit().map_err(storage)
    }

    pub fn latest_pending(&self) -> Result<Option<DurableEnvelope>, CollabError> {
        self.connection
            .query_row(
                "SELECT sequence, header, ciphertext, signature, base_version
                 FROM outbox WHERE published = 0 ORDER BY sequence DESC LIMIT 1",
                [],
                |row| {
                    let sequence: i64 = row.get(0)?;
                    Ok(DurableEnvelope {
                        sequence: sequence as u64,
                        header: row.get(1)?,
                        ciphertext: row.get(2)?,
                        signature: row.get(3)?,
                        base_version: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(storage)
    }

    #[cfg(test)]
    pub fn pending_outbox(&self) -> Result<Vec<DurableEnvelope>, CollabError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT sequence, header, ciphertext, signature, base_version
                 FROM outbox WHERE published = 0 ORDER BY sequence",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([], |row| {
                let sequence: i64 = row.get(0)?;
                Ok(DurableEnvelope {
                    sequence: sequence as u64,
                    header: row.get(1)?,
                    ciphertext: row.get(2)?,
                    signature: row.get(3)?,
                    base_version: row.get(4)?,
                })
            })
            .map_err(storage)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage)
    }

    pub fn local_updates(&self) -> Result<Vec<Vec<u8>>, CollabError> {
        let mut statement = self
            .connection
            .prepare("SELECT bytes FROM updates WHERE origin = 'local' ORDER BY id")
            .map_err(storage)?;
        let rows = statement.query_map([], |row| row.get(0)).map_err(storage)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage)
    }

    #[cfg(test)]
    pub fn mark_published(&mut self, sequence: u64) -> Result<(), CollabError> {
        let changed = self
            .connection
            .execute(
                "UPDATE outbox SET published = 1 WHERE sequence = ?1",
                params![to_sql_u64(sequence)?],
            )
            .map_err(storage)?;
        if changed != 1 {
            return Err(CollabError::validation("unknown outbox sequence"));
        }
        Ok(())
    }

    pub fn confirm_through(
        &mut self,
        sequence: u64,
        publication_base: &[u8],
    ) -> Result<(), CollabError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let changed = transaction
            .execute(
                "UPDATE outbox SET published = 1 WHERE published = 0 AND sequence <= ?1",
                params![to_sql_u64(sequence)?],
            )
            .map_err(storage)?;
        if changed == 0 {
            return Err(CollabError::validation("unknown pending outbox sequence"));
        }
        write_blob_meta(&transaction, "publication_base", publication_base)?;
        transaction
            .execute("DELETE FROM outbox WHERE published = 1", [])
            .map_err(storage)?;
        transaction.commit().map_err(storage)
    }

    pub fn cache_roster(&mut self, body: &[u8], signature: &[u8]) -> Result<(), CollabError> {
        self.connection
            .execute(
                "INSERT INTO roster_cache(singleton, fetched_at, body, mac)
                 VALUES (1, unixepoch(), ?1, ?2)
                 ON CONFLICT(singleton) DO UPDATE SET
                   fetched_at = excluded.fetched_at, body = excluded.body, mac = excluded.mac",
                params![body, signature],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn roster_cache(&self) -> Result<RosterCache, CollabError> {
        self.connection
            .query_row(
                "SELECT body, mac FROM roster_cache WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)
    }
}

fn migrate(connection: &Connection) -> Result<(), CollabError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS meta(
                key TEXT PRIMARY KEY NOT NULL,
                value BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS checkpoint(
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                generation INTEGER NOT NULL,
                version_vector BLOB NOT NULL,
                snapshot BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS updates(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                origin TEXT NOT NULL CHECK(origin IN ('local', 'remote')),
                bytes BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS outbox(
                sequence INTEGER PRIMARY KEY NOT NULL,
                header BLOB NOT NULL,
                ciphertext BLOB NOT NULL,
                signature BLOB NOT NULL,
                base_version BLOB NOT NULL,
                published INTEGER NOT NULL CHECK(published IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS remote_heads(
                device_id TEXT PRIMARY KEY NOT NULL,
                sequence INTEGER NOT NULL,
                envelope BLOB NOT NULL,
                absorbed INTEGER NOT NULL CHECK(absorbed IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS key_epochs(
                epoch INTEGER PRIMARY KEY NOT NULL,
                protected_key BLOB NOT NULL,
                current INTEGER NOT NULL CHECK(current IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS roster_cache(
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                fetched_at INTEGER NOT NULL,
                body BLOB NOT NULL,
                mac BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS blobs(
                hash TEXT PRIMARY KEY NOT NULL,
                size INTEGER NOT NULL,
                mime TEXT NOT NULL,
                pins INTEGER NOT NULL,
                grace_since INTEGER
             );
             CREATE TABLE IF NOT EXISTS transfers(
                hash TEXT PRIMARY KEY NOT NULL,
                size INTEGER NOT NULL,
                chunk_size INTEGER NOT NULL,
                received BLOB NOT NULL,
                temp_token TEXT NOT NULL,
                updated_at INTEGER NOT NULL
             );",
        )
        .map_err(storage)?;

    let existing = read_u64_meta(connection, "schema_version")?;
    match existing {
        None => write_u64_meta(connection, "schema_version", STORE_SCHEMA_VERSION as u64),
        Some(version) if version == STORE_SCHEMA_VERSION as u64 => Ok(()),
        Some(version) => Err(CollabError::storage(format!(
            "unsupported collaboration store version {version}"
        ))),
    }
}

fn read_u64_meta(connection: &Connection, key: &str) -> Result<Option<u64>, CollabError> {
    let value = connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(storage)?;
    value
        .map(|bytes| {
            let fixed: [u8; 8] = bytes
                .try_into()
                .map_err(|_| CollabError::storage("invalid numeric metadata"))?;
            Ok(u64::from_le_bytes(fixed))
        })
        .transpose()
}

fn write_u64_meta(connection: &Connection, key: &str, value: u64) -> Result<(), CollabError> {
    connection
        .execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_le_bytes().as_slice()],
        )
        .map_err(storage)?;
    Ok(())
}

fn read_blob_meta(connection: &Connection, key: &str) -> Result<Option<Vec<u8>>, CollabError> {
    connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)
}

fn write_blob_meta(connection: &Connection, key: &str, value: &[u8]) -> Result<(), CollabError> {
    connection
        .execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(storage)?;
    Ok(())
}

fn to_sql_u64(value: u64) -> Result<i64, CollabError> {
    i64::try_from(value).map_err(|_| CollabError::validation("sequence exceeds SQLite range"))
}

fn storage(error: rusqlite::Error) -> CollabError {
    CollabError::storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{DurableEnvelope, ProjectStore};
    use crate::collab::ids::OpaqueToken;

    fn database_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "netsurush-collab-{}.sqlite3",
            OpaqueToken::generate().expect("temporary token").as_str()
        ))
    }

    fn envelope(sequence: u64, ciphertext: &[u8]) -> DurableEnvelope {
        DurableEnvelope {
            sequence,
            header: br#"{"version":1}"#.to_vec(),
            ciphertext: ciphertext.to_vec(),
            signature: vec![3_u8; 64],
            base_version: vec![4_u8; 8],
        }
    }

    #[test]
    fn local_commit_persists_update_sequence_and_exact_envelope_atomically() {
        let path = database_path();
        let mut store = ProjectStore::open(&path).expect("open store");
        store
            .commit_local(b"loro-update", &envelope(7, b"ciphertext"))
            .expect("commit");
        drop(store);

        let store = ProjectStore::open(&path).expect("reopen store");
        let pending = store.pending_outbox().expect("pending outbox");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].sequence, 7);
        assert_eq!(pending[0].ciphertext, b"ciphertext");
        assert_eq!(
            store.local_updates().expect("local updates"),
            vec![b"loro-update".to_vec()]
        );

        drop(store);
        std::fs::remove_file(path).expect("remove database");
    }

    #[test]
    fn unpublished_envelopes_are_never_trimmed_by_queue_length() {
        let path = database_path();
        let mut store = ProjectStore::open(&path).expect("open store");
        for sequence in 1..=12 {
            store
                .commit_local(&[sequence as u8], &envelope(sequence, &[sequence as u8]))
                .expect("commit");
        }
        assert_eq!(store.pending_outbox().expect("pending").len(), 12);

        drop(store);
        std::fs::remove_file(path).expect("remove database");
    }

    #[test]
    fn publication_confirmation_removes_only_the_confirmed_pending_entry() {
        let path = database_path();
        let mut store = ProjectStore::open(&path).expect("open store");
        store
            .commit_local(b"one", &envelope(1, b"one"))
            .expect("first commit");
        store
            .commit_local(b"two", &envelope(2, b"two"))
            .expect("second commit");

        store.mark_published(1).expect("confirm first");
        let pending = store.pending_outbox().expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].sequence, 2);
        assert!(store.mark_published(99).is_err());

        drop(store);
        std::fs::remove_file(path).expect("remove database");
    }
}
