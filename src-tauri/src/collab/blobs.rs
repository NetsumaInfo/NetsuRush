//! Media transfer and the blob store (`docs/collab.md` §4).
//!
//! The document carries manifests — hash, name, MIME, size — and never bytes. Originals travel
//! peer-to-peer, on demand, and are verified against their hash on arrival.
//!
//! **BLAKE3 is the network identity of a blob.** The existing solo asset store keeps its own naming
//! until a project is converted; this store is separate and owned by Rust alone, so Node and Rust
//! never write into the same directory.
//!
//! Retention is decoupled from document history (§4.2): Loro keeps references, not bytes, so a full
//! CRDT history does not oblige this machine to keep every media file it ever saw.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use rusqlite::OptionalExtension as _;
use serde::{Deserialize, Serialize};

/// Requests carry an offset so an interrupted transfer resumes instead of starting over.
pub const ALPN_BLOB: &[u8] = b"netsurush/blob/1";

/// A blob dropped from the current state is kept this long before it can be collected. Every peer
/// applies the same delay, so recovery after it is best-effort and never a promise.
const GRACE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Interrupted imports, downloads, and atomic metadata writes are disposable after one day. Active
/// transfers refresh their modification time on every chunk, so collection cannot race a healthy
/// transfer unless it has made no progress for a full day.
const PART_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Bounded so a peer cannot ask this machine to allocate arbitrarily; larger media stream in
/// chunks. Each chunk costs one stream round trip, so the size balances per-request latency
/// against the memory both ends hold at once — 4 MiB keeps a video transfer request-bound no more
/// than 1/16th as often as the previous 256 KiB while staying far under `MAX_FRAME`.
pub const TRANSFER_CHUNK: usize = 4 * 1024 * 1024;
const PROTOCOL_CHUNK: u64 = 8 * 1024 * 1024;
/// Plafond d'UNE réponse construite en mémoire. Une image doit arriver entière (un `<img>` ne sait
/// pas redemander la suite), mais pas au prix d'un tampon arbitraire dans le processus d'interface.
const MAX_INLINE_RESPONSE: u64 = 96 * 1024 * 1024;
const IMPORT_GRANT_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 256 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub enum BlobError {
    Io(String),
    /// The bytes do not hash to what was asked for. Discarded, never stored.
    Mismatch,
    NotFound,
}

impl std::fmt::Display for BlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(what) => write!(f, "media store: {what}"),
            Self::Mismatch => write!(f, "the received file does not match its hash"),
            Self::NotFound => write!(f, "this media is not on this machine"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub hash: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredManifest {
    #[serde(flatten)]
    manifest: Manifest,
    created_at: u64,
}

fn store_dir() -> PathBuf {
    super::identity::collab_dir().join("blobs")
}

fn pins_dir() -> PathBuf {
    super::identity::collab_dir().join("blob-pins")
}

static LAST_GC: Mutex<Option<SystemTime>> = Mutex::new(None);
static IMPORT_GRANTS: Mutex<Option<std::collections::HashMap<String, ImportGrant>>> =
    Mutex::new(None);

struct ImportGrant {
    path: PathBuf,
    project_id: Option<String>,
    expires_at: Instant,
}

fn canonical_regular_file(source: &Path) -> Result<PathBuf, BlobError> {
    // The path is part of the error. "file not found" without it cannot be told apart from a
    // locator the renderer never resolved, an asset swept from under a still-open board, or a
    // session cache another application purged.
    let source_meta = fs::symlink_metadata(source)
        .map_err(|err| BlobError::Io(format!("{err} — {}", source.display())))?;
    if source_meta.file_type().is_symlink() || !source_meta.is_file() {
        return Err(BlobError::Io("media source must be a regular file".into()));
    }
    let canonical = fs::canonicalize(source).map_err(|err| BlobError::Io(err.to_string()))?;
    if !fs::metadata(&canonical)
        .map_err(|err| BlobError::Io(err.to_string()))?
        .is_file()
    {
        return Err(BlobError::Io(
            "media source must resolve to a regular file".into(),
        ));
    }
    Ok(canonical)
}

fn issue_grant(path: PathBuf, project_id: Option<&str>) -> Result<String, BlobError> {
    let token =
        super::ids::OpaqueToken::generate().map_err(|err| BlobError::Io(err.to_string()))?;
    let value = token.as_str().to_owned();
    let mut guard = IMPORT_GRANTS
        .lock()
        .map_err(|_| BlobError::Io("media grant lock is poisoned".into()))?;
    let grants = guard.get_or_insert_with(std::collections::HashMap::new);
    let now = Instant::now();
    grants.retain(|_, grant| grant.expires_at > now);
    grants.insert(
        value.clone(),
        ImportGrant {
            path,
            project_id: project_id.map(str::to_owned),
            expires_at: now + IMPORT_GRANT_TTL,
        },
    );
    Ok(value)
}

/// Creates a short-lived grant only for a path returned by a native picker or trusted OS drop.
pub fn issue_trusted_grant(source: &str) -> Result<String, BlobError> {
    issue_grant(canonical_regular_file(Path::new(source))?, None)
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn collect_scene_refs(value: &serde_json::Value, output: &mut Vec<String>) {
    // A collaborative scene deliberately stores no items: the Loro document is authoritative and a
    // second writable copy would diverge. Its media locators are kept beside them so a shared board
    // can still authorise the import of a file it already holds.
    if let Some(media) = value.get("media").and_then(serde_json::Value::as_array) {
        output.extend(
            media
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned),
        );
    }
    let Some(items) = value.get("items").and_then(serde_json::Value::as_array) else {
        return;
    };
    for item in items {
        if let Some(reference) = item.get("ref").and_then(serde_json::Value::as_str) {
            output.push(reference.to_owned());
        }
        if let Some(frames) = item.get("frames").and_then(serde_json::Value::as_array) {
            output.extend(
                frames
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned),
            );
        }
        for field in ["prevMedia", "localMedia"] {
            if let Some(reference) = item
                .get(field)
                .and_then(|nested| nested.get("ref"))
                .and_then(serde_json::Value::as_str)
            {
                output.push(reference.to_owned());
            }
        }
    }
}

/// The document a project is bound to, as the core stored it, or `None` when this surface has no
/// reader. Adding one is what teaches `issue_known_grant` about a new module's own media.
fn subject_data(surface: &str, subject_id: &str) -> Result<Option<serde_json::Value>, BlobError> {
    match surface {
        "board" => scene_data(subject_id),
        "collection" => collection_data(subject_id),
        "notebook" | "notebook-page" => notebook_data(surface, subject_id),
        _ => Ok(None),
    }
}

fn collection_data(id: &str) -> Result<Option<serde_json::Value>, BlobError> {
    let dir = super::identity::board_data_dir().join("collections");
    let database = dir.join("collections.db");
    let data = if database.exists() {
        let connection = rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| BlobError::Io(e.to_string()))?;
        let row: Option<String> = connection.query_row("SELECT data FROM collections WHERE id = ?1", [id], |row| row.get(0)).optional().map_err(|e| BlobError::Io(e.to_string()))?;
        row.map(|v| serde_json::from_str::<serde_json::Value>(&v)).transpose().map_err(|e| BlobError::Io(e.to_string()))?
    } else {
        let path = dir.join("collections.json");
        if !path.exists() { return Ok(None); }
        let root: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| BlobError::Io(e.to_string()))?).map_err(|e| BlobError::Io(e.to_string()))?;
        root.get(id).and_then(|row| row.get("data")).and_then(|v| if let Some(text) = v.as_str() { serde_json::from_str(text).ok() } else { Some(v.clone()) })
    };
    // Collection originals never grant authority: only the prepared derivative list is eligible.
    Ok(data.map(|v| serde_json::json!({"media": v.get("collaboration").and_then(|c| c.get("preparedPaths")).cloned().unwrap_or(serde_json::json!([]))})))
}

fn notebook_data(surface: &str, id: &str) -> Result<Option<serde_json::Value>, BlobError> {
    let prepared = super::identity::board_data_dir().join("notebook").join("collaboration-media.json");
    if prepared.exists() {
        let cache: serde_json::Value = serde_json::from_slice(&fs::read(prepared).map_err(|e| BlobError::Io(e.to_string()))?).map_err(|e| BlobError::Io(e.to_string()))?;
        if let Some(media) = cache.get(format!("{surface}:{id}")) { return Ok(Some(serde_json::json!({ "media": media }))); }
    }
    fn collect(value: &serde_json::Value, refs: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => for (key, child) in map {
                if matches!(key.as_str(), "url" | "cover" | "src" | "ref") {
                    if let Some(text) = child.as_str() {
                        if let Ok(url) = reqwest::Url::parse(text) {
                            if url.host_str() == Some("localhost") || url.host_str() == Some("127.0.0.1") {
                                for (key, path) in url.query_pairs() { if key == "path" || key == "p" { refs.push(path.into_owned()); } }
                            }
                        } else { refs.push(text.to_owned()); }
                    }
                }
                collect(child, refs);
            },
            serde_json::Value::Array(list) => for child in list { collect(child, refs); },
            _ => (),
        }
    }
    let dir = super::identity::board_data_dir().join("notebook");
    let database = dir.join("notebook.db");
    let mut refs = Vec::new();
    if database.exists() {
        let connection = rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| BlobError::Io(e.to_string()))?;
        let sql = if surface == "notebook-page" { "SELECT cover, data FROM page WHERE id = ?1" } else { "SELECT cover, data FROM page WHERE notebook_id = ?1 AND deleted_at IS NULL" };
        let mut statement = connection.prepare(sql).map_err(|e| BlobError::Io(e.to_string()))?;
        let rows = statement.query_map([id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))).map_err(|e| BlobError::Io(e.to_string()))?;
        for row in rows {
            let (cover, data) = row.map_err(|e| BlobError::Io(e.to_string()))?;
            collect(&serde_json::json!({"cover": cover, "blocks": serde_json::from_str::<serde_json::Value>(&data).unwrap_or_default()}), &mut refs);
        }
    } else {
        let path = dir.join("notebook.json");
        if !path.exists() { return Ok(None); }
        let root: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| BlobError::Io(e.to_string()))?).map_err(|e| BlobError::Io(e.to_string()))?;
        if let Some(pages) = root.get("pages").and_then(|v| v.as_object()) {
            for (page_id, page) in pages {
                if (surface == "notebook-page" && page_id == id) || (surface == "notebook" && page.get("notebook_id").and_then(|v| v.as_str()) == Some(id)) {
                    collect(page, &mut refs);
                    if let Some(text) = page.get("data").and_then(|v| v.as_str()) { collect(&serde_json::from_str::<serde_json::Value>(text).unwrap_or_default(), &mut refs); }
                }
            }
        }
    }
    Ok(Some(serde_json::json!({"media": refs})))
}

fn scene_data(scene_id: &str) -> Result<Option<serde_json::Value>, BlobError> {
    if scene_id.is_empty() || scene_id.len() > 128 || scene_id.chars().any(char::is_control) {
        return Err(BlobError::Io("invalid scene id".into()));
    }
    let reference_dir = super::identity::board_data_dir().join("reference");
    let database = reference_dir.join("reference.db");
    if database.exists() {
        let connection = rusqlite::Connection::open_with_flags(
            database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|err| BlobError::Io(err.to_string()))?;
        let row: Option<String> = connection
            .query_row("SELECT data FROM scenes WHERE id = ?1", [scene_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|err| BlobError::Io(err.to_string()))?;
        return row
            .map(|data| serde_json::from_str(&data).map_err(|err| BlobError::Io(err.to_string())))
            .transpose();
    }
    let json_path = reference_dir.join("scenes.json");
    if !json_path.exists() {
        return Ok(None);
    }
    let root: serde_json::Value =
        serde_json::from_slice(&fs::read(json_path).map_err(|err| BlobError::Io(err.to_string()))?)
            .map_err(|err| BlobError::Io(err.to_string()))?;
    let Some(data) = root
        .get(scene_id)
        .and_then(|row| row.get("data"))
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(None);
    };
    serde_json::from_str(data)
        .map(Some)
        .map_err(|err| BlobError::Io(err.to_string()))
}

/// Re-authorises a file already named by the local document the project is bound to, or an
/// app-owned reference asset. Renderer input alone is insufficient: the canonical path must
/// already be present in trusted local application state.
///
/// The lookup is per SURFACE, because "which files does this document legitimately point at" is a
/// question only the module that owns the document can answer. A surface with no reader here
/// simply grants nothing: its documents still share their media through the two trusted origins
/// that need no lookup at all — the native picker and an OS drop — so a missing reader costs a
/// re-import, never a wrong authorisation.
pub fn issue_known_grant(
    project_id: &super::ids::ProjectId,
    surface: &str,
    subject_id: &str,
    source: &str,
) -> Result<String, BlobError> {
    let canonical = canonical_regular_file(Path::new(source))?;
    let owned_root =
        fs::canonicalize(super::identity::board_data_dir().join("reference").join("assets")).ok();
    let owned = surface == "board" && owned_root
        .as_ref()
        .is_some_and(|root| canonical.starts_with(root) && canonical.as_path() != root.as_path());
    let mut referenced = false;
    // Counted so a refusal can say WHICH of the three failures happened: the document was not
    // found, it holds no reference at all, or it holds references and none matches this file.
    let mut subject_found = false;
    let mut reference_count = 0usize;
    if let Some(document) = subject_data(surface, subject_id)? {
        subject_found = true;
        let mut references = Vec::new();
        collect_scene_refs(&document, &mut references);
        reference_count = references.len();
        referenced = references.iter().any(|reference| {
            canonical_regular_file(Path::new(reference))
                .map(|candidate| same_path(&canonical, &candidate))
                .unwrap_or(false)
        });
    }
    if !owned && !referenced {
        let name = canonical
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".into());
        return Err(BlobError::Io(format!(
            "media \"{name}\" is not authorised: {surface} {subject_id} {} with {reference_count} reference(s)",
            if subject_found { "was found" } else { "was NOT found" },
        )));
    }
    issue_grant(canonical, Some(project_id.as_str()))
}

pub fn consume_import_grant(
    project_id: &super::ids::ProjectId,
    token: &str,
) -> Result<PathBuf, BlobError> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(BlobError::Io("invalid media import grant".into()));
    }
    let mut guard = IMPORT_GRANTS
        .lock()
        .map_err(|_| BlobError::Io("media grant lock is poisoned".into()))?;
    let grants = guard.get_or_insert_with(std::collections::HashMap::new);
    let now = Instant::now();
    grants.retain(|_, grant| grant.expires_at > now);
    let grant = grants
        .get(token)
        .ok_or_else(|| BlobError::Io("media import grant is unknown or expired".into()))?;
    if grant
        .project_id
        .as_deref()
        .is_some_and(|allowed| allowed != project_id.as_str())
    {
        return Err(BlobError::Io(
            "media import grant belongs to another project".into(),
        ));
    }
    let path = grant.path.clone();
    grants.remove(token);
    Ok(path)
}

pub fn path_for(hash: &str) -> Result<PathBuf, BlobError> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(BlobError::Io("malformed hash".into()));
    }
    Ok(store_dir().join(hash))
}

fn metadata_path(hash: &str) -> Result<PathBuf, BlobError> {
    Ok(store_dir().join(format!("{hash}.meta.json")))
}

fn removed_path(hash: &str) -> Result<PathBuf, BlobError> {
    Ok(store_dir().join(format!("{hash}.removed")))
}

fn unreferenced_path(hash: &str) -> Result<PathBuf, BlobError> {
    Ok(store_dir().join(format!("{hash}.unreferenced")))
}

pub fn has(hash: &str) -> bool {
    path_for(hash).map(|path| path.exists()).unwrap_or(false)
}

/// Copies a local file into the store under its BLAKE3 hash and returns its manifest.
///
/// Content-addressed, so importing the same file twice costs one copy: the second `rename` simply
/// lands on the name that already holds identical bytes.
pub fn put(source: &str, mime: &str) -> Result<Manifest, BlobError> {
    let source_path = PathBuf::from(source);
    let source_meta =
        fs::symlink_metadata(&source_path).map_err(|err| BlobError::Io(err.to_string()))?;
    if source_meta.file_type().is_symlink() || !source_meta.is_file() {
        return Err(BlobError::Io("media source must be a regular file".into()));
    }
    if mime.is_empty() || mime.len() > 255 || !mime.contains('/') {
        return Err(BlobError::Io("invalid media MIME type".into()));
    }
    let maximum = if mime.starts_with("image/") {
        MAX_IMAGE_BYTES
    } else if mime.starts_with("video/") {
        MAX_VIDEO_BYTES
    } else {
        return Err(BlobError::Io("unsupported collaborative media type".into()));
    };
    if source_meta.len() > maximum {
        return Err(BlobError::Io("media source exceeds its type limit".into()));
    }
    fs::create_dir_all(store_dir()).map_err(|err| BlobError::Io(err.to_string()))?;
    let token =
        super::ids::OpaqueToken::generate().map_err(|err| BlobError::Io(err.to_string()))?;
    let temp = store_dir().join(format!("{}.import.part", token.as_str()));
    let mut input = fs::File::open(&source_path).map_err(|err| BlobError::Io(err.to_string()))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|err| BlobError::Io(err.to_string()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; TRANSFER_CHUNK];
    let mut size = 0u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|err| BlobError::Io(err.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|err| BlobError::Io(err.to_string()))?;
        size += read as u64;
    }
    output
        .sync_all()
        .map_err(|err| BlobError::Io(err.to_string()))?;
    drop(output);
    let hash = hasher.finalize().to_hex().to_string();
    let target = path_for(&hash)?;
    if !target.exists() {
        fs::rename(&temp, &target).map_err(|err| BlobError::Io(err.to_string()))?;
    } else {
        fs::remove_file(&temp).map_err(|err| BlobError::Io(err.to_string()))?;
    }
    let name = source_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let manifest = Manifest {
        hash,
        name,
        mime: mime.to_string(),
        size,
    };
    store_manifest(&manifest)?;
    Ok(manifest)
}

pub fn store_manifest(manifest: &Manifest) -> Result<(), BlobError> {
    let _ = fs::remove_file(removed_path(&manifest.hash)?);
    let _ = fs::remove_file(unreferenced_path(&manifest.hash)?);
    let target = metadata_path(&manifest.hash)?;
    fs::create_dir_all(store_dir()).map_err(|err| BlobError::Io(err.to_string()))?;
    let token =
        super::ids::OpaqueToken::generate().map_err(|err| BlobError::Io(err.to_string()))?;
    let temp = store_dir().join(format!("{}.meta.part", token.as_str()));
    let stored = StoredManifest {
        manifest: manifest.clone(),
        created_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    let bytes = serde_json::to_vec(&stored).map_err(|err| BlobError::Io(err.to_string()))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|err| BlobError::Io(err.to_string()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|err| BlobError::Io(err.to_string()))?;
    drop(file);
    super::ids::atomic_replace(&temp, &target).map_err(|err| BlobError::Io(err.to_string()))
}

pub fn manifest(hash: &str) -> Result<Manifest, BlobError> {
    let bytes = fs::read(metadata_path(hash)?).map_err(|_| BlobError::NotFound)?;
    let stored: StoredManifest =
        serde_json::from_slice(&bytes).map_err(|err| BlobError::Io(err.to_string()))?;
    if stored.manifest.hash != hash {
        return Err(BlobError::Mismatch);
    }
    Ok(stored.manifest)
}

pub fn was_collected(hash: &str) -> bool {
    removed_path(hash)
        .map(|path| path.exists())
        .unwrap_or(false)
}

/// Reads a slice for a peer's request, or for the renderer protocol.
///
/// `read_to_end` on a bounded view, NOT a single `read`: `Read::read` is allowed to return fewer
/// bytes than the buffer holds, and it always does past a certain size. Capping the buffer at
/// `PROTOCOL_CHUNK` on top of that made an answer announce a `Content-Length` it then failed to
/// deliver — a truncated body under a full-size header, which a webview drops as a network error
/// rather than rendering. The cap belongs to the RANGE decision (`default_range`), not here.
pub fn read_at(hash: &str, offset: u64, len: usize) -> Result<Vec<u8>, BlobError> {
    if len as u64 > MAX_INLINE_RESPONSE {
        return Err(BlobError::Io("requested slice is too large".into()));
    }
    let path = path_for(hash)?;
    let mut file = fs::File::open(&path).map_err(|_| BlobError::NotFound)?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| BlobError::Io(err.to_string()))?;
    let mut buffer = Vec::with_capacity(len);
    std::io::Read::take(&mut file, len as u64)
        .read_to_end(&mut buffer)
        .map_err(|err| BlobError::Io(err.to_string()))?;
    Ok(buffer)
}

pub fn size_of(hash: &str) -> Result<u64, BlobError> {
    let path = path_for(hash)?;
    fs::metadata(&path)
        .map(|meta| meta.len())
        .map_err(|_| BlobError::NotFound)
}

fn protocol_error(
    status: tauri::http::StatusCode,
    message: &str,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )
        .body(message.as_bytes().to_vec())
        .expect("static protocol response")
}

fn renderer_origin(value: Option<&tauri::http::HeaderValue>) -> Result<Option<String>, ()> {
    let Some(origin) = value else {
        return Ok(None);
    };
    let origin = origin.to_str().map_err(|_| ())?;
    matches!(
        origin,
        "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
            | "http://127.0.0.1:1420"
    )
    .then(|| Some(origin.to_owned()))
    .ok_or(())
}

fn requested_range(value: Option<&tauri::http::HeaderValue>, total: u64) -> Option<(u64, u64)> {
    let value = value?.to_str().ok()?.strip_prefix("bytes=")?;
    if value.contains(',') || total == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(total).min(PROTOCOL_CHUNK);
        if suffix == 0 {
            return None;
        }
        return Some((total - suffix, total - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= total {
        return None;
    }
    let requested_end = if end.is_empty() {
        (start + PROTOCOL_CHUNK - 1).min(total - 1)
    } else {
        end.parse::<u64>().ok()?.min(total - 1)
    };
    let end = requested_end.min(start.saturating_add(PROTOCOL_CHUNK - 1));
    (end >= start).then_some((start, end))
}

/// Tranche servie quand le client n'a demandé AUCUNE plage.
///
/// Ne borner d'office n'a de sens que pour un lecteur qui sait réclamer la suite : un `<video>` le
/// fait, un `<img>` non — il émet une requête simple et prend le corps rendu pour le fichier entier.
/// Une image de plus de `PROTOCOL_CHUNK` arrivait donc tronquée, c'est-à-dire cassée ou figée sur
/// ses premières lignes, sans la moindre erreur.
fn default_range(mime: &str, total: u64) -> Option<(u64, u64)> {
    let streamable = mime.starts_with("video/") || mime.starts_with("audio/");
    // Un média temporel réclame la suite tout seul : on lui sert une première tranche. Une image,
    // non — elle prend le corps rendu pour le fichier entier — donc elle part entière tant qu'elle
    // tient dans la réponse. Au-delà, la borne revient : le processus d'interface ne construit pas
    // un tampon d'un gigaoctet, et une image de cette taille reste un cas pathologique.
    let cap = if streamable { PROTOCOL_CHUNK } else { MAX_INLINE_RESPONSE };
    (total > cap).then_some((0, cap.min(total) - 1))
}

/// Opaque media protocol. The URL contains only a project id and content hash; no filesystem path
/// ever crosses IPC. Project membership is enforced before iroh acquisition, and the protocol also
/// verifies that the currently open document references the requested hash.
pub fn protocol_response(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let origin = match renderer_origin(request.headers().get(tauri::http::header::ORIGIN)) {
        Ok(origin) => origin,
        Err(()) => {
            return protocol_error(
                tauri::http::StatusCode::FORBIDDEN,
                "renderer origin is not allowed",
            )
        }
    };
    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD
    {
        return protocol_error(
            tauri::http::StatusCode::METHOD_NOT_ALLOWED,
            "method not allowed",
        );
    }
    let segments: Vec<&str> = request.uri().path().trim_matches('/').split('/').collect();
    if segments.len() != 2 {
        return protocol_error(tauri::http::StatusCode::BAD_REQUEST, "malformed media URL");
    }
    let project_id = match super::ids::ProjectId::parse(segments[0]) {
        Ok(value) => value,
        Err(_) => {
            return protocol_error(tauri::http::StatusCode::BAD_REQUEST, "malformed project id")
        }
    };
    let hash = segments[1];
    let authorised = super::doc::open_media_hashes(project_id.as_str())
        .map(|hashes| hashes.is_some_and(|hashes| hashes.contains(hash)))
        .unwrap_or(false);
    if !authorised {
        return protocol_error(
            tauri::http::StatusCode::FORBIDDEN,
            "media is not part of this project",
        );
    }
    let info = match manifest(hash) {
        Ok(value) => value,
        Err(_) => {
            return protocol_error(tauri::http::StatusCode::NOT_FOUND, "media is unavailable")
        }
    };
    let total = match size_of(hash) {
        Ok(value) if value == info.size => value,
        _ => return protocol_error(tauri::http::StatusCode::NOT_FOUND, "media is incomplete"),
    };
    let explicit_range = request.headers().get(tauri::http::header::RANGE);
    // Sans en-tête `Range`, servir d'office une première tranche n'a de sens que pour un lecteur
    // qui sait RÉCLAMER LA SUITE : un `<video>` le fait, un `<img>` non — il émet une requête
    // simple et prend le corps qu'on lui donne pour le fichier entier. Une image de plus de 8 Mio
    // arrivait donc tronquée à 8 Mio, c'est-à-dire cassée ou figée sur ses premières lignes, sans
    // la moindre erreur. La borne ne s'applique plus qu'aux médias temporels.
    let range = requested_range(explicit_range, total)
        .or_else(|| default_range(&info.mime, total));
    let (start, end, status) = match range {
        Some((start, end)) => (start, end, tauri::http::StatusCode::PARTIAL_CONTENT),
        None => (0, total.saturating_sub(1), tauri::http::StatusCode::OK),
    };
    let body = if request.method() == tauri::http::Method::HEAD || total == 0 {
        Vec::new()
    } else {
        match read_at(hash, start, (end - start + 1) as usize) {
            Ok(value) => value,
            Err(_) => {
                return protocol_error(tauri::http::StatusCode::NOT_FOUND, "media is unavailable")
            }
        }
    };
    let content_length = if total == 0 { 0 } else { end - start + 1 };
    let mut response = tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, info.mime)
        .header(tauri::http::header::ACCEPT_RANGES, "bytes")
        .header(
            tauri::http::header::CONTENT_LENGTH,
            content_length.to_string(),
        );
    if let Some(origin) = origin {
        response = response.header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    if status == tauri::http::StatusCode::PARTIAL_CONTENT {
        response = response.header(
            tauri::http::header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    response.body(body).expect("validated protocol response")
}

/// Where an interrupted download left off, so the next attempt resumes rather than restarts.
pub fn partial_len(hash: &str) -> u64 {
    path_for(hash)
        .ok()
        .and_then(|path| fs::metadata(path.with_extension("part")).ok())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// Appends a downloaded chunk to the partial file.
pub fn append(hash: &str, chunk: &[u8], expected_size: u64) -> Result<u64, BlobError> {
    let path = path_for(hash)?.with_extension("part");
    fs::create_dir_all(store_dir()).map_err(|err| BlobError::Io(err.to_string()))?;
    let current = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if current > expected_size || chunk.len() as u64 > expected_size.saturating_sub(current) {
        let _ = fs::remove_file(&path);
        return Err(BlobError::Mismatch);
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| BlobError::Io(err.to_string()))?;
    file.write_all(chunk)
        .map_err(|err| BlobError::Io(err.to_string()))?;
    file.metadata()
        .map(|meta| meta.len())
        .map_err(|err| BlobError::Io(err.to_string()))
}

/// Verifies a completed download and moves it into the store.
///
/// The hash is the whole guarantee: a relay, a peer or a damaged disk cannot slip in other bytes,
/// because the file only takes its final name once it hashes to the name that was asked for.
pub fn finish(hash: &str, expected_size: u64) -> Result<(), BlobError> {
    let target = path_for(hash)?;
    let partial = target.with_extension("part");
    let mut file = fs::File::open(&partial).map_err(|err| BlobError::Io(err.to_string()))?;
    if file
        .metadata()
        .map_err(|err| BlobError::Io(err.to_string()))?
        .len()
        != expected_size
    {
        drop(file);
        let _ = fs::remove_file(&partial);
        return Err(BlobError::Mismatch);
    }
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; TRANSFER_CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| BlobError::Io(err.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    drop(file);
    if hasher.finalize().to_hex().to_string() != hash {
        let _ = fs::remove_file(&partial);
        return Err(BlobError::Mismatch);
    }
    fs::rename(&partial, &target).map_err(|err| BlobError::Io(err.to_string()))
}

pub fn record_project_pins(
    project_id: &super::ids::ProjectId,
    pinned: &std::collections::HashSet<String>,
) -> Result<(), BlobError> {
    let directory = pins_dir();
    fs::create_dir_all(&directory).map_err(|err| BlobError::Io(err.to_string()))?;
    let target = directory.join(format!("{}.json", project_id.storage_key()));
    let token =
        super::ids::OpaqueToken::generate().map_err(|err| BlobError::Io(err.to_string()))?;
    let temp = directory.join(format!("{}.part", token.as_str()));
    let mut values: Vec<&str> = pinned.iter().map(String::as_str).collect();
    values.sort_unstable();
    let bytes = serde_json::to_vec(&values).map_err(|err| BlobError::Io(err.to_string()))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|err| BlobError::Io(err.to_string()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|err| BlobError::Io(err.to_string()))?;
    drop(file);
    super::ids::atomic_replace(&temp, &target).map_err(|err| BlobError::Io(err.to_string()))
}

/// Drops a closed project's retention claim. The blob itself remains available for the grace
/// period, which starts on the next GC pass when no other local project references it.
pub fn forget_project_pins(project_id: &super::ids::ProjectId) -> Result<(), BlobError> {
    let path = pins_dir().join(format!("{}.json", project_id.storage_key()));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(BlobError::Io(error.to_string())),
    }
}

fn recorded_pins() -> Result<std::collections::HashSet<String>, BlobError> {
    let directory = pins_dir();
    let mut pinned = std::collections::HashSet::new();
    if !directory.exists() {
        return Ok(pinned);
    }
    for entry in fs::read_dir(directory).map_err(|err| BlobError::Io(err.to_string()))? {
        let entry = entry.map_err(|err| BlobError::Io(err.to_string()))?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|err| BlobError::Io(err.to_string()))?;
        let values: Vec<String> =
            serde_json::from_slice(&bytes).map_err(|err| BlobError::Io(err.to_string()))?;
        for hash in values {
            path_for(&hash)?;
            pinned.insert(hash);
        }
    }
    Ok(pinned)
}

/// Runs at most once per day. Every project's last recorded current-state pins participate, even
/// while that project is closed, so opening another board can never collect its media.
pub fn maybe_gc() -> Result<usize, BlobError> {
    let now = SystemTime::now();
    let mut last = LAST_GC
        .lock()
        .map_err(|_| BlobError::Io("media GC lock is poisoned".into()))?;
    if last
        .and_then(|value| now.duration_since(value).ok())
        .is_some_and(|elapsed| elapsed < Duration::from_secs(24 * 60 * 60))
    {
        return Ok(0);
    }
    let mut removed = cleanup_partials(&store_dir(), now)?;
    removed += cleanup_partials(&pins_dir(), now)?;
    removed += gc(&recorded_pins()?)?;
    *last = Some(now);
    Ok(removed)
}

fn cleanup_partials(directory: &PathBuf, now: SystemTime) -> Result<usize, BlobError> {
    if !directory.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(directory).map_err(|err| BlobError::Io(err.to_string()))? {
        let entry = entry.map_err(|err| BlobError::Io(err.to_string()))?;
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".part") {
            continue;
        }
        let idle = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or_default();
        if idle >= PART_TTL {
            fs::remove_file(entry.path()).map_err(|err| BlobError::Io(err.to_string()))?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Collects blobs no longer referenced by any recorded project, past the grace period.
fn collection_due(pinned: bool, unreferenced_at: Option<SystemTime>, now: SystemTime) -> bool {
    !pinned
        && unreferenced_at
            .and_then(|value| now.duration_since(value).ok())
            .is_some_and(|elapsed| elapsed >= GRACE)
}

fn gc(pinned: &std::collections::HashSet<String>) -> Result<usize, BlobError> {
    let dir = store_dir();
    if !dir.exists() {
        return Ok(0);
    }
    let now = SystemTime::now();
    let mut collected = 0;
    for entry in fs::read_dir(&dir).map_err(|err| BlobError::Io(err.to_string()))? {
        let entry = entry.map_err(|err| BlobError::Io(err.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".part")
            || name.ends_with(".meta.json")
            || name.ends_with(".removed")
            || name.ends_with(".unreferenced")
        {
            continue;
        }
        if path_for(&name).is_err() {
            continue;
        }
        let unreferenced = unreferenced_path(&name)?;
        if pinned.contains(name.as_str()) {
            let _ = fs::remove_file(unreferenced);
            continue;
        }
        if !unreferenced.exists() {
            let _ = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&unreferenced)
                .and_then(|file| file.sync_all());
            continue;
        }
        let unreferenced_at = fs::metadata(&unreferenced)
            .and_then(|meta| meta.modified())
            .ok();
        if collection_due(false, unreferenced_at, now) {
            fs::remove_file(entry.path()).map_err(|err| BlobError::Io(err.to_string()))?;
            let _ = fs::remove_file(metadata_path(&name)?);
            let _ = fs::remove_file(unreferenced);
            fs::write(removed_path(&name)?, b"collected")
                .map_err(|err| BlobError::Io(err.to_string()))?;
            collected += 1;
        }
    }
    Ok(collected)
}

#[cfg(test)]
mod path_tests {
    use super::{
        collection_due, consume_import_grant, issue_trusted_grant, path_for, renderer_origin,
        default_range, requested_range, GRACE, MAX_INLINE_RESPONSE, PROTOCOL_CHUNK,
    };
    use crate::collab::ids::{OpaqueToken, ProjectId};
    use std::fs;
    use std::time::{Duration, SystemTime};
    use tauri::http::HeaderValue;

    #[test]
    fn blob_path_accepts_only_canonical_lowercase_blake3() {
        assert!(path_for(&"a".repeat(64)).is_ok());
        assert!(path_for(&"A".repeat(64)).is_err());
        assert!(path_for("../escape").is_err());
    }

    #[test]
    fn range_parser_rejects_zero_suffix_and_bounds_large_ranges() {
        let zero = HeaderValue::from_static("bytes=-0");
        assert_eq!(requested_range(Some(&zero), 100), None);
        let suffix = HeaderValue::from_static("bytes=-10");
        assert_eq!(requested_range(Some(&suffix), 100), Some((90, 99)));
        let open = HeaderValue::from_static("bytes=2-");
        assert_eq!(
            requested_range(Some(&open), PROTOCOL_CHUNK * 2),
            Some((2, PROTOCOL_CHUNK + 1))
        );
    }

    #[test]
    fn an_image_larger_than_a_chunk_is_served_whole() {
        // Un `<img>` n'envoie pas de `Range` et ne sait pas en redemander : lui rendre une première
        // tranche revient à lui livrer un fichier tronqué, sans erreur. Seuls les médias temporels,
        // qui réclament la suite d'eux-mêmes, sont bornés d'office.
        let big = PROTOCOL_CHUNK * 3;
        assert_eq!(default_range("image/gif", big), None);
        assert_eq!(default_range("image/png", big), None);
        assert_eq!(default_range("application/pdf", big), None);
        // Passé le plafond de réponse, la borne revient même pour une image : le corps annoncé doit
        // rester un corps que ce processus sait construire.
        assert_eq!(
            default_range("image/png", MAX_INLINE_RESPONSE * 2),
            Some((0, MAX_INLINE_RESPONSE - 1))
        );
        assert_eq!(
            default_range("video/mp4", big),
            Some((0, PROTOCOL_CHUNK - 1))
        );
        // Sous la borne, personne n'est tronqué de toute façon.
        assert_eq!(default_range("video/mp4", 1024), None);
    }

    #[test]
    fn media_protocol_never_grants_cross_origin_cors() {
        let trusted = tauri::http::HeaderValue::from_static("http://tauri.localhost");
        let development = tauri::http::HeaderValue::from_static("http://localhost:1420");
        let attacker = tauri::http::HeaderValue::from_static("https://attacker.invalid");
        assert!(renderer_origin(Some(&trusted)).is_ok());
        assert!(renderer_origin(Some(&development)).is_ok());
        assert!(renderer_origin(Some(&attacker)).is_err());
    }

    #[test]
    fn import_grants_are_random_project_bound_and_one_use() {
        let root = std::env::temp_dir().join(format!(
            "netsurush-grant-{}",
            OpaqueToken::generate().expect("token").as_str()
        ));
        fs::create_dir(&root).expect("directory");
        let source = root.join("media.png");
        fs::write(&source, b"image").expect("fixture");
        let grant = issue_trusted_grant(&source.to_string_lossy()).expect("grant");
        let first = ProjectId::parse("project-one").expect("project");
        let second = ProjectId::parse("project-two").expect("project");
        // A trusted-selection grant is bound by its first successful import. A guessed token and a
        // replay both fail; a project-scoped grant uses the same consumer path.
        assert!(consume_import_grant(&first, &"0".repeat(64)).is_err());
        assert_eq!(
            consume_import_grant(&first, &grant).expect("consume"),
            fs::canonicalize(&source).expect("canonical")
        );
        assert!(consume_import_grant(&second, &grant).is_err());
        fs::remove_file(source).expect("remove fixture");
        fs::remove_dir(root).expect("remove fixture directory");
    }

    #[test]
    fn collection_grace_starts_when_the_last_pin_disappears() {
        let now = SystemTime::UNIX_EPOCH + GRACE + Duration::from_secs(60);
        assert!(!collection_due(true, Some(SystemTime::UNIX_EPOCH), now));
        assert!(!collection_due(false, None, now));
        assert!(!collection_due(
            false,
            Some(now - GRACE + Duration::from_secs(1)),
            now
        ));
        assert!(collection_due(false, Some(now - GRACE), now));
    }
}
