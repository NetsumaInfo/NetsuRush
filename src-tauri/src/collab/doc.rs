//! The collaborative document (`docs/collab.md` §3).
//!
//! One authoritative Loro document per project, owned here. Renderers receive total projections and
//! never write into containers: they send typed operations, Rust validates and applies them.
//!
//! Why not a generic `set(path)` API: it would let a buggy — or compromised — renderer build states
//! a surface cannot represent, and it would step straight past the atomicity rules below.
//!
//! Root containers this build does not know (for instance those written by the retired reference
//! board) are left untouched and never projected.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use loro::{ExportMode, LoroDoc, LoroMap, LoroValue, VersionVector};
use serde::de::DeserializeOwned;
use serde::Serialize;

#[path = "surface_doc.rs"]
mod surface;

use super::identity;
use super::ids::ProjectId;
pub use super::ops::CollabOp as Op;
use super::ops::{CollabOp, OperationBatch, OP_PROTOCOL_VERSION};

/// Layout of the document itself. A build that does not understand it opens the project read-only
/// rather than rewriting it into something the writer cannot read back.
const DOC_SCHEMA_VERSION: i64 = 1;
const ROOT_META: &str = "meta";

const KEY_SCHEMA: &str = "schemaVersion";
const KEY_DELETED: &str = "deleted";

#[derive(Debug)]
pub enum DocError {
    Io(String),
    Loro(String),
    /// The document was written by a newer build. Opened read-only, never rewritten.
    Schema(i64),
    /// The renderer speaks another operation protocol.
    Protocol(u32),
    /// The operation cannot apply to this document: unknown entry, tombstoned entry, bad payload.
    Rejected(String),
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(what) => write!(f, "collaborative document: {what}"),
            Self::Loro(what) => write!(f, "collaborative document: {what}"),
            Self::Schema(found) => write!(
                f,
                "this project was written by a newer build (document format {found}, this build reads {DOC_SCHEMA_VERSION})"
            ),
            Self::Protocol(found) => write!(
                f,
                "operation protocol {found} is not the one this build speaks ({OP_PROTOCOL_VERSION})"
            ),
            Self::Rejected(what) => write!(f, "operation refused: {what}"),
        }
    }
}

impl From<loro::LoroError> for DocError {
    fn from(err: loro::LoroError) -> Self {
        Self::Loro(err.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authored_revision: Option<u64>,
    pub revision: u64,
    pub applied: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProjection {
    pub entries: Vec<surface::SurfaceEntryProjection>,
    pub revision: u64,
    /// Content hashes whose bytes are already in the local blob store. The document layer cannot
    /// know this — the service fills it before the projection crosses to the renderer, which uses
    /// it to paint a placeholder instead of pointing an `<img>`/`<video>` at a blob that would 404.
    pub local_hashes: Vec<String>,
}

/// The on-disk `.loro` snapshot is a warm-start cache, not the durability layer: every accepted
/// edit is already committed to the project's SQLite store before `commit_update` runs, and opening
/// a project replays that store on top of whatever snapshot exists. Rewriting the full snapshot on
/// every 150 ms batch therefore buys nothing — it is throttled to this interval and flushed on
/// close (and after the open-time replay).
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(2);

struct Project {
    doc: LoroDoc,
    /// Validation replica. A batch is applied here first, so an invalid operation rolls the whole
    /// batch back without ever touching `doc` — and without exporting/importing a full snapshot on
    /// every batch, which is what the previous per-batch shadow rebuild cost. Kept converged with
    /// `doc` by importing the same updates; rebuilt from a snapshot only when a partial batch
    /// poisoned it (rare: an invalid batch).
    shadow: LoroDoc,
    undo: loro::UndoManager,
    revisions: std::collections::BTreeMap<u64, loro::Frontiers>,
    prepared_author: Option<loro::Frontiers>,
    revision: u64,
    path: PathBuf,
    /// Snapshot write pending: the in-memory document is ahead of the `.loro` file.
    dirty: bool,
    last_save: Instant,
    /// A newer schema is readable but frozen: writing would produce a document its own author
    /// could no longer open.
    read_only: bool,
}

static PROJECTS: Mutex<Option<HashMap<String, Project>>> = Mutex::new(None);
/// A loaded document is not necessarily UI-authorized: an already-started network task may finish
/// after the final lease closes and load durable state again.
static LEASED_PROJECTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn projects_dir() -> PathBuf {
    super::identity::collab_dir().join("projects")
}

fn project_path(project_id: &str) -> Result<PathBuf, DocError> {
    let project_id =
        ProjectId::parse(project_id).map_err(|error| DocError::Rejected(error.to_string()))?;
    Ok(projects_dir().join(format!("{}.loro", project_id.storage_key())))
}

/// Peer id derived from the device identity, so every operation is attributable to this machine and
/// stays attributable across restarts. A random peer id per session would fragment the history.
fn peer_id() -> u64 {
    match identity::get_or_init() {
        Ok(identity) => {
            let seed = identity.public().device_id.as_bytes();
            let mut bytes = [0u8; 8];
            for (slot, byte) in bytes.iter_mut().zip(seed.iter()) {
                *slot = *byte;
            }
            u64::from_le_bytes(bytes)
        }
        Err(_) => 1,
    }
}

fn with_project<T>(
    project_id: &str,
    write: bool,
    body: impl FnOnce(&mut Project) -> Result<T, DocError>,
) -> Result<T, DocError> {
    let mut guard = PROJECTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(project_id) {
        map.insert(project_id.to_string(), open(project_id)?);
    }
    let project = map.get_mut(project_id).expect("just inserted");
    if write && project.read_only {
        return Err(DocError::Schema(read_schema(&project.doc)));
    }
    body(project)
}

fn read_schema(doc: &LoroDoc) -> i64 {
    match doc
        .get_map(ROOT_META)
        .get(KEY_SCHEMA)
        .and_then(|v| v.into_value().ok())
    {
        Some(LoroValue::I64(found)) => found,
        _ => DOC_SCHEMA_VERSION,
    }
}

/// Loads a project from disk, or creates it. A snapshot that fails to import is an error, never a
/// fresh empty document: silently starting over would erase work that is still on this disk.
fn open(project_id: &str) -> Result<Project, DocError> {
    let path = project_path(project_id)?;
    let doc = LoroDoc::new();
    doc.set_peer_id(peer_id())?;
    let mut read_only = false;

    match fs::read(&path) {
        Ok(bytes) => {
            doc.import(&bytes)?;
            let found = read_schema(&doc);
            if found > DOC_SCHEMA_VERSION {
                read_only = true;
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            doc.get_map(ROOT_META)
                .insert(KEY_SCHEMA, DOC_SCHEMA_VERSION)?;
            doc.commit();
        }
        Err(err) => return Err(DocError::Io(err.to_string())),
    }

    let undo = loro::UndoManager::new(&doc);
    let shadow = fork_of(&doc)?;
    Ok(Project {
        doc,
        shadow,
        undo,
        revision: 0,
        revisions: std::collections::BTreeMap::new(),
        prepared_author: None,
        path,
        dirty: false,
        last_save: Instant::now(),
        read_only,
    })
}

/// A second in-memory replica of `doc`, with the same peer id so operations born on it remain
/// attributable to this device once imported back.
fn fork_of(doc: &LoroDoc) -> Result<LoroDoc, DocError> {
    let snapshot = doc
        .export(ExportMode::Snapshot)
        .map_err(|err| DocError::Loro(err.to_string()))?;
    let fork = LoroDoc::new();
    fork.import(&snapshot)?;
    fork.set_peer_id(doc.peer_id())?;
    Ok(fork)
}

/// Brings the shadow up to date with `doc` by importing only what it misses. If the shadow is
/// AHEAD of `doc` — a prepared batch was never committed because a later step failed — it holds
/// operations the product decided to reject, so it is rebuilt instead of reconciled.
fn sync_shadow(project: &mut Project) -> Result<(), DocError> {
    let delta = project
        .doc
        .export(ExportMode::updates(&project.shadow.oplog_vv()))
        .map_err(|err| DocError::Loro(err.to_string()))?;
    project.shadow.import(&delta)?;
    if project.shadow.oplog_vv() != project.doc.oplog_vv() {
        project.shadow = fork_of(&project.doc)?;
    }
    Ok(())
}

/// Atomic replace: a crash mid-write leaves the previous snapshot intact rather than a truncated
/// file that would fail to import on the next start.
fn write_snapshot(project: &mut Project) -> Result<(), DocError> {
    let bytes = project
        .doc
        .export(ExportMode::Snapshot)
        .map_err(|err| DocError::Loro(err.to_string()))?;
    super::ids::atomic_write(&project.path, &bytes).map_err(|err| DocError::Io(err.to_string()))?;
    project.dirty = false;
    project.last_save = Instant::now();
    Ok(())
}

/// See `SNAPSHOT_INTERVAL`: the SQLite store already holds the durable copy, so the snapshot cache
/// is rewritten at most every interval instead of on every commit.
fn save(project: &mut Project) -> Result<(), DocError> {
    if project.last_save.elapsed() >= SNAPSHOT_INTERVAL {
        return write_snapshot(project);
    }
    project.dirty = true;
    Ok(())
}

/// Writes the pending snapshot, if any. Called after the open-time store replay and before a
/// project leaves memory, so a quiet project does not keep a stale cache forever.
pub fn flush(project_id: &str) -> Result<(), DocError> {
    with_project(project_id, false, |project| {
        if project.dirty {
            write_snapshot(project)?;
        }
        Ok(())
    })
}

/// Deleting never removes an entry: it raises this flag. Restoring an entry with its original id
/// (what an undo asks for) revives a tombstone rather than colliding with a live entry.
fn is_tombstoned(entry: &LoroMap) -> bool {
    matches!(
        entry.get(KEY_DELETED).and_then(|value| value.into_value().ok()),
        Some(LoroValue::Bool(true))
    )
}

fn json<T: Serialize>(value: &T) -> Result<String, DocError> {
    serde_json::to_string(value).map_err(|error| DocError::Rejected(error.to_string()))
}

fn atomic<T: DeserializeOwned>(map: &LoroMap, key: &str) -> Result<Option<T>, DocError> {
    let Some(LoroValue::String(raw)) = map.get(key).and_then(|value| value.into_value().ok())
    else {
        return Ok(None);
    };
    serde_json::from_str::<Option<T>>(raw.as_str())
        .map_err(|error| DocError::Loro(format!("invalid {key} group: {error}")))
}

fn project_projection_from_doc(
    doc: &LoroDoc,
    revision: u64,
) -> Result<ProjectProjection, DocError> {
    Ok(ProjectProjection {
        entries: surface::projection(doc)?,
        revision,
        local_hashes: Vec::new(),
    })
}

fn apply_one(doc: &LoroDoc, op: &CollabOp) -> Result<(), DocError> {
    surface::apply(doc, op)
}

#[cfg(test)]
fn apply_batch_to_doc(doc: &LoroDoc, ops: &[Op]) -> Result<Vec<u8>, DocError> {
    OperationBatch::v1(ops.to_vec())
        .validate()
        .map_err(|error| DocError::Rejected(error.to_string()))?;
    let before = doc.oplog_vv();
    let snapshot = doc
        .export(ExportMode::Snapshot)
        .map_err(|error| DocError::Loro(error.to_string()))?;
    let candidate = LoroDoc::new();
    candidate.import(&snapshot)?;
    candidate.set_peer_id(doc.peer_id())?;
    for operation in ops {
        apply_one(&candidate, operation)?;
    }
    candidate.commit();
    let update = candidate
        .export(ExportMode::updates(&before))
        .map_err(|error| DocError::Loro(error.to_string()))?;
    doc.import(&update)?;
    Ok(update)
}

/// Builds and validates a batch against the persistent shadow replica without changing the live
/// document, and returns `(update, head_delta)`:
///
/// - `update`: exactly the batch's operations, exported from the live document's version — what
///   `commit_update` will import;
/// - `head_delta`: everything past `base_version` once the batch is applied — the payload the
///   sealed outbox envelope carries.
///
/// The service persists both in one SQLite transaction before calling `commit_update`, so a crash
/// cannot leave visible work without a recoverable head. The shadow keeps the cost O(batch) rather
/// than O(document): no full snapshot is exported or re-imported per 150 ms batch.
///
/// `base_revision` pins the batch to a past revision of a surface; `None` applies it to the live
/// head.
pub fn prepare_batch_at_revision(
    project_id: &str,
    protocol: u32,
    ops: &[Op],
    base_version: &[u8],
    base_revision: Option<u64>,
) -> Result<(Vec<u8>, Vec<u8>), DocError> {
    if protocol != OP_PROTOCOL_VERSION {
        return Err(DocError::Protocol(protocol));
    }
    let base = if base_version.is_empty() {
        VersionVector::default()
    } else {
        VersionVector::decode(base_version).map_err(|error| DocError::Loro(error.to_string()))?
    };
    with_project(project_id, true, |project| {
        OperationBatch::v1(ops.to_vec())
            .validate()
            .map_err(|error| DocError::Rejected(error.to_string()))?;
        sync_shadow(project)?;
        project.prepared_author = None;
        let before = project.doc.oplog_vv();
        let applied = (|| {
            if let Some(revision) = base_revision.filter(|revision| *revision != project.revision) {
                let frontiers = project.revisions.get(&revision).ok_or_else(|| DocError::Rejected("surface base revision expired; refresh before retrying".into()))?;
                // A historical fork gets a fresh Loro peer id, avoiding reuse of a counter already
                // present in the live document. Transport attribution remains the signed device.
                let branch = project.doc.fork_at(frontiers)?;
                for operation in ops { apply_one(&branch, operation)?; }
                branch.commit();
                project.prepared_author = Some(branch.state_frontiers());
                let delta = branch.export(ExportMode::updates(&before)).map_err(|error| DocError::Loro(error.to_string()))?;
                project.shadow.import(&delta)?;
            } else {
                for operation in ops { apply_one(&project.shadow, operation)?; }
                project.shadow.commit();
                if base_revision.is_some() { project.prepared_author = Some(project.shadow.state_frontiers()); }
            }
            Ok(())
        })();
        if let Err(error) = applied {
            // A partial batch poisoned the shadow; the live document never saw any of it.
            project.shadow = fork_of(&project.doc)?;
            return Err(error);
        }
        project.shadow.commit();
        let update = project
            .shadow
            .export(ExportMode::updates(&before))
            .map_err(|error| DocError::Loro(error.to_string()))?;
        let head_delta = project
            .shadow
            .export(ExportMode::updates(&base))
            .map_err(|error| DocError::Loro(error.to_string()))?;
        Ok((update, head_delta))
    })
}

pub fn commit_update(
    project_id: &str,
    update: &[u8],
    applied: usize,
) -> Result<ApplyResult, DocError> {
    with_project(project_id, true, |project| {
        project.doc.import(update)?;
        let authored_revision = project.prepared_author.take().map(|frontiers| {
            project.revision += 1;
            project.revisions.insert(project.revision, frontiers);
            project.revision
        });
        project.revision += 1;
        save(project)?;
        while project.revisions.len() > 512 { project.revisions.pop_first(); }
        Ok(ApplyResult {
            authored_revision,
            revision: project.revision,
            applied,
        })
    })
}

/// Builds a checkpoint from an explicitly selected remote set. This deliberately has no access to
/// the live actor document: unpublished local work can therefore never leak into a checkpoint and
/// be lost when two devices compact concurrently.
pub fn compact_updates(updates: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), DocError> {
    let compacted = LoroDoc::new();
    for update in updates {
        compacted.import(update)?;
    }
    let version = compacted.oplog_vv().encode();
    let snapshot = compacted
        .export(ExportMode::Snapshot)
        .map_err(|error| DocError::Loro(error.to_string()))?;
    Ok((snapshot, version))
}

/// Everything the caller is missing, given the version vector its replica already holds.
pub fn pull(project_id: &str, since: &[u8]) -> Result<Vec<u8>, DocError> {
    let vv = if since.is_empty() {
        VersionVector::default()
    } else {
        VersionVector::decode(since).map_err(|err| DocError::Loro(err.to_string()))?
    };
    with_project(project_id, false, |project| {
        project
            .doc
            .export(ExportMode::updates(&vv))
            .map_err(|err| DocError::Loro(err.to_string()))
    })
}

/// Imports a remote update — from a peer, a head or a checkpoint — into the authoritative document.
pub fn merge(project_id: &str, update: &[u8]) -> Result<ApplyResult, DocError> {
    with_project(project_id, true, |project| {
        if !import_if_new(&project.doc, update)? {
            return Ok(ApplyResult {
                authored_revision: None,
                revision: project.revision,
                applied: 0,
            });
        }
        project.revision += 1;
        save(project)?;
        Ok(ApplyResult {
            authored_revision: None,
            revision: project.revision,
            applied: 1,
        })
    })
}

fn import_if_new(doc: &LoroDoc, update: &[u8]) -> Result<bool, DocError> {
    let before = doc.oplog_vv().encode();
    doc.import(update)?;
    Ok(doc.oplog_vv().encode() != before)
}

/// Undo is LOCAL: Loro's `UndoManager` only reverts this device's own operations, so nobody can
/// undo someone else's work. It creates a new operation; it never rewrites history.
pub fn undo(project_id: &str) -> Result<ApplyResult, DocError> {
    with_project(project_id, true, |project| {
        project
            .undo
            .undo()
            .map_err(|err| DocError::Loro(err.to_string()))?;
        project.doc.commit();
        project.revision += 1;
        save(project)?;
        Ok(ApplyResult {
            authored_revision: None,
            revision: project.revision,
            applied: 1,
        })
    })
}

pub fn redo(project_id: &str) -> Result<ApplyResult, DocError> {
    with_project(project_id, true, |project| {
        project
            .undo
            .redo()
            .map_err(|err| DocError::Loro(err.to_string()))?;
        project.doc.commit();
        project.revision += 1;
        save(project)?;
        Ok(ApplyResult {
            authored_revision: None,
            revision: project.revision,
            applied: 1,
        })
    })
}

/// The document's own version vector, encoded — what a replica sends back on the next `pull`.
pub fn version(project_id: &str) -> Result<Vec<u8>, DocError> {
    with_project(project_id, false, |project| {
        Ok(project.doc.oplog_vv().encode())
    })
}

pub fn projection(project_id: &str) -> Result<ProjectProjection, DocError> {
    with_project(project_id, false, |project| {
        project.revisions.insert(project.revision, project.doc.state_frontiers());
        while project.revisions.len() > 512 { project.revisions.pop_first(); }
        project_projection_from_doc(&project.doc, project.revision)
    })
}

pub(crate) fn projection_media_hashes(
    projection: &ProjectProjection,
) -> std::collections::HashSet<String> {
    fn add_asset(
        hashes: &mut std::collections::HashSet<String>,
        asset: &crate::collab::ops::MediaAsset,
    ) {
        if let Some(hash) = &asset.content_hash {
            hashes.insert(hash.clone());
        }
        // The preview is its own blob: authorised, pinned, and served exactly like the original.
        if let Some(hash) = &asset.preview_hash {
            hashes.insert(hash.clone());
        }
    }

    let mut hashes = std::collections::HashSet::new();
    for entry in &projection.entries {
        for manifest in entry.media.values() {
            add_asset(&mut hashes, &manifest.primary);
            if let Some(previous) = &manifest.previous { add_asset(&mut hashes, &previous.asset); }
            if let Some(local) = &manifest.local { add_asset(&mut hashes, &local.asset); }
        }
    }
    hashes
}

/// Content hashes the current document authorises this project to request or serve.
///
/// The P2P media protocol calls this after it has already authenticated the peer and project. A
/// hash learned in a different project is therefore not enough to read bytes from this machine.
pub fn media_hashes(project_id: &str) -> Result<std::collections::HashSet<String>, DocError> {
    projection(project_id).map(|projection| projection_media_hashes(&projection))
}

/// The renderer-facing media protocol has no peer roster to check. It must refuse a document that
/// is not currently leased instead of using `with_project`, which intentionally opens durable
/// documents on demand for recovery.
pub fn open_media_hashes(
    project_id: &str,
) -> Result<Option<std::collections::HashSet<String>>, DocError> {
    ProjectId::parse(project_id).map_err(|error| DocError::Rejected(error.to_string()))?;
    let leased = LEASED_PROJECTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .is_some_and(|projects| projects.contains(project_id));
    if !leased {
        return Ok(None);
    }
    let mut guard = PROJECTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(project) = guard.get_or_insert_with(HashMap::new).get_mut(project_id) else {
        return Ok(None);
    };
    let projection = project_projection_from_doc(&project.doc, project.revision)?;
    Ok(Some(projection_media_hashes(&projection)))
}

/// Grants renderer media access only after the native actor has installed a project lease.
pub fn activate(project_id: &str) -> Result<(), DocError> {
    ProjectId::parse(project_id).map_err(|error| DocError::Rejected(error.to_string()))?;
    LEASED_PROJECTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_or_insert_with(HashSet::new)
        .insert(project_id.to_owned());
    Ok(())
}

/// Releases the in-memory authority after the last native project lease closes.
pub fn close(project_id: &str) -> Result<bool, DocError> {
    ProjectId::parse(project_id).map_err(|error| DocError::Rejected(error.to_string()))?;
    LEASED_PROJECTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_or_insert_with(HashSet::new)
        .remove(project_id);
    let mut guard = PROJECTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let removed = guard.get_or_insert_with(HashMap::new).remove(project_id);
    // Last chance to persist the throttled snapshot cache. Failure is not data loss — the SQLite
    // store replays on the next open — so it must not block closing the project.
    if let Some(mut project) = removed {
        if project.dirty {
            let _ = write_snapshot(&mut project);
        }
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod path_tests {
    use super::{
        activate, apply_batch_to_doc, close, import_if_new, open_media_hashes, project_path,
        project_projection_from_doc, projection, Op,
    };
    use loro::{ExportMode, LoroDoc};

    #[test]
    fn empty_document_has_a_total_empty_projection() {
        let projection = project_projection_from_doc(&LoroDoc::new(), 4).expect("projection");
        assert_eq!(projection.revision, 4);
        assert!(projection.entries.is_empty());
    }

    #[test]
    fn unknown_root_containers_are_ignored_by_the_projection() {
        let doc = LoroDoc::new();
        let legacy = doc.get_map("items").ensure_mergeable_map("old").expect("legacy entry");
        legacy.insert("kind", "image").expect("insert");
        doc.get_movable_list("order").insert(0, "old").expect("order");
        doc.commit();
        let projection = project_projection_from_doc(&doc, 0).expect("projection");
        assert!(projection.entries.is_empty());
    }

    #[test]
    fn closing_the_last_lease_removes_renderer_media_authority() {
        let token = crate::collab::ids::OpaqueToken::generate().expect("token");
        let project_id = format!("close-media-{}", token.as_str());
        projection(&project_id).expect("open document");
        assert!(open_media_hashes(&project_id)
            .expect("unleased hashes")
            .is_none());
        activate(&project_id).expect("lease");
        assert!(open_media_hashes(&project_id)
            .expect("open hashes")
            .is_some());
        assert!(close(&project_id).expect("close"));
        assert!(open_media_hashes(&project_id)
            .expect("closed hashes")
            .is_none());
    }

    #[test]
    fn document_path_hashes_and_validates_project_id() {
        let path = project_path("visible-project-name").expect("valid path");
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("UTF-8 file name");
        assert!(!file.contains("visible-project-name"));
        assert!(project_path("../escape").is_err());
    }

    #[test]
    fn invalid_second_operation_rolls_back_the_first_operation() {
        let doc = LoroDoc::new();
        let operations: Vec<Op> = serde_json::from_value(serde_json::json!([
            { "type": "surfaceSetEntry", "entryId": "page-one", "kind": "page", "fields": {} },
            { "type": "surfaceTextInsert", "entryId": "missing", "field": "title", "index": 0, "text": "x" }
        ]))
        .expect("operations");

        assert!(apply_batch_to_doc(&doc, &operations).is_err());
        let projection = project_projection_from_doc(&doc, 0).expect("projection");
        assert!(projection.entries.is_empty());
    }

    #[test]
    fn replaying_the_same_remote_update_is_a_noop() {
        let source = LoroDoc::new();
        source
            .get_map("fixture")
            .insert("value", 1)
            .expect("insert");
        source.commit();
        let update = source.export(ExportMode::all_updates()).expect("update");
        let target = LoroDoc::new();
        assert!(import_if_new(&target, &update).expect("first import"));
        assert!(!import_if_new(&target, &update).expect("duplicate import"));
    }
}