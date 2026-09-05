//! Peer-to-peer transport (`docs/collab.md`, implementation order steps 3–4).
//!
//! One iroh endpoint per running application, built from the SAME persisted Ed25519 secret as the
//! device identity. The EndpointId a peer allowlists therefore never changes.
//!
//! **Authorisation lives in the EndpointId and current project key, not in a bearer token.** iroh
//! verifies the remote public key during the QUIC handshake, and every Loro delta is additionally
//! sealed for the current project epoch before it enters QUIC.
//! Every accepted connection is checked against a local allowlist and closed before a single byte of
//! payload is exchanged when the peer is not on it. The allowlist is filled from the devices
//! registered in Convex, but it is kept here: an unreachable backend must never open the door, and
//! must never shut a peer out that was already authorised. It starts CLOSED.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use tokio::sync::OnceCell;

use super::identity;

/// Document synchronisation. The ALPN is versioned so incompatible peers are rejected by QUIC.
const ALPN_SYNC: &[u8] = b"netsurush/sync/1";

/// Ceiling on one synchronisation frame. A Loro delta for a moodboard is small; anything past this
/// is refused rather than buffered, so a peer cannot exhaust this machine's memory.
const MAX_FRAME: usize = 32 * 1024 * 1024;
const MAX_UPDATE: usize = 23 * 1024 * 1024;
const MAX_VERSION_VECTOR: usize = 4 * 1024 * 1024;

/// A dead relay or malicious peer cannot hold an actor operation forever. Blob transfers consist
/// of many bounded requests, so each chunk gets this deadline independently.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

static ENDPOINT: OnceCell<Endpoint> = OnceCell::const_new();
static ALLOWED: Mutex<Option<HashSet<EndpointId>>> = Mutex::new(None);
/// Per project: which peers may sync it, and which of them may WRITE.
///
/// Being reachable is not being a member. A friend outside a project must not be able to pull its
/// document, and a reader must not be able to push into it — the role is cached here because a
/// peer connection has to be judged without a round trip to Convex.
static PROJECT_PEERS: Mutex<Option<HashMap<String, HashMap<EndpointId, bool>>>> = Mutex::new(None);
type InboundFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type InboundHandler = Arc<dyn Fn(String, String, Vec<u8>) -> InboundFuture + Send + Sync>;
static INBOUND_HANDLER: OnceLock<InboundHandler> = OnceLock::new();

pub fn set_inbound_handler(handler: InboundHandler) {
    let _ = INBOUND_HANDLER.set(handler);
}

async fn accept_inbound(project_id: &str, peer: EndpointId, update: Vec<u8>) -> Result<(), String> {
    let handler = INBOUND_HANDLER
        .get()
        .ok_or_else(|| "collaboration authority is unavailable".to_string())?;
    handler(project_id.to_owned(), peer.to_string(), update).await
}

#[derive(serde::Serialize)]
pub struct SyncResult {
    pub received: usize,
    pub sent: usize,
    pub relayed: bool,
}

// Ces quatre verrous se REPRENNENT après une panique au lieu de dégrader en silence : sinon une
// seule panique sous l'un d'eux refusait ensuite tous les pairs, tous les rôles et toute mise à
// jour d'allowlist — la collaboration morte pour la session, sans un message.
fn is_allowed(peer: &EndpointId) -> bool {
    ALLOWED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .is_some_and(|set| set.contains(peer))
}

/// Replaces the allowlist with the devices of the accounts this user actually collaborates with.
///
/// A full replacement, not a merge: revoking someone must take effect, and a merge would keep every
/// EndpointId ever seen. Unparsable entries are skipped rather than failing the whole update — one
/// malformed row from the backend must not leave the door wide open.
pub fn set_allowlist(ids: &[String]) -> usize {
    let mut set = HashSet::new();
    for id in ids {
        if let Ok(parsed) = id.parse::<EndpointId>() {
            set.insert(parsed);
        }
    }
    let count = set.len();
    *ALLOWED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(set);
    count
}

/// Replaces every open project's peer roster in one operation.
///
/// Replacing the complete map is security-significant: removing the final project lease must remove
/// that project's authorization even when the same peer remains globally reachable for another
/// project. A per-project upsert would leave the closed project usable until process exit.
pub fn replace_project_peers(projects: &[(String, Vec<(String, bool)>)]) -> usize {
    let mut all = HashMap::new();
    let mut count = 0;
    for (project_id, peers) in projects {
        let mut project = HashMap::new();
        for (id, writable) in peers {
            if let Ok(parsed) = id.parse::<EndpointId>() {
                project.insert(parsed, *writable);
            }
        }
        count += project.len();
        all.insert(project_id.clone(), project);
    }
    *PROJECT_PEERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(all);
    count
}

/// `None` when the peer has no business with this project at all.
fn project_role(project_id: &str, peer: &EndpointId) -> Option<bool> {
    PROJECT_PEERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|projects| projects.get(project_id)?.get(peer).copied())
}

async fn write_frame(send: &mut iroh::endpoint::SendStream, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_FRAME {
        return Err("frame too large".into());
    }
    send.write_all(&(bytes.len() as u32).to_le_bytes())
        .await
        .map_err(|err| format!("send: {err}"))?;
    send.write_all(bytes)
        .await
        .map_err(|err| format!("send: {err}"))
}

async fn read_bounded_frame(
    recv: &mut iroh::endpoint::RecvStream,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut header = [0u8; 4];
    recv.read_exact(&mut header)
        .await
        .map_err(|err| format!("read: {err}"))?;
    let len = u32::from_le_bytes(header) as usize;
    if len > maximum.min(MAX_FRAME) {
        return Err("frame too large".into());
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        recv.read_exact(&mut body)
            .await
            .map_err(|err| format!("read: {err}"))?;
    }
    Ok(body)
}

async fn read_frame(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>, String> {
    read_bounded_frame(recv, MAX_FRAME).await
}

fn validate_update_size(payload: &[u8]) -> Result<(), String> {
    if payload.len() > MAX_UPDATE {
        return Err("document update is too large".into());
    }
    Ok(())
}

async fn write_update_frame(
    send: &mut iroh::endpoint::SendStream,
    project_id: &str,
    payload: &[u8],
) -> Result<(), String> {
    validate_update_size(payload)?;
    let sealed = super::crypto::seal(
        project_id,
        super::crypto::Purpose::DirectUpdate,
        0,
        0,
        payload,
    )
    .map_err(|error| error.to_string())?;
    let encrypted = serde_json::to_vec(&sealed)
        .map_err(|error| format!("encrypted document update: {error}"))?;
    write_frame(send, &encrypted).await
}

async fn read_update_frame(
    recv: &mut iroh::endpoint::RecvStream,
    project_id: &str,
    peer: &EndpointId,
) -> Result<Vec<u8>, String> {
    let encrypted = read_frame(recv).await?;
    let envelope: super::crypto::SealedEnvelope = serde_json::from_slice(&encrypted)
        .map_err(|_| "malformed encrypted document update".to_string())?;
    if envelope.header.project_id != project_id
        || envelope.header.device_id != peer.to_string()
        || envelope.header.purpose != super::crypto::Purpose::DirectUpdate
    {
        return Err("encrypted document update identity does not match the connection".into());
    }
    let update = super::crypto::open(
        &envelope.header,
        &envelope.ciphertext,
        &envelope.signature,
        &peer.to_string(),
    )
    .map_err(|error| error.to_string())?;
    validate_update_size(&update)?;
    Ok(update)
}

/// Answers one synchronisation request.
///
/// The exchange is symmetric and needs no server: the caller says which project and what it already
/// has, this side replies with the difference plus its own version, and the caller closes by sending
/// back what this side is missing. Both ends finish with the same document.
///
/// A caller without the writer role still RECEIVES: read-only bounds writing, never reading.
async fn serve_sync(
    connection: &iroh::endpoint::Connection,
    peer: EndpointId,
) -> Result<(), String> {
    let (mut send, mut recv) = connection
        .accept_bi()
        .await
        .map_err(|err| format!("stream: {err}"))?;
    let project_id = String::from_utf8(read_bounded_frame(&mut recv, 256).await?)
        .map_err(|_| "malformed project id".to_string())?;
    let Some(writable) = project_role(&project_id, &peer) else {
        return Err("peer is not a member of this project".into());
    };
    let their_vv = read_bounded_frame(&mut recv, MAX_VERSION_VECTOR).await?;

    let updates = super::doc::pull(&project_id, &their_vv).map_err(|err| err.to_string())?;
    let our_vv = super::doc::version(&project_id).map_err(|err| err.to_string())?;
    write_update_frame(&mut send, &project_id, &updates).await?;
    write_frame(&mut send, &our_vv).await?;

    let incoming = read_update_frame(&mut recv, &project_id, &peer).await?;
    if !incoming.is_empty() {
        if !writable {
            return Err("peer has no write role on this project".into());
        }
        accept_inbound(&project_id, peer, incoming).await?;
    }
    let _ = send.finish();
    Ok(())
}

/// Starts the endpoint once and keeps it for the lifetime of the process.
async fn endpoint() -> Result<&'static Endpoint, String> {
    ENDPOINT
        .get_or_try_init(|| async {
            let identity = identity::get_or_init().map_err(|err| err.to_string())?;
            let secret = SecretKey::from_bytes(&identity.signing_seed());
            let endpoint = Endpoint::builder(presets::N0)
                .secret_key(secret)
                .alpns(vec![ALPN_SYNC.to_vec(), super::blobs::ALPN_BLOB.to_vec()])
                .bind()
                .await
                .map_err(|err| format!("endpoint: {err}"))?;
            tauri::async_runtime::spawn(accept_loop(endpoint.clone()));
            Ok::<Endpoint, String>(endpoint)
        })
        .await
}

/// Accepts connections forever, refusing anyone outside the allowlist before reading any payload.
async fn accept_loop(endpoint: Endpoint) {
    while let Some(incoming) = endpoint.accept().await {
        tauri::async_runtime::spawn(async move {
            let Ok(connection) = incoming.await else {
                return;
            };
            let peer = connection.remote_id();
            if !is_allowed(&peer) {
                // Closed with an explicit code so the caller learns it is not authorised instead of
                // waiting on a timeout it cannot interpret.
                connection.close(1u32.into(), b"not allowed");
                return;
            }
            if connection.alpn() == super::blobs::ALPN_BLOB {
                // No whole-connection deadline here: a connection now serves MANY chunk requests,
                // and a 30 s ceiling would cut every large transfer off. serve_blob bounds each
                // request — and the idle wait between requests — with EXCHANGE_TIMEOUT itself.
                if let Err(reason) = serve_blob(&connection).await {
                    connection.close(3u32.into(), reason.as_bytes());
                }
                return;
            }
            if connection.alpn() == ALPN_SYNC {
                let served =
                    tokio::time::timeout(EXCHANGE_TIMEOUT, serve_sync(&connection, peer)).await;
                if let Err(reason) =
                    served.unwrap_or_else(|_| Err("document exchange timed out".into()))
                {
                    // Closed with the reason so the caller sees "not a member" instead of a silent
                    // hang it cannot tell apart from a network failure.
                    connection.close(2u32.into(), reason.as_bytes());
                }
                return;
            }
            connection.close(4u32.into(), b"unsupported collaboration protocol");
        });
    }
}

pub async fn start() -> Result<(), String> {
    endpoint().await.map(|_| ())
}

/// Synchronises one project with one peer, in both directions, in a single round trip.
///
/// Called after a local change and whenever a peer becomes reachable. Nothing here is a server:
/// each side pulls what it lacks, so two machines that were both offline converge on reconnection.
async fn sync_inner(project_id: &str, id: &str) -> Result<SyncResult, String> {
    let peer: EndpointId = id
        .parse()
        .map_err(|_| "malformed endpoint id".to_string())?;
    if !is_allowed(&peer) {
        return Err("peer is not in the allowlist".into());
    }
    if project_role(project_id, &peer).is_none() {
        return Err("peer is not a member of this project".into());
    }
    let endpoint = endpoint().await?;
    let connection = endpoint
        .connect(EndpointAddr::from(peer), ALPN_SYNC)
        .await
        .map_err(|err| format!("connect: {err}"))?;
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|err| format!("stream: {err}"))?;

    let our_vv = super::doc::version(project_id).map_err(|err| err.to_string())?;
    write_frame(&mut send, project_id.as_bytes()).await?;
    write_frame(&mut send, &our_vv).await?;

    let updates = read_update_frame(&mut recv, project_id, &peer).await?;
    let their_vv = read_bounded_frame(&mut recv, MAX_VERSION_VECTOR).await?;
    let received = updates.len();
    if !updates.is_empty() {
        accept_inbound(project_id, peer, updates).await?;
    }

    let ours = super::doc::pull(project_id, &their_vv).map_err(|err| err.to_string())?;
    let sent = ours.len();
    write_update_frame(&mut send, project_id, &ours).await?;
    let _ = send.finish();

    let relayed = !connection
        .paths()
        .iter()
        .any(|path| matches!(path.remote_addr(), iroh::TransportAddr::Ip(_)));
    connection.close(0u32.into(), b"done");
    Ok(SyncResult {
        received,
        sent,
        relayed,
    })
}

/// Last time a document exchange with a peer SUCCEEDED, by endpoint id.
///
/// This is presence as actually observed, not a heartbeat: the only honest thing this machine can
/// say about someone else is when it last reached them. Nothing is broadcast for it and no extra
/// traffic is created — the exchanges already happen.
static LAST_SEEN: Mutex<Option<std::collections::HashMap<String, Instant>>> = Mutex::new(None);

/// Milliseconds since the last successful exchange with each endpoint that has ever answered.
pub fn peer_last_seen() -> std::collections::HashMap<String, u64> {
    let now = Instant::now();
    LAST_SEEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|seen| {
            seen.iter()
                .map(|(id, at)| (id.clone(), now.duration_since(*at).as_millis() as u64))
                .collect()
        })
        .unwrap_or_default()
}

fn note_seen(id: &str) {
    let mut guard = LAST_SEEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(id.to_owned(), Instant::now());
}

pub async fn sync(project_id: &str, id: &str) -> Result<SyncResult, String> {
    let result = tokio::time::timeout(EXCHANGE_TIMEOUT, sync_inner(project_id, id))
        .await
        .map_err(|_| "document exchange timed out".to_string())?;
    if result.is_ok() {
        note_seen(id);
    }
    result
}

/// Serves media requests for the lifetime of one connection. Each request is one bi-stream with the
/// same frame layout as always — (project, hash, offset) in, (total, chunk hash, chunk) out — so a
/// peer that still opens one connection per chunk is served identically. A resuming downloader
/// keeps the connection and opens the next stream on it, paying one QUIC handshake per media
/// instead of one per chunk.
async fn serve_blob(connection: &iroh::endpoint::Connection) -> Result<(), String> {
    // The authorising hash set costs a full projection rebuild. It is cached for the connection
    // and recomputed only when a requested hash is missing from it, so a hash removed from the
    // document mid-transfer is refused after one recomputation, never served from a stale cache.
    let mut authorized: Option<(String, HashSet<String>)> = None;
    loop {
        let Ok(accepted) = tokio::time::timeout(EXCHANGE_TIMEOUT, connection.accept_bi()).await
        else {
            return Ok(()); // idle peer: nothing owed, drop the connection
        };
        let Ok((mut send, mut recv)) = accepted else {
            return Ok(()); // peer closed the connection: a finished transfer, not an error
        };
        let served = tokio::time::timeout(
            EXCHANGE_TIMEOUT,
            serve_blob_request(connection, &mut send, &mut recv, &mut authorized),
        )
        .await;
        served.unwrap_or_else(|_| Err("media exchange timed out".into()))?;
    }
}

/// One media slice, only when both the peer membership and the current project manifest authorise
/// it. A content hash learned in an unrelated project is not a cross-project capability.
async fn serve_blob_request(
    connection: &iroh::endpoint::Connection,
    send: &mut iroh::endpoint::SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    authorized: &mut Option<(String, HashSet<String>)>,
) -> Result<(), String> {
    let project_id = String::from_utf8(read_bounded_frame(recv, 256).await?)
        .map_err(|_| "malformed project id".to_string())?;
    if project_role(&project_id, &connection.remote_id()).is_none() {
        return Err("peer is not a member of this project".into());
    }
    let hash = String::from_utf8(read_bounded_frame(recv, 64).await?)
        .map_err(|_| "malformed hash".to_string())?;
    let cached = matches!(
        authorized,
        Some((project, hashes)) if *project == project_id && hashes.contains(&hash)
    );
    if !cached {
        let hashes = super::doc::media_hashes(&project_id).map_err(|err| err.to_string())?;
        let allowed = hashes.contains(&hash);
        *authorized = Some((project_id.clone(), hashes));
        if !allowed {
            return Err("media is not referenced by this project".into());
        }
    }
    let offset_bytes = read_bounded_frame(recv, 8).await?;
    let offset = u64::from_le_bytes(
        offset_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "malformed offset".to_string())?,
    );

    let total = super::blobs::size_of(&hash).map_err(|err| err.to_string())?;
    write_frame(send, &total.to_le_bytes()).await?;
    let chunk = super::blobs::read_at(&hash, offset, super::blobs::TRANSFER_CHUNK)
        .map_err(|err| err.to_string())?;
    write_frame(send, blake3::hash(&chunk).as_bytes()).await?;
    write_frame(send, &chunk).await?;
    let _ = send.finish();
    Ok(())
}

/// One chunk over an already-established connection: opens one bi-stream, asks for `offset`,
/// verifies the chunk against its own hash, appends it to the partial file, and returns how many
/// bytes this machine now holds.
async fn fetch_blob_chunk(
    connection: &iroh::endpoint::Connection,
    project_id: &str,
    hash: &str,
    offset: u64,
    expected_size: u64,
) -> Result<u64, String> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|err| format!("stream: {err}"))?;
    write_frame(&mut send, project_id.as_bytes()).await?;
    write_frame(&mut send, hash.as_bytes()).await?;
    write_frame(&mut send, &offset.to_le_bytes()).await?;
    let _ = send.finish();

    let total_bytes = read_bounded_frame(&mut recv, 8).await?;
    let total = u64::from_le_bytes(
        total_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "malformed size".to_string())?,
    );
    if total != expected_size {
        return Err("peer media size does not match its manifest".into());
    }
    let chunk_hash = read_bounded_frame(&mut recv, 32).await?;
    let chunk = read_frame(&mut recv).await?;
    if chunk.is_empty() {
        return Err("the peer sent nothing".into());
    }
    if chunk_hash.as_slice() != blake3::hash(&chunk).as_bytes() {
        return Err("peer media chunk hash does not verify".into());
    }
    super::blobs::append(hash, &chunk, expected_size).map_err(|err| err.to_string())
}

/// Downloads one media from a peer, resuming where an interrupted attempt stopped.
///
/// The transfer is verified against its hash before the file takes its final name, so a relay, a
/// peer or a damaged disk cannot substitute other bytes. Once received, this machine can serve it
/// in turn — every receiver becomes a provider.
///
/// One connection carries the whole media: chunks are requested over successive streams on it,
/// each under its own `EXCHANGE_TIMEOUT`, instead of paying a QUIC connect/handshake/close cycle
/// per chunk. A peer that still closes after one chunk (the previous protocol) just causes a
/// reconnect and the transfer continues.
pub async fn fetch_blob(
    project_id: &str,
    id: &str,
    hash: &str,
    expected_size: u64,
) -> Result<u64, String> {
    let peer: EndpointId = id
        .parse()
        .map_err(|_| "malformed endpoint id".to_string())?;
    if !is_allowed(&peer) {
        return Err("peer is not in the allowlist".into());
    }
    if super::blobs::has(hash) {
        let actual = super::blobs::size_of(hash).map_err(|err| err.to_string())?;
        return if actual == expected_size {
            Ok(actual)
        } else {
            Err("local media size does not match its manifest".into())
        };
    }
    if project_role(project_id, &peer).is_none() {
        return Err("peer is not a member of this project".into());
    }
    if !super::doc::media_hashes(project_id)
        .map_err(|err| err.to_string())?
        .contains(hash)
    {
        return Err("media is not referenced by this project".into());
    }
    let endpoint = endpoint().await?;
    let mut offset = super::blobs::partial_len(hash);
    if offset >= expected_size {
        match super::blobs::finish(hash, expected_size) {
            Ok(()) => return Ok(expected_size),
            Err(_) => offset = 0,
        }
    }
    let mut connection: Option<iroh::endpoint::Connection> = None;
    loop {
        let (conn, fresh) = match connection.take() {
            Some(conn) => (conn, false),
            None => {
                let conn = tokio::time::timeout(
                    EXCHANGE_TIMEOUT,
                    endpoint.connect(EndpointAddr::from(peer), super::blobs::ALPN_BLOB),
                )
                .await
                .map_err(|_| "media exchange timed out".to_string())?
                .map_err(|err| format!("connect: {err}"))?;
                (conn, true)
            }
        };
        let attempt = tokio::time::timeout(
            EXCHANGE_TIMEOUT,
            fetch_blob_chunk(&conn, project_id, hash, offset, expected_size),
        )
        .await
        .unwrap_or_else(|_| Err("media exchange timed out".into()));
        match attempt {
            Ok(have) => {
                if have >= expected_size {
                    conn.close(0u32.into(), b"done");
                    super::blobs::finish(hash, expected_size).map_err(|err| err.to_string())?;
                    return Ok(expected_size);
                }
                offset = have;
                connection = Some(conn);
            }
            Err(error) => {
                conn.close(0u32.into(), b"done");
                if fresh {
                    // A fresh connection that cannot deliver a single chunk is a real failure;
                    // retrying here would loop forever against a dead or refusing peer.
                    return Err(error);
                }
                // Reused connection refused the next stream — a peer on the one-chunk-per-
                // connection protocol, or a path change. Reconnect and resume from the partial.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{project_role, replace_project_peers, validate_update_size, MAX_UPDATE};
    use iroh::SecretKey;

    #[test]
    fn direct_updates_are_bounded_before_sealing() {
        assert!(validate_update_size(&vec![0; MAX_UPDATE]).is_ok());
        assert!(validate_update_size(&vec![0; MAX_UPDATE + 1]).is_err());
    }

    #[test]
    fn replacing_project_rosters_revokes_a_closed_project() {
        let peer = SecretKey::from_bytes(&[7u8; 32]).public();
        replace_project_peers(&[("project".to_string(), vec![(peer.to_string(), true)])]);
        assert_eq!(project_role("project", &peer), Some(true));
        replace_project_peers(&[]);
        assert_eq!(project_role("project", &peer), None);
    }
}
