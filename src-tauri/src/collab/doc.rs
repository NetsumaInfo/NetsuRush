//! The collaborative document (`docs/collab.md` §3).
//!
//! One authoritative Loro document per project, owned here. Renderers receive total projections and
//! never write into containers: they send typed operations, Rust validates and applies them.
//!
//! Why not a generic `set(path)` API: it would let a buggy — or compromised — renderer build states
//! the board cannot represent, and it would step straight past the atomicity rules below. Geometry,
//! crop, trim and every other group is ONE value, so two people dragging the same item produce one
//! winner rather than Alice's position married to Bob's size.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use loro::{ExportMode, LoroDoc, LoroMap, LoroMovableList, LoroValue, VersionVector};
use serde::de::DeserializeOwned;
use serde::Serialize;

#[path = "surface_doc.rs"]
mod surface;

use super::identity;
use super::ids::ProjectId;
pub use super::ops::CollabOp as Op;
use super::ops::{
    Appearance, BoardPalette, CollabOp, Crop, EmbedMetadata, FrameStyle, Geometry, ItemKind,
    LinkMetadata, MediaManifest, OperationBatch, Playback, SequenceMetadata, Stroke, TextStyle,
    Trim, VectorShape, OP_PROTOCOL_VERSION,
};

/// Layout of the document itself. A build that does not understand it opens the project read-only
/// rather than rewriting it into something the writer cannot read back.
const DOC_SCHEMA_VERSION: i64 = 1;
const ROOT_META: &str = "meta";
const ROOT_ITEMS: &str = "items";
const ROOT_ORDER: &str = "order";
const ROOT_STROKES: &str = "strokes";
const ROOT_STROKE_ORDER: &str = "strokeOrder";
const ROOT_SHAPES: &str = "shapes";
const ROOT_SHAPE_ORDER: &str = "shapeOrder";

const KEY_SCHEMA: &str = "schemaVersion";
const KEY_DELETED: &str = "deleted";
const KEY_TEXT: &str = "text";

#[derive(Debug)]
pub enum DocError {
    Io(String),
    Loro(String),
    /// The document was written by a newer build. Opened read-only, never rewritten.
    Schema(i64),
    /// The renderer speaks another operation protocol.
    Protocol(u32),
    /// The operation cannot apply to this document: unknown item, tombstoned item, bad payload.
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
pub struct ItemProjection {
    pub item_id: String,
    pub kind: ItemKind,
    pub geometry: Geometry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trim: Option<Trim>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_style: Option<TextStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_style: Option<FrameStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback: Option<Playback>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed: Option<EmbedMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<SequenceMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<BoardPalette>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProjection {
    pub entries: Vec<surface::SurfaceEntryProjection>,
    pub revision: u64,
    pub items: Vec<ItemProjection>,
    pub order: Vec<String>,
    pub strokes: Vec<Stroke>,
    pub shapes: Vec<VectorShape>,
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

fn items(doc: &LoroDoc) -> LoroMap {
    doc.get_map(ROOT_ITEMS)
}

fn order(doc: &LoroDoc) -> LoroMovableList {
    doc.get_movable_list(ROOT_ORDER)
}

/// The item map, refusing a tombstoned or unknown id.
///
/// Ids are never reused, so a late operation that arrives after a deletion cannot resurrect an item:
/// it is refused here instead of writing into a container the projection already filters out.
/// Une entrée présente dans une map est-elle une PIERRE TOMBALE ?
///
/// Supprimer ne retire pas l'entrée, ça lève ce drapeau. Refuser tout id déjà présent revenait donc
/// à refuser la RÉAPPARITION d'un objet supprimé — ce qui est exactement ce qu'une annulation
/// demande, l'historique du board restituant les ids d'origine. Et un lot rejeté l'est en ENTIER :
/// un seul Ctrl+Z après une suppression faisait tomber tout le lot, l'annulation était perdue et
/// une notice d'erreur restait collée. Un id VIVANT reste refusé : celui-là est une vraie collision.
fn is_tombstoned(entry: &LoroMap) -> bool {
    matches!(
        entry.get(KEY_DELETED).and_then(|value| value.into_value().ok()),
        Some(LoroValue::Bool(true))
    )
}

fn live_item(doc: &LoroDoc, id: &str) -> Result<LoroMap, DocError> {
    let item = items(doc)
        .get(id)
        .and_then(|value| value.into_container().ok())
        .and_then(|container| container.into_map().ok())
        .ok_or_else(|| DocError::Rejected(format!("unknown item {id}")))?;
    if matches!(
        item.get(KEY_DELETED).and_then(|v| v.into_value().ok()),
        Some(LoroValue::Bool(true))
    ) {
        return Err(DocError::Rejected(format!("item {id} is deleted")));
    }
    Ok(item)
}

fn json<T: Serialize>(value: &T) -> Result<String, DocError> {
    serde_json::to_string(value).map_err(|error| DocError::Rejected(error.to_string()))
}

fn set_atomic<T: Serialize>(doc: &LoroDoc, id: &str, key: &str, value: &T) -> Result<(), DocError> {
    live_item(doc, id)?.insert(key, json(value)?)?;
    Ok(())
}

fn index_in_order(list: &LoroMovableList, id: &str) -> Option<usize> {
    for index in 0..list.len() {
        if let Some(LoroValue::String(found)) = list.get(index).and_then(|v| v.into_value().ok()) {
            if found.as_str() == id {
                return Some(index);
            }
        }
    }
    None
}

fn ordered_ids(list: &LoroMovableList) -> Vec<String> {
    (0..list.len())
        .filter_map(|index| list.get(index))
        .filter_map(|value| value.into_value().ok())
        .filter_map(|value| match value {
            LoroValue::String(value) => Some(value.to_string()),
            _ => None,
        })
        .collect()
}

fn atomic<T: DeserializeOwned>(map: &LoroMap, key: &str) -> Result<Option<T>, DocError> {
    let Some(LoroValue::String(raw)) = map.get(key).and_then(|value| value.into_value().ok())
    else {
        return Ok(None);
    };
    serde_json::from_str::<Option<T>>(raw.as_str())
        .map_err(|error| DocError::Loro(format!("invalid {key} group: {error}")))
}

fn kind(map: &LoroMap) -> Result<ItemKind, DocError> {
    let Some(LoroValue::String(value)) = map.get("kind").and_then(|value| value.into_value().ok())
    else {
        return Err(DocError::Loro("item has no kind".into()));
    };
    serde_json::from_str(&format!("\"{}\"", value.as_str()))
        .map_err(|error| DocError::Loro(format!("invalid item kind: {error}")))
}

fn text_value(map: &LoroMap) -> Option<String> {
    map.get(KEY_TEXT)
        .and_then(|value| value.into_container().ok())
        .and_then(|container| container.into_text().ok())
        .map(|text| text.to_string())
}

fn ordered_data<T: DeserializeOwned>(
    map: LoroMap,
    list: LoroMovableList,
) -> Result<Vec<T>, DocError> {
    let mut output = Vec::new();
    for id in ordered_ids(&list) {
        let Some(entry) = map
            .get(&id)
            .and_then(|value| value.into_container().ok())
            .and_then(|container| container.into_map().ok())
        else {
            continue;
        };
        if matches!(
            entry
                .get(KEY_DELETED)
                .and_then(|value| value.into_value().ok()),
            Some(LoroValue::Bool(true))
        ) {
            continue;
        }
        let Some(LoroValue::String(raw)) =
            entry.get("data").and_then(|value| value.into_value().ok())
        else {
            continue;
        };
        output.push(
            serde_json::from_str(raw.as_str())
                .map_err(|error| DocError::Loro(format!("invalid ordered data: {error}")))?,
        );
    }
    Ok(output)
}

fn project_projection_from_doc(
    doc: &LoroDoc,
    revision: u64,
) -> Result<ProjectProjection, DocError> {
    let mut projected_items = Vec::new();
    let mut projected_order = Vec::new();
    for id in ordered_ids(&order(doc)) {
        let Ok(item) = live_item(doc, &id) else {
            continue;
        };
        let Some(geometry) = atomic::<Geometry>(&item, "geometry")? else {
            return Err(DocError::Loro(format!("item {id} has no geometry")));
        };
        projected_order.push(id.clone());
        projected_items.push(ItemProjection {
            item_id: id,
            kind: kind(&item)?,
            geometry,
            crop: atomic(&item, "crop")?,
            trim: atomic(&item, "trim")?,
            appearance: atomic(&item, "appearance")?,
            text_style: atomic(&item, "textStyle")?,
            text: text_value(&item),
            frame_style: atomic(&item, "frameStyle")?,
            playback: atomic(&item, "playback")?,
            media: atomic(&item, "media")?,
            link: atomic(&item, "link")?,
            embed: atomic(&item, "embed")?,
            sequence: atomic(&item, "sequence")?,
            palette: atomic(&item, "palette")?,
        });
    }
    Ok(ProjectProjection {
        entries: surface::projection(doc)?,
        revision,
        items: projected_items,
        order: projected_order,
        strokes: ordered_data(
            doc.get_map(ROOT_STROKES),
            doc.get_movable_list(ROOT_STROKE_ORDER),
        )?,
        shapes: ordered_data(
            doc.get_map(ROOT_SHAPES),
            doc.get_movable_list(ROOT_SHAPE_ORDER),
        )?,
        local_hashes: Vec::new(),
    })
}

fn apply_one(doc: &LoroDoc, op: &CollabOp) -> Result<(), DocError> {
    match op {
        CollabOp::SurfaceRestoreEntry { .. } | CollabOp::SurfaceTextFormat { .. } | CollabOp::SurfaceSetEntry { .. } | CollabOp::SurfaceDeleteEntry { .. } | CollabOp::SurfaceTextInsert { .. } | CollabOp::SurfaceTextDelete { .. } | CollabOp::SurfaceSetMedia { .. } => surface::apply(doc, op)?,
        CollabOp::AddItem {
            item_id,
            kind,
            geometry,
        } => {
            let id = item_id.as_str();
            let existing = items(doc)
                .get(id)
                .and_then(|value| value.into_container().ok())
                .and_then(|container| container.into_map().ok());
            if let Some(entry) = &existing {
                if !is_tombstoned(entry) {
                    return Err(DocError::Rejected(format!("item {id} already exists")));
                }
            }
            let item = items(doc).ensure_mergeable_map(id)?;
            item.insert("kind", json(kind)?.trim_matches('"'))?;
            item.insert("geometry", json(geometry)?)?;
            item.insert(KEY_DELETED, false)?;
            let list = order(doc);
            // Un item ressuscité a quitté l'ordre à sa suppression ; un id qui y serait resté ne
            // doit pas y figurer deux fois.
            if index_in_order(&list, id).is_none() {
                list.insert(list.len(), id)?;
            }
        }
        // Delete wins over move: the tombstone stays and the id leaves the order. A concurrent move
        // may put the id back, which is why the projection filters tombstones as well.
        CollabOp::DeleteItem { item_id } => {
            let id = item_id.as_str();
            let item = live_item(doc, id)?;
            item.insert(KEY_DELETED, true)?;
            if let Some(index) = index_in_order(&order(doc), id) {
                order(doc).delete(index, 1)?;
            }
        }
        CollabOp::SetGeometry { item_id, geometry } => {
            set_atomic(doc, item_id.as_str(), "geometry", geometry)?
        }
        CollabOp::SetCrop { item_id, crop } => set_atomic(doc, item_id.as_str(), "crop", crop)?,
        CollabOp::SetTrim { item_id, trim } => set_atomic(doc, item_id.as_str(), "trim", trim)?,
        CollabOp::SetAppearance {
            item_id,
            appearance,
        } => set_atomic(doc, item_id.as_str(), "appearance", appearance)?,
        CollabOp::SetTextStyle { item_id, style } => {
            set_atomic(doc, item_id.as_str(), "textStyle", style)?
        }
        CollabOp::SetFrameStyle { item_id, frame } => {
            set_atomic(doc, item_id.as_str(), "frameStyle", frame)?
        }
        CollabOp::SetPlayback { item_id, playback } => {
            set_atomic(doc, item_id.as_str(), "playback", playback)?
        }
        CollabOp::SetMediaManifest { item_id, manifest } => {
            set_atomic(doc, item_id.as_str(), "media", manifest)?
        }
        CollabOp::SetLink { item_id, link } => set_atomic(doc, item_id.as_str(), "link", link)?,
        CollabOp::SetEmbed { item_id, embed } => set_atomic(doc, item_id.as_str(), "embed", embed)?,
        CollabOp::SetSequence { item_id, sequence } => {
            set_atomic(doc, item_id.as_str(), "sequence", sequence)?
        }
        CollabOp::SetPalette { item_id, palette } => {
            set_atomic(doc, item_id.as_str(), "palette", palette)?
        }
        // Text is the ONE field that must not be a whole-value write: two people typing in the same
        // note have to merge character by character, which is what LoroText is for.
        CollabOp::TextInsert {
            item_id,
            index,
            text,
        } => {
            let id = item_id.as_str();
            let item = live_item(doc, id)?;
            let content = item.ensure_mergeable_text(KEY_TEXT)?;
            let index = *index as usize;
            if index > content.len_unicode() {
                return Err(DocError::Rejected("text index out of range".into()));
            }
            content.insert(index, text)?;
        }
        CollabOp::TextDelete {
            item_id,
            index,
            len,
        } => {
            let id = item_id.as_str();
            let item = live_item(doc, id)?;
            let content = item.ensure_mergeable_text(KEY_TEXT)?;
            let index = *index as usize;
            let len = *len as usize;
            if index.saturating_add(len) > content.len_unicode() {
                return Err(DocError::Rejected("text range out of bounds".into()));
            }
            content.delete(index, len)?;
        }
        CollabOp::MoveItem { item_id, before } => {
            let id = item_id.as_str();
            live_item(doc, id)?;
            let list = order(doc);
            let from = index_in_order(&list, id)
                .ok_or_else(|| DocError::Rejected(format!("item {id} is not in the order")))?;
            let target = if let Some(before) = before {
                let before_id = before.as_str();
                live_item(doc, before_id)?;
                let before_index = index_in_order(&list, before_id).ok_or_else(|| {
                    DocError::Rejected(format!("item {before_id} is not in the order"))
                })?;
                if from < before_index {
                    before_index.saturating_sub(1)
                } else {
                    before_index
                }
            } else {
                list.len().saturating_sub(1)
            };
            list.mov(from, target)?;
        }
        // A finished stroke is one immutable value, not a list of points: one operation instead of
        // thousands. Erasing part of a stroke deletes it and adds the remaining segments as new ones.
        // A stroke holds no editable field of its own, so CHANGING one (its colour, width, opacity,
        // or the item it belongs to) is expressed as a delete followed by an add on the same id,
        // usually inside a single batch. Deleting only raises the tombstone — the entry stays — so
        // refusing every id already present rejected the whole batch, and with it any edit made to
        // an existing pen stroke on a shared board. A LIVE id is still refused: that one is a
        // genuine collision. Re-adding over a tombstone revives the entry with the new value.
        CollabOp::AddStroke(stroke_value) => {
            let id = stroke_value.stroke_id.as_str();
            let strokes = doc.get_map(ROOT_STROKES);
            let existing = strokes
                .get(id)
                .and_then(|value| value.into_container().ok())
                .and_then(|container| container.into_map().ok());
            if let Some(entry) = &existing {
                if !is_tombstoned(entry) {
                    return Err(DocError::Rejected(format!("stroke {id} already exists")));
                }
            }
            let stroke = strokes.ensure_mergeable_map(id)?;
            stroke.insert("data", json(stroke_value)?)?;
            stroke.insert(KEY_DELETED, false)?;
            let list = doc.get_movable_list(ROOT_STROKE_ORDER);
            // A revived stroke was taken out of the order when it was deleted; a stroke that
            // somehow kept its slot must not be listed twice.
            if index_in_order(&list, id).is_none() {
                list.insert(list.len(), id)?;
            }
        }
        CollabOp::DeleteStroke { stroke_id } => {
            let id = stroke_id.as_str();
            let strokes = doc.get_map(ROOT_STROKES);
            let stroke = strokes
                .get(id)
                .and_then(|value| value.into_container().ok())
                .and_then(|container| container.into_map().ok())
                .ok_or_else(|| DocError::Rejected(format!("unknown stroke {id}")))?;
            stroke.insert(KEY_DELETED, true)?;
            let list = doc.get_movable_list(ROOT_STROKE_ORDER);
            if let Some(index) = index_in_order(&list, id) {
                list.delete(index, 1)?;
            }
        }
        CollabOp::UpsertShape(shape_value) => {
            let id = shape_value.shape_id.as_str();
            let shapes = doc.get_map(ROOT_SHAPES);
            let shape = shapes.ensure_mergeable_map(id)?;
            let revived = is_tombstoned(&shape);
            shape.insert("data", json(shape_value)?)?;
            shape.insert(KEY_DELETED, false)?;
            let list = doc.get_movable_list(ROOT_SHAPE_ORDER);
            // Une forme supprimée a quitté l'ordre : la ré-poser la remet dans la pile. Sinon
            // (simple mise à jour), l'ordre est déjà juste et la toucher la ferait remonter.
            if revived || index_in_order(&list, id).is_none() {
                list.insert(list.len(), id)?;
            }
        }
        CollabOp::DeleteShape { shape_id } => {
            let id = shape_id.as_str();
            let shapes = doc.get_map(ROOT_SHAPES);
            let shape = shapes
                .get(id)
                .and_then(|value| value.into_container().ok())
                .and_then(|container| container.into_map().ok())
                .ok_or_else(|| DocError::Rejected(format!("unknown shape {id}")))?;
            shape.insert(KEY_DELETED, true)?;
            let list = doc.get_movable_list(ROOT_SHAPE_ORDER);
            if let Some(index) = index_in_order(&list, id) {
                list.delete(index, 1)?;
            }
        }
    }
    Ok(())
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
/// than O(document): no full snapshot is exported or re-imported per 150 ms batch, which is what a
/// drag on a large board is made of.
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
    for item in &projection.items {
        if let Some(manifest) = &item.media {
            add_asset(&mut hashes, &manifest.primary);
            if let Some(previous) = &manifest.previous {
                add_asset(&mut hashes, &previous.asset);
            }
            if let Some(local) = &manifest.local {
                add_asset(&mut hashes, &local.asset);
            }
        }
        if let Some(sequence) = &item.sequence {
            for frame in &sequence.frames {
                add_asset(&mut hashes, frame);
            }
        }
        if let Some(link) = &item.link {
            if matches!(link.kind, crate::collab::ops::LinkKind::File) {
                hashes.insert(link.target.clone());
            }
        }
    }
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
        activate, apply_batch_to_doc, close, import_if_new, items, live_item, open_media_hashes,
        project_path, project_projection_from_doc, projection, Op, KEY_TEXT,
    };
    use crate::collab::ops::{Geometry, ItemKind};
    use loro::{ExportMode, LoroDoc, LoroValue};

    /// Annuler une suppression restitue les ids d'ORIGINE : l'historique du board n'est pas celui du
    /// document. Refuser tout id déjà présent revenait à refuser cette réapparition — et un lot
    /// rejeté l'est en entier, donc le premier Ctrl+Z après une suppression perdait tout le lot.
    #[test]
    fn deleting_then_re_adding_the_same_id_is_accepted() {
        let doc = LoroDoc::new();
        let add = || Op::AddItem {
            item_id: "item-a".into(),
            kind: ItemKind::Image,
            geometry: geometry(1.0),
        };
        apply_batch_to_doc(&doc, &[add()]).expect("premier ajout");
        apply_batch_to_doc(
            &doc,
            &[Op::DeleteItem { item_id: "item-a".into() }],
        )
        .expect("suppression");

        // Ctrl+Z : le même id revient.
        apply_batch_to_doc(&doc, &[add()]).expect("the undo must be accepted");
        let projection = project_projection_from_doc(&doc, 0).expect("projection");
        assert_eq!(projection.items.len(), 1);
        // Une seule occurrence dans l'ordre : ressusciter ne doit pas empiler l'id deux fois.
        assert_eq!(projection.order, vec!["item-a".to_string()]);

        // Un id VIVANT reste une vraie collision.
        assert!(apply_batch_to_doc(&doc, &[add()]).is_err());
    }

    fn geometry(x: f64) -> Geometry {
        Geometry {
            x,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 0.0,
            natural_width: None,
            natural_height: None,
            detached: false,
        }
    }

    #[test]
    fn empty_document_has_a_total_empty_projection() {
        let projection = project_projection_from_doc(&LoroDoc::new(), 4).expect("projection");
        assert_eq!(projection.revision, 4);
        assert!(projection.items.is_empty());
        assert!(projection.order.is_empty());
        assert!(projection.strokes.is_empty());
        assert!(projection.shapes.is_empty());
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
        let operations = vec![
            Op::AddItem {
                item_id: "one".into(),
                kind: ItemKind::Text,
                geometry: geometry(0.0),
            },
            Op::SetGeometry {
                item_id: "missing".into(),
                geometry: geometry(1.0),
            },
        ];

        assert!(apply_batch_to_doc(&doc, &operations).is_err());
        assert!(items(&doc).get("one").is_none());
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

    #[test]
    fn text_indices_are_unicode_scalar_indices() {
        let doc = LoroDoc::new();
        let operations = vec![
            Op::AddItem {
                item_id: "note".into(),
                kind: ItemKind::Text,
                geometry: geometry(0.0),
            },
            Op::TextInsert {
                item_id: "note".into(),
                index: 0,
                text: "a👩🏽‍🎨z".into(),
            },
            Op::TextInsert {
                item_id: "note".into(),
                index: 1,
                text: "é".into(),
            },
        ];

        apply_batch_to_doc(&doc, &operations).expect("apply Unicode text");
        let text = live_item(&doc, "note")
            .expect("note")
            .get(KEY_TEXT)
            .and_then(|value| value.into_container().ok())
            .and_then(|container| container.into_text().ok())
            .expect("text");
        assert_eq!(text.to_string(), "aé👩🏽‍🎨z");
        assert!(matches!(
            items(&doc)
                .get("note")
                .and_then(|value| value.into_container().ok())
                .and_then(|container| container.into_map().ok())
                .and_then(|map| map.get("kind"))
                .and_then(|value| value.into_value().ok()),
            Some(LoroValue::String(kind)) if kind.as_str() == "text"
        ));
    }

    #[test]
    fn two_through_ten_replicas_converge_across_the_complete_board_contract() {
        use serde_json::json;

        let geometry = |x: f64| {
            json!({
                "x": x, "y": 0.0, "width": 100.0, "height": 80.0,
                "rotation": 0.0, "detached": false,
            })
        };
        let base_ops: Vec<Op> = serde_json::from_value(json!([
            { "type": "addItem", "itemId": "shared", "kind": "video", "geometry": geometry(0.0) },
            { "type": "addItem", "itemId": "temporary", "kind": "image", "geometry": geometry(1.0) },
            { "type": "addItem", "itemId": "note", "kind": "text", "geometry": geometry(2.0) },
            { "type": "addItem", "itemId": "frame", "kind": "frame", "geometry": geometry(3.0) },
            { "type": "addItem", "itemId": "sequence", "kind": "sequence", "geometry": geometry(4.0) },
            { "type": "addItem", "itemId": "palette", "kind": "palette", "geometry": geometry(5.0) }
        ]))
        .expect("base operations");
        let base = LoroDoc::new();
        base.set_peer_id(100).expect("peer id");
        apply_batch_to_doc(&base, &base_ops).expect("base");
        let base_version = base.oplog_vv();
        let snapshot = base.export(ExportMode::Snapshot).expect("snapshot");

        let batches = vec![
            json!([
                { "type": "setGeometry", "itemId": "shared", "geometry": {
                    "x": 50.0, "y": 20.0, "width": 320.0, "height": 180.0,
                    "rotation": 12.0, "naturalWidth": 1920.0, "naturalHeight": 1080.0,
                    "detached": false
                }},
                { "type": "deleteItem", "itemId": "temporary" }
            ]),
            json!([
                { "type": "setCrop", "itemId": "shared", "crop": { "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8 } },
                { "type": "setTrim", "itemId": "shared", "trim": { "start": 1.0, "end": 3.0, "duration": 5.0 } }
            ]),
            json!([{ "type": "setAppearance", "itemId": "shared", "appearance": {
                "title": "Clip", "opacity": 0.8, "flipHorizontal": true, "flipVertical": false
            }}]),
            json!([
                { "type": "setTextStyle", "itemId": "note", "style": {
                    "fontSize": 24.0, "fontFamily": "Inter", "color": "#ffffff",
                    "background": "#000000", "highlight": "#ff0000", "lineHeight": 1.4,
                    "indent": 1, "bullet": true, "numbered": false, "strike": false,
                    "align": "center", "bold": true, "italic": true, "underline": false
                }},
                { "type": "textInsert", "itemId": "note", "index": 0, "text": "Bonjour 👋" }
            ]),
            json!([{ "type": "setFrameStyle", "itemId": "frame", "frame": {
                "fillMode": "tint", "fillColor": "#112233", "titleBackground": "#445566"
            }}]),
            json!([{ "type": "setPlayback", "itemId": "sequence", "playback": {
                "playMode": "pingpong", "frame": 2, "fps": 12.0, "speed": 1.5,
                "sequencePlaying": false, "sequenceIn": 1, "sequenceOut": 3
            }}]),
            json!([{ "type": "setMediaManifest", "itemId": "shared", "manifest": {
                "primary": {
                    "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "displayName": "clip.mp4", "mime": "video/mp4", "size": 42
                }
            }}]),
            json!([
                { "type": "setLink", "itemId": "note", "link": {
                    "kind": "url", "target": "https://example.com/reference", "label": "Source"
                }},
                { "type": "setEmbed", "itemId": "shared", "embed": {
                    "level": "full", "quality": "high", "marginSeconds": 2.0
                }}
            ]),
            json!([
                { "type": "setSequence", "itemId": "sequence", "sequence": { "frames": [{
                    "remoteUrl": "https://example.com/frame.png", "displayName": "frame.png",
                    "mime": "image/png", "size": 10
                }]}},
                { "type": "setPalette", "itemId": "palette", "palette": {
                    "colors": ["#112233", "#abcdef"], "sourceItemIds": ["shared"],
                    "showValues": true, "colorFormat": "hex", "layout": "grid"
                }},
                { "type": "moveItem", "itemId": "palette", "before": "shared" }
            ]),
            json!([
                { "type": "addStroke", "strokeId": "stroke-one", "color": "#fff",
                  "width": 3.0, "opacity": 1.0, "encodedPoints": "AQID", "detached": false },
                { "type": "upsertShape", "shapeId": "shape-one", "kind": "arrow",
                  "color": "#fff", "width": 2.0, "points": [0.0, 0.0, 10.0, 10.0],
                  "startHead": "none", "endHead": "arrow", "dash": "solid",
                  "route": "straight", "opacity": 1.0, "rounded": false,
                  "ownerPoints": [], "detached": true }
            ]),
        ];

        for replica_count in 2..=10 {
            let mut updates = Vec::new();
            for (index, batch) in batches.iter().take(replica_count).enumerate() {
                let replica = LoroDoc::new();
                replica.import(&snapshot).expect("replica snapshot");
                replica.set_peer_id((index + 1) as u64).expect("peer id");
                let operations: Vec<Op> =
                    serde_json::from_value(batch.clone()).expect("operations");
                apply_batch_to_doc(&replica, &operations).expect("replica operation");
                updates.push(
                    replica
                        .export(ExportMode::updates(&base_version))
                        .expect("replica update"),
                );
            }

            let left = LoroDoc::new();
            left.import(&snapshot).expect("left snapshot");
            for update in &updates {
                left.import(update).expect("left update");
            }
            let right = LoroDoc::new();
            right.import(&snapshot).expect("right snapshot");
            for update in updates.iter().rev() {
                right.import(update).expect("right update");
            }
            assert_eq!(
                serde_json::to_value(
                    project_projection_from_doc(&left, 0).expect("left projection")
                )
                .expect("left JSON"),
                serde_json::to_value(
                    project_projection_from_doc(&right, 0).expect("right projection")
                )
                .expect("right JSON"),
                "{replica_count} replicas must converge regardless of import order",
            );
        }

        let final_doc = LoroDoc::new();
        final_doc.import(&snapshot).expect("final snapshot");
        for (index, batch) in batches.into_iter().enumerate() {
            let replica = LoroDoc::new();
            replica.import(&snapshot).expect("replica snapshot");
            replica.set_peer_id((index + 1) as u64).expect("peer id");
            let operations: Vec<Op> = serde_json::from_value(batch).expect("operations");
            let update = apply_batch_to_doc(&replica, &operations).expect("operation");
            final_doc.import(&update).expect("final update");
        }
        let projection = project_projection_from_doc(&final_doc, 0).expect("projection");
        assert!(!projection.order.contains(&"temporary".to_owned()));
        assert_eq!(projection.strokes.len(), 1);
        assert_eq!(projection.shapes.len(), 1);
        let shared = projection
            .items
            .iter()
            .find(|item| item.item_id == "shared")
            .expect("shared item");
        assert!(shared.crop.is_some() && shared.trim.is_some() && shared.media.is_some());
        assert!(shared.appearance.is_some() && shared.embed.is_some());
    }
}
