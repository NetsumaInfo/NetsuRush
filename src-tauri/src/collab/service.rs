use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use super::convex::{AuthSession, ConvexClient};
use super::crypto::{self, Purpose};
use super::doc::{self, ApplyResult, ProjectProjection};
use super::error::{CollabError, CollabErrorCode};
use super::ids::ProjectId;
use super::ops::OperationBatch;
use super::store::{DurableEnvelope, ProjectStore};

const COMMAND_CAPACITY: usize = 64;
const ROSTER_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const MAX_PUBLISH_RETRY: Duration = Duration::from_secs(15 * 60);
const MEDIA_NOTICE_INTERVAL: Duration = Duration::from_secs(60 * 60);

fn registration_arguments<T: Serialize>(
    statement: &T,
    signature: &str,
    label: Option<&str>,
) -> serde_json::Value {
    let mut arguments = serde_json::json!({
        "statement": statement,
        "signature": signature,
    });
    if let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) {
        arguments
            .as_object_mut()
            .expect("registration arguments are an object")
            .insert("label".into(), serde_json::json!(label));
    }
    arguments
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectRole {
    Owner,
    Editor,
    Viewer,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAccess {
    role: ProjectRole,
    key_epoch: u32,
    rotation_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RosterDevice {
    user_id: String,
    device_id: String,
    signing_public: String,
    exchange_public: String,
    endpoint_id: String,
    can_write: bool,
    is_current_account: bool,
    #[serde(default)]
    has_current_envelope: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedRoster {
    access: ProjectAccess,
    devices: Vec<RosterDevice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyEnvelope {
    device_id: String,
    epoch: u32,
    envelope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePayload {
    head_id: Option<String>,
    revision: Option<u64>,
    epoch: Option<u64>,
    bytes: Option<u64>,
    device_id: Option<String>,
    author_device_id: Option<String>,
    header: crypto::Header,
    ciphertext: Option<String>,
    download_url: Option<String>,
    signature: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RecoveryState {
    checkpoint_epoch: u64,
    checkpoint_key_epoch: Option<u32>,
}

fn checkpoint_needs_rekey(checkpoint_key_epoch: Option<u32>, local_key_epoch: u32) -> bool {
    checkpoint_key_epoch.is_some_and(|epoch| epoch != local_key_epoch)
}

impl ProjectRole {
    fn can_write(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProject {
    pub project_id: String,
    /// Local document this project is bound to — a scene id, a collection id, a notebook id.
    pub subject_id: String,
    /// Module that owns it (`docs/collab.md`). Decides which local media the project may import.
    pub surface: String,
    pub role: ProjectRole,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSession {
    pub project_id: String,
    pub subject_id: String,
    pub surface: String,
    pub role: ProjectRole,
    pub key_epoch: u32,
    pub lease_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub role: ProjectRole,
    pub key_epoch: u32,
    pub rotation_required: bool,
    pub peer_candidates: usize,
    pub offline_queued: bool,
    /// Un membre par personne, sans le compte courant. La présence est ce que cette machine a
    /// OBSERVÉ — la dernière fois qu'elle a joint l'appareil — jamais une déclaration reçue.
    pub members: Vec<MemberPresence>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberPresence {
    pub user_id: String,
    pub devices: usize,
    /// Millisecondes depuis le dernier échange réussi avec l'un de ses appareils. Absent = jamais
    /// joint depuis le démarrage de l'application, ce qui n'est pas la même chose qu'absent.
    pub last_seen_ms: Option<u64>,
    pub can_write: bool,
    /// Faux tant qu'aucun appareil de cette personne n'a reçu la clé courante : elle est membre,
    /// mais ne peut encore rien lire.
    pub has_key: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseProject {
    pub project_id: String,
    pub lease_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InviteMembers {
    pub project_id: String,
    pub user_ids: Vec<String>,
    pub role: ProjectRole,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RespondInvite {
    pub invite_id: String,
    pub accept: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeMemberRole {
    pub project_id: String,
    pub user_id: String,
    pub role: ProjectRole,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveMember {
    pub project_id: String,
    pub user_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSources {
    pub peers: Vec<String>,
    pub collected_locally: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthConfiguration {
    pub deployment_url: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_label: Option<String>,
}

#[derive(Clone)]
pub struct CollabService {
    sender: mpsc::Sender<Command>,
    change_sink: Arc<OnceLock<ChangeSink>>,
}

type ChangeSink = Arc<dyn Fn(&str, u64) + Send + Sync>;

struct ActiveProject {
    subject_id: String,
    surface: String,
    role: ProjectRole,
    store: ProjectStore,
    publish_generation: u64,
    publish_failures: u8,
    first_unpublished: Option<Instant>,
    roster: CachedRoster,
    roster_checked_at: Instant,
    media_notices: HashMap<String, Instant>,
    leases: HashSet<String>,
    checkpoint_epoch: u64,
}

enum Command {
    ConfigureAuth {
        configuration: AuthConfiguration,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    Open {
        request: OpenProject,
        reply: oneshot::Sender<Result<ProjectSession, CollabError>>,
    },
    Close {
        request: CloseProject,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    Apply {
        project_id: String,
        batch: OperationBatch,
        reply: oneshot::Sender<Result<ApplyResult, CollabError>>,
    },
    Projection {
        project_id: String,
        reply: oneshot::Sender<Result<ProjectProjection, CollabError>>,
    },
    Status {
        project_id: String,
        reply: oneshot::Sender<Result<ProjectStatus, CollabError>>,
    },
    Undo {
        project_id: String,
        redo: bool,
        reply: oneshot::Sender<Result<ApplyResult, CollabError>>,
    },
    Publish {
        project_id: String,
        generation: u64,
    },
    InboundUpdate {
        project_id: String,
        peer_id: String,
        update: Vec<u8>,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    CreateProject {
        surface: String,
        reply: oneshot::Sender<Result<CreatedProject, CollabError>>,
    },
    AbortProject {
        project_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    InviteMembers {
        request: InviteMembers,
        reply: oneshot::Sender<Result<serde_json::Value, CollabError>>,
    },
    RespondInvite {
        request: RespondInvite,
        reply: oneshot::Sender<Result<serde_json::Value, CollabError>>,
    },
    CancelInvite {
        invite_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    ChangeMemberRole {
        request: ChangeMemberRole,
        reply: oneshot::Sender<Result<serde_json::Value, CollabError>>,
    },
    RemoveMember {
        request: RemoveMember,
        reply: oneshot::Sender<Result<serde_json::Value, CollabError>>,
    },
    LeaveProject {
        project_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    DeleteProject {
        project_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    DiscardStaleHead {
        head_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    ForgetDevice {
        device_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    FlushCheckpoint {
        project_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    AuthorizeMediaImport {
        project_id: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
    GrantKnownMedia {
        project_id: String,
        path: String,
        reply: oneshot::Sender<Result<String, CollabError>>,
    },
    MediaSources {
        project_id: String,
        hash: String,
        reply: oneshot::Sender<Result<MediaSources, CollabError>>,
    },
    RequestMedia {
        project_id: String,
        hash: String,
        reply: oneshot::Sender<Result<(), CollabError>>,
    },
}

impl CollabService {
    pub fn spawn() -> Self {
        Self::spawn_at(super::identity::collab_dir().join("project-store"))
    }

    fn spawn_at(storage_root: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let change_sink = Arc::new(OnceLock::new());
        tauri::async_runtime::spawn(run_actor(
            receiver,
            sender.clone(),
            storage_root,
            Arc::clone(&change_sink),
        ));
        let inbound_sender = sender.clone();
        super::net::set_inbound_handler(Arc::new(move |project_id, peer_id, update| {
            let sender = inbound_sender.clone();
            Box::pin(async move {
                let (reply, receive) = oneshot::channel();
                sender
                    .send(Command::InboundUpdate {
                        project_id,
                        peer_id,
                        update,
                        reply,
                    })
                    .await
                    .map_err(|_| "collaboration authority stopped".to_string())?;
                receive
                    .await
                    .map_err(|_| "collaboration authority stopped".to_string())?
                    .map_err(|error| error.to_string())
            })
        }));
        Self {
            sender,
            change_sink,
        }
    }

    pub fn attach_change_sink(&self, sink: impl Fn(&str, u64) + Send + Sync + 'static) {
        let _ = self.change_sink.set(Arc::new(sink));
    }

    pub async fn open(&self, request: OpenProject) -> Result<ProjectSession, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::Open { request, reply }, receive).await
    }

    pub async fn create_project(&self, surface: String) -> Result<CreatedProject, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::CreateProject { surface, reply }, receive)
            .await
    }

    pub async fn abort_project(&self, project_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::AbortProject { project_id, reply }, receive)
            .await
    }

    pub async fn invite_members(
        &self,
        request: InviteMembers,
    ) -> Result<serde_json::Value, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::InviteMembers { request, reply }, receive)
            .await
    }

    pub async fn respond_invite(
        &self,
        request: RespondInvite,
    ) -> Result<serde_json::Value, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::RespondInvite { request, reply }, receive)
            .await
    }

    pub async fn cancel_invite(&self, invite_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::CancelInvite { invite_id, reply }, receive)
            .await
    }

    pub async fn change_member_role(
        &self,
        request: ChangeMemberRole,
    ) -> Result<serde_json::Value, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::ChangeMemberRole { request, reply }, receive)
            .await
    }

    pub async fn remove_member(
        &self,
        request: RemoveMember,
    ) -> Result<serde_json::Value, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::RemoveMember { request, reply }, receive)
            .await
    }

    pub async fn leave_project(&self, project_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::LeaveProject { project_id, reply }, receive)
            .await
    }

    pub async fn delete_project(&self, project_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::DeleteProject { project_id, reply }, receive)
            .await
    }

    pub async fn discard_stale_head(&self, head_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::DiscardStaleHead { head_id, reply }, receive)
            .await
    }

    pub async fn forget_device(&self, device_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::ForgetDevice { device_id, reply }, receive)
            .await
    }

    pub async fn flush_checkpoint(&self, project_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::FlushCheckpoint { project_id, reply }, receive)
            .await
    }

    pub async fn authorize_media_import(&self, project_id: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::AuthorizeMediaImport { project_id, reply }, receive)
            .await
    }

    pub async fn grant_known_media(
        &self,
        project_id: String,
        path: String,
    ) -> Result<String, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(
            Command::GrantKnownMedia {
                project_id,
                path,
                reply,
            },
            receive,
        )
        .await
    }

    pub async fn media_sources(
        &self,
        project_id: String,
        hash: String,
    ) -> Result<MediaSources, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(
            Command::MediaSources {
                project_id,
                hash,
                reply,
            },
            receive,
        )
        .await
    }

    pub async fn request_media(&self, project_id: String, hash: String) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(
            Command::RequestMedia {
                project_id,
                hash,
                reply,
            },
            receive,
        )
        .await
    }

    pub async fn configure_auth(
        &self,
        configuration: AuthConfiguration,
    ) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(
            Command::ConfigureAuth {
                configuration,
                reply,
            },
            receive,
        )
        .await
    }

    pub async fn close(&self, request: CloseProject) -> Result<(), CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::Close { request, reply }, receive).await
    }

    pub async fn apply(
        &self,
        project_id: String,
        batch: OperationBatch,
    ) -> Result<ApplyResult, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(
            Command::Apply {
                project_id,
                batch,
                reply,
            },
            receive,
        )
        .await
    }

    pub async fn projection(&self, project_id: String) -> Result<ProjectProjection, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::Projection { project_id, reply }, receive)
            .await
    }

    pub async fn status(&self, project_id: String) -> Result<ProjectStatus, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::Status { project_id, reply }, receive)
            .await
    }

    pub async fn undo(&self, project_id: String, redo: bool) -> Result<ApplyResult, CollabError> {
        let (reply, receive) = oneshot::channel();
        self.send(
            Command::Undo {
                project_id,
                redo,
                reply,
            },
            receive,
        )
        .await
    }

    async fn send<T>(
        &self,
        command: Command,
        receive: oneshot::Receiver<Result<T, CollabError>>,
    ) -> Result<T, CollabError> {
        self.sender.send(command).await.map_err(|_| unavailable())?;
        receive.await.map_err(|_| unavailable())?
    }
}

/// Default surface of a project that names none — the module collaboration shipped with.
pub const DEFAULT_SURFACE: &str = "board";

/// A surface is a module label the service never interprets, only bounds. It travels to Convex in
/// clear and decides which local media a project may import (`blobs::issue_known_grant`), so it is
/// validated here rather than trusted from the renderer.
fn normalize_surface(value: &str) -> Result<String, CollabError> {
    let label = value.trim().to_ascii_lowercase();
    if label.is_empty() {
        return Ok(DEFAULT_SURFACE.to_owned());
    }
    let valid = label.len() <= 32
        && label.starts_with(|c: char| c.is_ascii_lowercase())
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(CollabError::validation("invalid collaboration surface"));
    }
    Ok(label)
}

/// Binding key. Two modules may legitimately give their documents the same local id, so the
/// surface is part of it — without that, opening a collection would claim a scene's binding.
fn subject_key(surface: &str, subject_id: &str) -> String {
    format!("{surface}\0{subject_id}")
}

fn unavailable() -> CollabError {
    CollabError::new(
        CollabErrorCode::Unavailable,
        "collaboration service is unavailable",
    )
}

fn checked_project<'a>(
    active: &'a HashMap<ProjectId, ActiveProject>,
    project_id: &str,
) -> Result<(&'a ProjectId, &'a ActiveProject), CollabError> {
    let parsed = ProjectId::parse(project_id)?;
    active
        .get_key_value(&parsed)
        .ok_or_else(|| CollabError::new(CollabErrorCode::Unavailable, "project is not open"))
}

/// Regroupe les appareils du roster PAR PERSONNE et y joint ce que cette machine a observé.
///
/// La présence d'une personne est celle du plus récemment joint de ses appareils : quelqu'un qui
/// travaille sur son portable est en ligne, même si sa tour est éteinte.
fn member_presence(roster: &CachedRoster) -> Vec<MemberPresence> {
    let seen = super::net::peer_last_seen();
    let mut by_user: std::collections::BTreeMap<String, MemberPresence> =
        std::collections::BTreeMap::new();
    for device in roster.devices.iter().filter(|d| !d.is_current_account) {
        let entry = by_user
            .entry(device.user_id.clone())
            .or_insert_with(|| MemberPresence {
                user_id: device.user_id.clone(),
                devices: 0,
                last_seen_ms: None,
                can_write: false,
                has_key: false,
            });
        entry.devices += 1;
        entry.can_write |= device.can_write;
        entry.has_key |= device.has_current_envelope;
        if let Some(age) = seen.get(&device.endpoint_id) {
            entry.last_seen_ms = Some(entry.last_seen_ms.map_or(*age, |best| best.min(*age)));
        }
    }
    by_user.into_values().collect()
}

fn doc_error(error: doc::DocError) -> CollabError {
    let code = match error {
        doc::DocError::Schema(_) | doc::DocError::Protocol(_) => CollabErrorCode::ReadOnly,
        doc::DocError::Rejected(_) => CollabErrorCode::Validation,
        doc::DocError::Io(_) | doc::DocError::Loro(_) => CollabErrorCode::Storage,
    };
    CollabError::new(code, error.to_string())
}

fn crypto_error(error: crypto::CryptoError) -> CollabError {
    let code = match error {
        crypto::CryptoError::UnknownEpoch(_) => CollabErrorCode::KeyPending,
        crypto::CryptoError::Io(_) => CollabErrorCode::Storage,
        crypto::CryptoError::Identity(_) | crypto::CryptoError::Sealed(_) => {
            CollabErrorCode::Corrupt
        }
    };
    CollabError::new(code, error.to_string())
}

fn schedule_publish(
    sender: mpsc::Sender<Command>,
    project_id: String,
    generation: u64,
    delay: Duration,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let _ = sender
            .send(Command::Publish {
                project_id,
                generation,
            })
            .await;
    });
}

fn publication_debounce(first_unpublished: &mut Option<Instant>, now: Instant) -> Duration {
    let first = *first_unpublished.get_or_insert(now);
    let idle = now + Duration::from_secs(3);
    let maximum = first + Duration::from_secs(30);
    idle.min(maximum).saturating_duration_since(now)
}

fn publish_retry_delay(failures: u8) -> Duration {
    let exponent = failures.saturating_sub(1).min(5) as u32;
    Duration::from_secs(30u64.saturating_mul(2u64.pow(exponent))).min(MAX_PUBLISH_RETRY)
}

fn read_cached_roster(store: &ProjectStore) -> Result<Option<CachedRoster>, CollabError> {
    let Some((body, signature)) = store.roster_cache()? else {
        return Ok(None);
    };
    let identity = super::identity::get_or_init()
        .map_err(|error| CollabError::new(CollabErrorCode::Corrupt, error.to_string()))?;
    if !identity.verify_self(&body, &signature) {
        return Err(CollabError::new(
            CollabErrorCode::Corrupt,
            "cached project roster signature is invalid",
        ));
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| CollabError::new(CollabErrorCode::Corrupt, error.to_string()))
}

// The one authorization failure that actually means the account lost the project. Every other
// authorization failure — an expired token, a mutation refused while a key rotation is in flight —
// is transient, and demoting the OWNER of a board to a read-only viewer on one of those made the
// board unusable until the app was restarted.
const NOT_A_MEMBER: &str = "this account is no longer a project member";

fn lost_membership(error: &CollabError) -> bool {
    error.code == CollabErrorCode::Authorization && error.message == NOT_A_MEMBER
}

async fn load_roster(
    client: Option<&ConvexClient>,
    project_id: &ProjectId,
    store: &mut ProjectStore,
    test_role: ProjectRole,
) -> Result<CachedRoster, CollabError> {
    // Kept so the caller learns WHY the roster is missing. One sentence for "no client", "the
    // network refused" and "never opened online" sent every failure to the same dead end.
    let mut network_failure: Option<String> = None;
    if let Some(client) = client {
        let roster = client
            .query::<_, Option<CachedRoster>>(
                "projects:getProjectRoster",
                serde_json::json!({ "projectId": project_id.as_str() }),
            )
            .await;
        match roster {
            Ok(Some(roster)) => {
                let body = serde_json::to_vec(&roster)
                    .map_err(|error| CollabError::storage(error.to_string()))?;
                let identity = super::identity::get_or_init().map_err(|error| {
                    CollabError::new(CollabErrorCode::Corrupt, error.to_string())
                })?;
                store.cache_roster(&body, &identity.sign(&body))?;
                return Ok(roster);
            }
            Ok(None) => {
                return Err(CollabError::new(
                    CollabErrorCode::Authorization,
                    NOT_A_MEMBER,
                ))
            }
            Err(error) if error.code != CollabErrorCode::Network => return Err(error),
            Err(error) => network_failure = Some(error.message),
        }
    }
    if let Some(roster) = read_cached_roster(store)? {
        return Ok(roster);
    }
    if cfg!(test) {
        return Ok(CachedRoster {
            access: ProjectAccess {
                role: test_role,
                key_epoch: 0,
                rotation_required: false,
            },
            devices: Vec::new(),
        });
    }
    Err(match network_failure {
        Some(cause) => CollabError::new(
            CollabErrorCode::Network,
            format!("the project could not be reached: {cause}"),
        ),
        None if client.is_none() => CollabError::new(
            CollabErrorCode::Unavailable,
            "this device is not connected to the account; sign in again",
        ),
        None => CollabError::new(
            CollabErrorCode::Unavailable,
            "project has never been opened online on this device",
        ),
    })
}

fn roster_allows_peer_write(roster: &CachedRoster, peer_id: &str) -> bool {
    roster
        .devices
        .iter()
        .any(|device| device.endpoint_id == peer_id && device.can_write)
}

fn has_remote_endpoint(endpoint_ids: &[String], own_endpoint: &str) -> bool {
    endpoint_ids
        .iter()
        .any(|endpoint_id| endpoint_id != own_endpoint)
}

fn rebuild_peer_authority(active: &HashMap<ProjectId, ActiveProject>) {
    let mut endpoint_ids: Vec<String> = active
        .values()
        .flat_map(|project| {
            project
                .roster
                .devices
                .iter()
                .map(|device| device.endpoint_id.clone())
        })
        .collect();
    endpoint_ids.sort();
    endpoint_ids.dedup();
    super::net::set_allowlist(&endpoint_ids);
    let project_peers: Vec<(String, Vec<(String, bool)>)> = active
        .iter()
        .map(|(project_id, project)| {
            (
                project_id.as_str().to_owned(),
                project
                    .roster
                    .devices
                    .iter()
                    .map(|device| (device.endpoint_id.clone(), device.can_write))
                    .collect(),
            )
        })
        .collect();
    super::net::replace_project_peers(&project_peers);
    // An invited member may connect before this device makes its next edit. Keep the authenticated
    // endpoint listening as soon as a refreshed roster contains another device; waiting for an
    // outbound sync here would turn otherwise-live updates into a five-minute Convex fallback.
    if let Ok(identity) = super::identity::get_or_init() {
        if has_remote_endpoint(&endpoint_ids, &identity.public().device_id) {
            tauri::async_runtime::spawn(async {
                if let Err(error) = super::net::start().await {
                    eprintln!("[collab] peer endpoint unavailable: {error}");
                }
            });
        }
    }
}

async fn install_key_envelopes(
    client: &ConvexClient,
    project_id: &ProjectId,
) -> Result<(), CollabError> {
    let identity = super::identity::get_or_init()
        .map_err(|error| CollabError::new(CollabErrorCode::Corrupt, error.to_string()))?;
    let envelopes: Vec<KeyEnvelope> = client
        .query(
            "heads:myKeyEnvelopes",
            serde_json::json!({ "projectId": project_id.as_str() }),
        )
        .await?;
    for envelope in envelopes {
        if envelope.device_id != identity.public().device_id {
            continue;
        }
        let bytes = BASE64
            .decode(envelope.envelope.as_bytes())
            .map_err(|_| CollabError::new(CollabErrorCode::Corrupt, "invalid key envelope"))?;
        crypto::install_epoch(project_id.as_str(), envelope.epoch, &bytes).map_err(crypto_error)?;
    }
    Ok(())
}

async fn distribute_current_key(
    client: &ConvexClient,
    project_id: &ProjectId,
    roster: &CachedRoster,
) -> Result<(), CollabError> {
    if !matches!(roster.access.role, ProjectRole::Owner | ProjectRole::Editor) {
        return Ok(());
    }
    let epoch = crypto::current_epoch(project_id.as_str()).map_err(crypto_error)?;
    if epoch == 0 {
        return Err(CollabError::new(
            CollabErrorCode::KeyPending,
            "this device has no project key to distribute",
        ));
    }
    for device in &roster.devices {
        let (wrapped_epoch, envelope) =
            crypto::wrap_for_device(project_id.as_str(), &device.exchange_public)
                .map_err(crypto_error)?;
        debug_assert_eq!(epoch, wrapped_epoch);
        let _: serde_json::Value = client
            .mutation(
                "heads:putKeyEnvelope",
                serde_json::json!({
                    "projectId": project_id.as_str(),
                    "deviceId": device.device_id,
                    "epoch": wrapped_epoch,
                    "envelope": envelope,
                }),
            )
            .await?;
    }
    Ok(())
}

async fn ensure_key_epoch(
    client: Option<&ConvexClient>,
    project_id: &ProjectId,
    roster: &CachedRoster,
) -> Result<(), CollabError> {
    if let Some(client) = client {
        install_key_envelopes(client, project_id).await?;
    }
    let local = crypto::current_epoch(project_id.as_str()).map_err(crypto_error)?;
    if roster.access.rotation_required && roster.access.role != ProjectRole::Owner {
        return Err(CollabError::new(
            CollabErrorCode::KeyPending,
            "project key rotation is waiting for an owner device",
        ));
    }
    if roster.access.role == ProjectRole::Owner
        && (roster.access.rotation_required || roster.access.key_epoch == 0)
    {
        let target = roster.access.key_epoch + 1;
        let epoch = if local < target {
            crypto::rotate(project_id.as_str()).map_err(crypto_error)?
        } else {
            local
        };
        if epoch != target {
            return Err(CollabError::new(
                CollabErrorCode::Conflict,
                "local key epoch is ahead of the server rotation",
            ));
        }
        let client = client.ok_or_else(|| {
            CollabError::new(
                CollabErrorCode::Network,
                "key rotation needs an online Convex connection",
            )
        })?;
        distribute_current_key(client, project_id, roster).await?;
        let result: serde_json::Value = client
            .mutation(
                "heads:commitKeyRotation",
                serde_json::json!({
                    "projectId": project_id.as_str(),
                    "expectedEpoch": roster.access.key_epoch,
                    "newEpoch": target,
                }),
            )
            .await?;
        if result.get("status").and_then(|value| value.as_str()) != Some("committed") {
            return Err(CollabError::new(
                CollabErrorCode::Conflict,
                "project key rotation could not be committed",
            ));
        }
    } else if local == 0 {
        return Err(CollabError::new(
            CollabErrorCode::KeyPending,
            "waiting for another member to provision this device",
        ));
    } else if roster
        .devices
        .iter()
        .any(|device| !device.has_current_envelope)
    {
        let client = client.ok_or_else(|| {
            CollabError::new(
                CollabErrorCode::Network,
                "provisioning a new project device needs an online Convex connection",
            )
        })?;
        distribute_current_key(client, project_id, roster).await?;
    }
    Ok(())
}

async fn ciphertext_for(
    client: &ConvexClient,
    payload: &RemotePayload,
) -> Result<String, CollabError> {
    match (&payload.ciphertext, &payload.download_url) {
        (Some(ciphertext), None) => Ok(ciphertext.clone()),
        (None, Some(url)) => Ok(BASE64.encode(client.download(url).await?)),
        _ => Err(CollabError::new(
            CollabErrorCode::Corrupt,
            "remote payload has no unique body",
        )),
    }
}

async fn open_remote_payload(
    client: &ConvexClient,
    project_id: &ProjectId,
    payload: &RemotePayload,
) -> Result<Vec<u8>, CollabError> {
    if payload.header.project_id != project_id.as_str() {
        return Err(CollabError::new(
            CollabErrorCode::Corrupt,
            "remote payload belongs to another project",
        ));
    }
    let author_id = payload
        .author_device_id
        .as_deref()
        .or(payload.device_id.as_deref())
        .ok_or_else(|| CollabError::new(CollabErrorCode::Corrupt, "payload has no author"))?;
    let expected_purpose = if payload.author_device_id.is_some() {
        Purpose::Checkpoint
    } else {
        Purpose::Head
    };
    if payload.header.purpose != expected_purpose || payload.header.device_id != author_id {
        return Err(CollabError::new(
            CollabErrorCode::Corrupt,
            "remote payload slot and signed author do not match",
        ));
    }
    // Device ids are their Ed25519 public keys. This intentionally still verifies an old, already
    // authorised head after its author has been removed from the current roster; otherwise a key
    // rotation could make the last surviving copy of that branch unrecoverable.
    let ciphertext = ciphertext_for(client, payload).await?;
    crypto::open(&payload.header, &ciphertext, &payload.signature, author_id).map_err(crypto_error)
}

async fn recover_from_convex(
    client: &ConvexClient,
    project_id: &ProjectId,
) -> Result<RecoveryState, CollabError> {
    let checkpoint: Option<RemotePayload> = client
        .query(
            "heads:getCheckpoint",
            serde_json::json!({ "projectId": project_id.as_str() }),
        )
        .await?;
    let heads: Vec<RemotePayload> = client
        .query(
            "heads:listHeads",
            serde_json::json!({ "projectId": project_id.as_str() }),
        )
        .await?;
    let checkpoint_epoch = checkpoint
        .as_ref()
        .and_then(|payload| payload.epoch)
        .unwrap_or(0);
    let checkpoint_key_epoch = checkpoint.as_ref().map(|payload| payload.header.key_epoch);
    let payloads = checkpoint.into_iter().chain(heads);
    for payload in payloads {
        let update = open_remote_payload(client, project_id, &payload).await?;
        doc::merge(project_id.as_str(), &update).map_err(doc_error)?;
    }
    Ok(RecoveryState {
        checkpoint_epoch,
        checkpoint_key_epoch,
    })
}

async fn publish_latest(
    client: &ConvexClient,
    project_id: &ProjectId,
    project: &mut ActiveProject,
) -> Result<(), CollabError> {
    let Some(envelope) = project.store.latest_pending()? else {
        return Ok(());
    };
    let header: crypto::Header = serde_json::from_slice(&envelope.header)
        .map_err(|error| CollabError::storage(error.to_string()))?;
    if header.project_id != project_id.as_str() || header.seq != envelope.sequence {
        return Err(CollabError::new(
            CollabErrorCode::Corrupt,
            "outbox header does not match its project and sequence",
        ));
    }
    let ciphertext = String::from_utf8(envelope.ciphertext.clone())
        .map_err(|_| CollabError::new(CollabErrorCode::Corrupt, "invalid outbox ciphertext"))?;
    let signature = String::from_utf8(envelope.signature.clone())
        .map_err(|_| CollabError::new(CollabErrorCode::Corrupt, "invalid outbox signature"))?;
    let cipher_bytes = BASE64
        .decode(ciphertext.as_bytes())
        .map_err(|_| CollabError::new(CollabErrorCode::Corrupt, "invalid outbox base64"))?;
    let cipher_size = cipher_bytes.len();
    let mut args = serde_json::json!({
        "projectId": project_id.as_str(),
        "deviceId": header.device_id,
        "seq": header.seq,
        "ciphertextHash": header.ciphertext_hash,
        "header": header,
        "signature": signature,
        "bytes": cipher_size,
    });
    let mut uploaded_storage = None;
    if ciphertext.len() <= 700 * 1024 {
        args.as_object_mut()
            .expect("JSON object")
            .insert("ciphertext".into(), ciphertext.into());
    } else {
        let upload_url: String = client
            .mutation(
                "heads:generatePayloadUploadUrl",
                serde_json::json!({ "projectId": project_id.as_str() }),
            )
            .await?;
        let storage_id = client.upload(&upload_url, cipher_bytes).await?;
        register_uploaded_storage(client, project_id, &storage_id, cipher_size).await?;
        args.as_object_mut()
            .expect("JSON object")
            .insert("storageId".into(), storage_id.clone().into());
        uploaded_storage = Some(storage_id);
    }
    let published: Result<serde_json::Value, CollabError> =
        client.mutation("heads:publishHead", args).await;
    let response = match published {
        Ok(response) => response,
        Err(error) => {
            if let Some(storage_id) = uploaded_storage.as_deref() {
                cleanup_uncommitted_storage(client, project_id, storage_id).await;
            }
            return Err(error);
        }
    };
    let status = response
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if status != "published" {
        if let Some(storage_id) = uploaded_storage.as_deref() {
            cleanup_uncommitted_storage(client, project_id, storage_id).await;
        }
    }
    if !matches!(status, "published" | "already") {
        return Err(CollabError::new(
            CollabErrorCode::Conflict,
            "the server already holds a newer branch for this device",
        ));
    }
    let published_version = doc::version(project_id.as_str()).map_err(doc_error)?;
    project
        .store
        .confirm_through(envelope.sequence, &published_version)?;
    Ok(())
}

async fn cleanup_uncommitted_storage(
    client: &ConvexClient,
    project_id: &ProjectId,
    storage_id: &str,
) {
    let _: Result<serde_json::Value, CollabError> = client
        .mutation(
            "heads:deleteUncommittedStorage",
            serde_json::json!({
                "projectId": project_id.as_str(),
                "storageId": storage_id,
            }),
        )
        .await;
}

async fn register_uploaded_storage(
    client: &ConvexClient,
    project_id: &ProjectId,
    storage_id: &str,
    bytes: usize,
) -> Result<(), CollabError> {
    let identity = super::identity::get_or_init()
        .map_err(|error| CollabError::new(CollabErrorCode::Corrupt, error.to_string()))?;
    let _: serde_json::Value = client
        .mutation(
            "heads:registerPayloadUpload",
            serde_json::json!({
                "projectId": project_id.as_str(),
                "deviceId": identity.public().device_id,
                "storageId": storage_id,
                "bytes": bytes,
            }),
        )
        .await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsumedHead {
    head_id: String,
    revision: u64,
}

/// Compacts only the checkpoint and heads selected from Convex. It never snapshots the live Loro
/// document, which may contain a concurrently received or still-unpublished branch.
async fn compact_remote_set(
    client: &ConvexClient,
    project_id: &ProjectId,
    project: &mut ActiveProject,
    force: bool,
) -> Result<bool, CollabError> {
    if !project.role.can_write() {
        return Ok(false);
    }
    let checkpoint: Option<RemotePayload> = client
        .query(
            "heads:getCheckpoint",
            serde_json::json!({ "projectId": project_id.as_str() }),
        )
        .await?;
    let heads: Vec<RemotePayload> = client
        .query(
            "heads:listHeads",
            serde_json::json!({ "projectId": project_id.as_str() }),
        )
        .await?;
    let total_head_bytes: u64 = heads.iter().map(|head| head.bytes.unwrap_or(0)).sum();
    let local_key_epoch = crypto::current_epoch(project_id.as_str()).map_err(crypto_error)?;
    let rekey_required = checkpoint_needs_rekey(
        checkpoint.as_ref().map(|payload| payload.header.key_epoch),
        local_key_epoch,
    );
    if !force && !rekey_required && heads.len() < 4 && total_head_bytes < 2 * 1024 * 1024 {
        return Ok(false);
    }
    if heads.is_empty() && checkpoint.is_some() && !rekey_required {
        return Ok(true);
    }

    let expected_epoch = checkpoint
        .as_ref()
        .and_then(|payload| payload.epoch)
        .unwrap_or(0);
    let mut selected = Vec::with_capacity(heads.len() + usize::from(checkpoint.is_some()));
    if let Some(payload) = checkpoint.as_ref() {
        selected.push(open_remote_payload(client, project_id, payload).await?);
    }
    let mut consumed = Vec::with_capacity(heads.len());
    for payload in &heads {
        let head_id = payload
            .head_id
            .clone()
            .ok_or_else(|| CollabError::new(CollabErrorCode::Corrupt, "remote head has no id"))?;
        let revision = payload.revision.ok_or_else(|| {
            CollabError::new(CollabErrorCode::Corrupt, "remote head has no revision")
        })?;
        selected.push(open_remote_payload(client, project_id, payload).await?);
        consumed.push(ConsumedHead { head_id, revision });
    }
    let (snapshot, checkpoint_version) = doc::compact_updates(&selected).map_err(doc_error)?;
    let sealed = crypto::seal(
        project_id.as_str(),
        Purpose::Checkpoint,
        expected_epoch + 1,
        expected_epoch,
        &snapshot,
    )
    .map_err(crypto_error)?;
    let identity = super::identity::get_or_init()
        .map_err(|error| CollabError::new(CollabErrorCode::Corrupt, error.to_string()))?;
    let cipher_bytes = BASE64
        .decode(sealed.ciphertext.as_bytes())
        .map_err(|_| CollabError::new(CollabErrorCode::Corrupt, "invalid checkpoint base64"))?;
    let cipher_size = cipher_bytes.len();
    let mut args = serde_json::json!({
        "projectId": project_id.as_str(),
        "expectedEpoch": expected_epoch,
        "header": sealed.header,
        "signature": sealed.signature,
        "authorDeviceId": identity.public().device_id,
        "consumed": consumed,
        "bytes": cipher_size,
    });
    let mut uploaded_storage = None;
    if sealed.ciphertext.len() <= 700 * 1024 {
        args.as_object_mut()
            .expect("JSON object")
            .insert("ciphertext".into(), sealed.ciphertext.into());
    } else {
        let upload_url: String = client
            .mutation(
                "heads:generatePayloadUploadUrl",
                serde_json::json!({ "projectId": project_id.as_str() }),
            )
            .await?;
        let storage_id = client.upload(&upload_url, cipher_bytes).await?;
        register_uploaded_storage(client, project_id, &storage_id, cipher_size).await?;
        args.as_object_mut()
            .expect("JSON object")
            .insert("storageId".into(), storage_id.clone().into());
        uploaded_storage = Some(storage_id);
    }
    let committed: Result<serde_json::Value, CollabError> =
        client.mutation("heads:commitCheckpoint", args).await;
    let response = match committed {
        Ok(response) => response,
        Err(error) => {
            if let Some(storage_id) = uploaded_storage.as_deref() {
                cleanup_uncommitted_storage(client, project_id, storage_id).await;
            }
            return Err(error);
        }
    };
    if response.get("status").and_then(|value| value.as_str()) != Some("committed") {
        if let Some(storage_id) = uploaded_storage.as_deref() {
            cleanup_uncommitted_storage(client, project_id, storage_id).await;
        }
        return Err(CollabError::new(
            CollabErrorCode::Conflict,
            "checkpoint changed while it was being compacted",
        ));
    }
    let new_epoch = response
        .get("epoch")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| CollabError::new(CollabErrorCode::Network, "checkpoint epoch is missing"))?;
    project
        .store
        .save_checkpoint(new_epoch, &checkpoint_version, &snapshot)?;
    project.store.set_publication_base(&checkpoint_version)?;
    project.checkpoint_epoch = new_epoch;
    Ok(true)
}

fn enqueue_current_state(
    project_id: &ProjectId,
    project: &mut ActiveProject,
) -> Result<bool, CollabError> {
    if !project.role.can_write() {
        return Ok(false);
    }
    let current_version = doc::version(project_id.as_str()).map_err(doc_error)?;
    let base_version = project.store.publication_base()?;
    if current_version == base_version {
        return Ok(false);
    }
    let delta = doc::pull(project_id.as_str(), &base_version).map_err(doc_error)?;
    let sequence = project.store.next_sequence()?;
    let sealed = crypto::seal(
        project_id.as_str(),
        Purpose::Head,
        sequence,
        project.checkpoint_epoch,
        &delta,
    )
    .map_err(crypto_error)?;
    let durable = DurableEnvelope {
        sequence,
        header: serde_json::to_vec(&sealed.header)
            .map_err(|error| CollabError::storage(error.to_string()))?,
        ciphertext: sealed.ciphertext.into_bytes(),
        signature: sealed.signature.into_bytes(),
        base_version,
    };
    project.store.commit_local(&delta, &durable)?;
    Ok(true)
}

/// Operations that can change which media hashes the document references. Everything else —
/// geometry, text, strokes, appearance, ordering — leaves the retained set exactly as it was.
fn batch_touches_media(ops: &[doc::Op]) -> bool {
    ops.iter().any(|op| {
        matches!(
            op,
            doc::Op::AddItem { .. }
                | doc::Op::DeleteItem { .. }
                | doc::Op::SetMediaManifest { .. }
                | doc::Op::SetLink { .. }
                | doc::Op::SetSequence { .. }
                | doc::Op::SurfaceSetMedia { .. }
                | doc::Op::SurfaceDeleteEntry { .. }
                | doc::Op::SurfaceRestoreEntry { .. }
        )
    })
}

fn validate_surface_operations(surface: &str, ops: &[doc::Op]) -> Result<(), CollabError> {
    use super::ops::SurfaceEntryKind;
    for op in ops {
        let allowed = match op {
            doc::Op::SurfaceRestoreEntry { .. } => matches!(surface, "notebook" | "notebook-page"),
            doc::Op::SurfaceSetEntry { kind, .. } => match surface {
                "collection" => matches!(kind, SurfaceEntryKind::Collection | SurfaceEntryKind::CollectionItem),
                "notebook" | "notebook-page" => matches!(kind, SurfaceEntryKind::Notebook | SurfaceEntryKind::Page | SurfaceEntryKind::Block | SurfaceEntryKind::Database),
                _ => false,
            },
            doc::Op::SurfaceDeleteEntry { .. } | doc::Op::SurfaceTextInsert { .. }
            | doc::Op::SurfaceTextDelete { .. } | doc::Op::SurfaceTextFormat { .. }
            | doc::Op::SurfaceSetMedia { .. } => matches!(surface, "collection" | "notebook" | "notebook-page"),
            _ => surface == "board",
        };
        if !allowed { return Err(CollabError::validation("operation does not belong to this surface")); }
    }
    Ok(())
}

fn refresh_media_retention(project_id: &ProjectId) -> Result<(), CollabError> {
    let hashes = doc::media_hashes(project_id.as_str()).map_err(doc_error)?;
    super::blobs::record_project_pins(project_id, &hashes)
        .map_err(|error| CollabError::storage(error.to_string()))?;
    super::blobs::maybe_gc().map_err(|error| CollabError::storage(error.to_string()))?;
    Ok(())
}

async fn reconcile_checkpoint_key(
    client: &ConvexClient,
    project_id: &ProjectId,
    project: &mut ActiveProject,
    recovery: RecoveryState,
) -> Result<(), CollabError> {
    let local_key_epoch = crypto::current_epoch(project_id.as_str()).map_err(crypto_error)?;
    if !checkpoint_needs_rekey(recovery.checkpoint_key_epoch, local_key_epoch)
        || !project.role.can_write()
    {
        return Ok(());
    }
    for _ in 0..3 {
        match compact_remote_set(client, project_id, project, true).await {
            Ok(true) => return Ok(()),
            Ok(false) => break,
            Err(error) if error.code == CollabErrorCode::Conflict => continue,
            Err(error) => return Err(error),
        }
    }
    Err(CollabError::new(
        CollabErrorCode::Conflict,
        "checkpoint could not be re-encrypted after key rotation",
    ))
}

async fn refresh_project_security(
    client: &ConvexClient,
    project_id: &ProjectId,
    project: &mut ActiveProject,
) -> Result<(), CollabError> {
    let roster = load_roster(Some(client), project_id, &mut project.store, project.role).await?;
    let rotation_will_advance = roster.access.role == ProjectRole::Owner
        && (roster.access.rotation_required || roster.access.key_epoch == 0);
    ensure_key_epoch(Some(client), project_id, &roster).await?;
    let roster = if rotation_will_advance {
        load_roster(
            Some(client),
            project_id,
            &mut project.store,
            roster.access.role,
        )
        .await?
    } else {
        roster
    };
    let recovery = recover_from_convex(client, project_id).await?;
    project.checkpoint_epoch = recovery.checkpoint_epoch;
    project.role = roster.access.role;
    project.roster = roster;
    project.roster_checked_at = Instant::now();
    reconcile_checkpoint_key(client, project_id, project, recovery).await?;
    Ok(())
}

async fn run_actor(
    mut receiver: mpsc::Receiver<Command>,
    actor_sender: mpsc::Sender<Command>,
    storage_root: PathBuf,
    change_sink: Arc<OnceLock<ChangeSink>>,
) {
    let mut active: HashMap<ProjectId, ActiveProject> = HashMap::new();
    // Keyed by surface AND document: two modules may legitimately use the same local id.
    let mut subjects: HashMap<String, ProjectId> = HashMap::new();
    let mut convex: Option<ConvexClient> = None;
    while let Some(command) = receiver.recv().await {
        match command {
            Command::ConfigureAuth {
                configuration,
                reply,
            } => {
                let result = async {
                    let session =
                        AuthSession::new(&configuration.deployment_url, configuration.token)?;
                    let client = ConvexClient::new(session)?;
                    let identity = super::identity::get_or_init().map_err(|error| {
                        CollabError::new(CollabErrorCode::Corrupt, error.to_string())
                    })?;
                    let registered: Option<serde_json::Value> = client
                        .query(
                            "devices:getCurrentRegistration",
                            serde_json::json!({ "deviceId": identity.public().device_id }),
                        )
                        .await?;
                    if registered.is_none() {
                        #[derive(Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Challenge {
                            challenge: String,
                            account_id: String,
                        }
                        let challenge: Challenge = client
                            .mutation("devices:beginRegistration", serde_json::json!({}))
                            .await?;
                        let proof = identity
                            .registration_proof(&challenge.challenge, &challenge.account_id)?;
                        let arguments = registration_arguments(
                            &proof.statement,
                            &proof.signature,
                            configuration.device_label.as_deref(),
                        );
                        let _: serde_json::Value =
                            client.mutation("devices:registerDevice", arguments).await?;
                    }
                    convex = Some(client);
                    let client = convex.as_ref().expect("client just installed");
                    for (project_id, project) in &mut active {
                        match refresh_project_security(client, project_id, project).await {
                            Ok(()) => {
                                if enqueue_current_state(project_id, project)? {
                                    project.first_unpublished.get_or_insert_with(Instant::now);
                                }
                            }
                            Err(error) if lost_membership(&error) => {
                                project.role = ProjectRole::Viewer;
                                project.roster.devices.clear();
                                project.roster.access.role = ProjectRole::Viewer;
                            }
                            Err(error) if error.code == CollabErrorCode::Authorization => {
                                eprintln!("[collab] security refresh refused, role kept: {error}");
                            }
                            Err(error) if error.code == CollabErrorCode::Network => {}
                            Err(error) => return Err(error),
                        }
                        if project.store.latest_pending()?.is_some() {
                            project.publish_generation += 1;
                            project.first_unpublished.get_or_insert_with(Instant::now);
                            schedule_publish(
                                actor_sender.clone(),
                                project_id.as_str().to_owned(),
                                project.publish_generation,
                                Duration::ZERO,
                            );
                        }
                    }
                    rebuild_peer_authority(&active);
                    Ok(())
                }
                .await;
                let _ = reply.send(result);
            }
            Command::Open { request, reply } => {
                let result = async {
                    let project_id = ProjectId::parse(request.project_id)?;
                    let surface = normalize_surface(&request.surface)?;
                    if request.subject_id.is_empty() || request.subject_id.len() > 128 {
                        return Err(CollabError::validation("invalid document id"));
                    }
                    let binding = subject_key(&surface, &request.subject_id);
                    if let Some(bound) = subjects.get(&binding) {
                        if bound != &project_id {
                            return Err(CollabError::new(
                                CollabErrorCode::Conflict,
                                "document is already bound to another collaborative project",
                            ));
                        }
                    }
                    if let Some(existing) = active.get(&project_id) {
                        if existing.subject_id != request.subject_id
                            || existing.surface != surface
                        {
                            return Err(CollabError::new(
                                CollabErrorCode::Conflict,
                                "project is already open on another document",
                            ));
                        }
                    }
                    if let Some(existing) = active.get_mut(&project_id) {
                        let lease_id = super::ids::OpaqueToken::generate()?.as_str().to_owned();
                        existing.leases.insert(lease_id.clone());
                        return Ok(ProjectSession {
                            project_id: project_id.as_str().to_owned(),
                            subject_id: existing.subject_id.clone(),
                            surface: existing.surface.clone(),
                            role: existing.role,
                            key_epoch: crypto::current_epoch(project_id.as_str())
                                .map_err(crypto_error)?,
                            lease_id,
                        });
                    }
                    let store_path =
                        storage_root.join(format!("{}.sqlite3", project_id.storage_key()));
                    let mut store = ProjectStore::open(&store_path)?;
                    if let Some(snapshot) = store.local_checkpoint()? {
                        doc::merge(project_id.as_str(), &snapshot).map_err(doc_error)?;
                    }
                    for update in store.local_updates()? {
                        doc::merge(project_id.as_str(), &update).map_err(doc_error)?;
                    }
                    // The snapshot cache write is throttled; the replay above may have left it
                    // pending. Persist it now so an idle project starts warm next time.
                    doc::flush(project_id.as_str()).map_err(doc_error)?;
                    let mut roster =
                        load_roster(convex.as_ref(), &project_id, &mut store, request.role).await?;
                    let rotation_will_advance = roster.access.role == ProjectRole::Owner
                        && (roster.access.rotation_required || roster.access.key_epoch == 0);
                    if convex.is_some() || !cfg!(test) {
                        ensure_key_epoch(convex.as_ref(), &project_id, &roster).await?;
                    }
                    if rotation_will_advance {
                        if let Some(client) = convex.as_ref() {
                            roster = load_roster(
                                Some(client),
                                &project_id,
                                &mut store,
                                roster.access.role,
                            )
                            .await?;
                        }
                    }
                    let recovery = if let Some(client) = convex.as_ref() {
                        Some(recover_from_convex(client, &project_id).await?)
                    } else {
                        None
                    };
                    let checkpoint_epoch = recovery
                        .map(|state| state.checkpoint_epoch)
                        .unwrap_or(store.checkpoint_generation()?);
                    let lease_id = super::ids::OpaqueToken::generate()?.as_str().to_owned();
                    let mut opened = ActiveProject {
                        subject_id: request.subject_id.clone(),
                        surface: surface.clone(),
                        role: roster.access.role,
                        store,
                        publish_generation: 0,
                        publish_failures: 0,
                        first_unpublished: None,
                        roster,
                        roster_checked_at: Instant::now(),
                        media_notices: HashMap::new(),
                        leases: HashSet::from([lease_id.clone()]),
                        checkpoint_epoch,
                    };
                    if let (Some(client), Some(recovery)) = (convex.as_ref(), recovery) {
                        reconcile_checkpoint_key(client, &project_id, &mut opened, recovery)
                            .await?;
                    }
                    let session = ProjectSession {
                        project_id: project_id.as_str().to_owned(),
                        subject_id: request.subject_id.clone(),
                        surface: surface.clone(),
                        role: opened.role,
                        key_epoch: crypto::current_epoch(project_id.as_str())
                            .map_err(crypto_error)?,
                        lease_id: lease_id.clone(),
                    };
                    subjects.insert(binding, project_id.clone());
                    active.insert(project_id.clone(), opened);
                    doc::activate(project_id.as_str()).map_err(doc_error)?;
                    rebuild_peer_authority(&active);
                    let identity = super::identity::get_or_init().map_err(|error| {
                        CollabError::new(CollabErrorCode::Corrupt, error.to_string())
                    })?;
                    let peers: Vec<String> = active
                        .get(&project_id)
                        .expect("project inserted")
                        .roster
                        .devices
                        .iter()
                        .filter(|device| device.endpoint_id != identity.public().device_id)
                        .map(|device| device.endpoint_id.clone())
                        .collect();
                    if !peers.is_empty() {
                        let _ = super::net::start().await;
                        let sync_project = project_id.as_str().to_owned();
                        tauri::async_runtime::spawn(async move {
                            for peer in peers {
                                let _ = super::net::sync(&sync_project, &peer).await;
                            }
                        });
                    }
                    let project = active.get_mut(&project_id).expect("project inserted");
                    // Unit tests deliberately run without Convex and without a project key. That
                    // harness exercises the actor/role boundary only; production must always make
                    // an opened writable document durable and publishable before returning.
                    if (convex.is_some() || !cfg!(test))
                        && enqueue_current_state(&project_id, project)?
                    {
                        project.publish_generation += 1;
                        project.first_unpublished = Some(Instant::now());
                        schedule_publish(
                            actor_sender.clone(),
                            project_id.as_str().to_owned(),
                            project.publish_generation,
                            Duration::from_secs(3),
                        );
                    }
                    if convex.is_some() || !cfg!(test) {
                        refresh_media_retention(&project_id)?;
                    }
                    Ok(session)
                }
                .await;
                let _ = reply.send(result);
            }
            Command::Close { request, reply } => {
                let result = (|| {
                    let parsed = ProjectId::parse(request.project_id)?;
                    let project = active.get_mut(&parsed).ok_or_else(|| {
                        CollabError::new(CollabErrorCode::Unavailable, "project is not open")
                    })?;
                    if !project.leases.remove(&request.lease_id) {
                        return Err(CollabError::new(
                            CollabErrorCode::Authorization,
                            "unknown project lease",
                        ));
                    }
                    if !project.leases.is_empty() {
                        return Ok(());
                    }
                    let closed = active.remove(&parsed).ok_or_else(|| {
                        CollabError::new(CollabErrorCode::Unavailable, "project is not open")
                    })?;
                    subjects.remove(&subject_key(&closed.surface, &closed.subject_id));
                    doc::close(parsed.as_str()).map_err(doc_error)?;
                    rebuild_peer_authority(&active);
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Command::Apply {
                project_id,
                batch,
                reply,
            } => {
                let result = (|| {
                    let parsed = ProjectId::parse(&project_id)?;
                    let project = active.get_mut(&parsed).ok_or_else(|| {
                        CollabError::new(CollabErrorCode::Unavailable, "project is not open")
                    })?;
                    if !project.role.can_write() {
                        return Err(CollabError::new(
                            CollabErrorCode::ReadOnly,
                            "viewer projects are read-only",
                        ));
                    }
                    batch.validate()?;
                    validate_surface_operations(&project.surface, &batch.ops)?;
                    let mut key_epoch =
                        crypto::current_epoch(parsed.as_str()).map_err(crypto_error)?;
                    if key_epoch == 0 {
                        if project.role != ProjectRole::Owner {
                            return Err(CollabError::new(
                                CollabErrorCode::KeyPending,
                                "this device has not received the project key",
                            ));
                        }
                        key_epoch = crypto::rotate(parsed.as_str()).map_err(crypto_error)?;
                    }
                    debug_assert!(key_epoch > 0);
                    let base_version = project.store.publication_base()?;
                    let (update, head_delta) =
                        doc::prepare_batch_at_revision(parsed.as_str(), batch.protocol, &batch.ops, &base_version, batch.base_revision)
                            .map_err(doc_error)?;
                    let sequence = project.store.next_sequence()?;
                    let sealed = crypto::seal(
                        parsed.as_str(),
                        Purpose::Head,
                        sequence,
                        project.checkpoint_epoch,
                        &head_delta,
                    )
                    .map_err(crypto_error)?;
                    let durable = DurableEnvelope {
                        sequence,
                        header: serde_json::to_vec(&sealed.header)
                            .map_err(|error| CollabError::storage(error.to_string()))?,
                        ciphertext: sealed.ciphertext.into_bytes(),
                        signature: sealed.signature.into_bytes(),
                        base_version,
                    };
                    project.store.commit_local(&update, &durable)?;
                    doc::commit_update(parsed.as_str(), &update, batch.ops.len()).map_err(doc_error)
                })();
                if result.is_ok() {
                    if let Ok(parsed) = ProjectId::parse(&project_id) {
                        if let Some(project) = active.get_mut(&parsed) {
                            // Rebuilding the projection to collect media hashes is O(document);
                            // a geometry/text/stroke batch cannot change the referenced set, so a
                            // drag no longer pays it on every 150 ms flush.
                            if batch_touches_media(&batch.ops) {
                                if let Err(error) = refresh_media_retention(&parsed) {
                                    eprintln!("[collab] media retention update failed: {error}");
                                }
                            }
                            let now = Instant::now();
                            let delay = publication_debounce(&mut project.first_unpublished, now);
                            project.publish_generation += 1;
                            schedule_publish(
                                actor_sender.clone(),
                                project_id.clone(),
                                project.publish_generation,
                                delay,
                            );
                            let peers: Vec<String> = project
                                .roster
                                .devices
                                .iter()
                                .filter(|device| !device.is_current_account)
                                .map(|device| device.endpoint_id.clone())
                                .collect();
                            // One task per peer: an unreachable peer burns its own 30 s timeout
                            // without holding the delta back from the peers that are online.
                            for peer in peers {
                                super::net::request_sync(project_id.clone(), peer);
                            }
                        }
                    }
                }
                let _ = reply.send(result);
            }
            Command::Projection { project_id, reply } => {
                let result = (|| {
                    let (parsed, _) = checked_project(&active, &project_id)?;
                    let mut projection = doc::projection(parsed.as_str()).map_err(doc_error)?;
                    projection.local_hashes = doc::projection_media_hashes(&projection)
                        .into_iter()
                        .filter(|hash| super::blobs::has(hash))
                        .collect();
                    Ok(projection)
                })();
                let _ = reply.send(result);
            }
            Command::Status { project_id, reply } => {
                let result = (|| {
                    let (_, project) = checked_project(&active, &project_id)?;
                    Ok(ProjectStatus {
                        role: project.role,
                        key_epoch: crypto::current_epoch(&project_id).map_err(crypto_error)?,
                        rotation_required: project.roster.access.rotation_required,
                        peer_candidates: project
                            .roster
                            .devices
                            .iter()
                            .filter(|device| !device.is_current_account)
                            .count(),
                        offline_queued: project.store.latest_pending()?.is_some(),
                        members: member_presence(&project.roster),
                    })
                })();
                let _ = reply.send(result);
            }
            Command::Undo {
                project_id,
                redo,
                reply,
            } => {
                let result = (|| {
                    let parsed = ProjectId::parse(&project_id)?;
                    let project = active.get_mut(&parsed).ok_or_else(|| {
                        CollabError::new(CollabErrorCode::Unavailable, "project is not open")
                    })?;
                    if !project.role.can_write() {
                        return Err(CollabError::new(
                            CollabErrorCode::ReadOnly,
                            "viewer projects are read-only",
                        ));
                    }
                    let applied = if redo {
                        doc::redo(parsed.as_str()).map_err(doc_error)
                    } else {
                        doc::undo(parsed.as_str()).map_err(doc_error)
                    }?;
                    if let Err(error) = refresh_media_retention(&parsed) {
                        eprintln!("[collab] media retention update failed: {error}");
                    }
                    if enqueue_current_state(&parsed, project)? {
                        let delay =
                            publication_debounce(&mut project.first_unpublished, Instant::now());
                        project.publish_generation += 1;
                        schedule_publish(
                            actor_sender.clone(),
                            project_id.clone(),
                            project.publish_generation,
                            delay,
                        );
                    }
                    Ok(applied)
                })();
                if result.is_ok() {
                    if let Ok(parsed) = ProjectId::parse(&project_id) {
                        if let Some(project) = active.get(&parsed) {
                            let peers: Vec<String> = project
                                .roster
                                .devices
                                .iter()
                                .filter(|device| !device.is_current_account)
                                .map(|device| device.endpoint_id.clone())
                                .collect();
                            let sync_project = project_id.clone();
                            tauri::async_runtime::spawn(async move {
                                for peer in peers {
                                    let _ = super::net::sync(&sync_project, &peer).await;
                                }
                            });
                        }
                    }
                }
                let _ = reply.send(result);
            }
            Command::Publish {
                project_id,
                generation,
            } => {
                let Ok(parsed) = ProjectId::parse(&project_id) else {
                    continue;
                };
                let Some(current_generation) = active
                    .get(&parsed)
                    .map(|project| project.publish_generation)
                else {
                    continue;
                };
                if generation != current_generation {
                    continue;
                }
                let result = async {
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Network,
                            "Convex authentication is unavailable",
                        )
                    })?;
                    let project = active.get_mut(&parsed).expect("checked above");
                    let roster =
                        load_roster(Some(client), &parsed, &mut project.store, project.role)
                            .await?;
                    let rotation_will_advance = roster.access.role == ProjectRole::Owner
                        && (roster.access.rotation_required || roster.access.key_epoch == 0);
                    ensure_key_epoch(Some(client), &parsed, &roster).await?;
                    // Only a committed rotation changes the server epoch. Normal publications keep
                    // the roster from the first query and avoid a duplicate Convex invocation.
                    let roster = if rotation_will_advance {
                        load_roster(
                            Some(client),
                            &parsed,
                            &mut project.store,
                            roster.access.role,
                        )
                        .await?
                    } else {
                        roster
                    };
                    project.role = roster.access.role;
                    project.roster = roster;
                    project.roster_checked_at = Instant::now();
                    publish_latest(client, &parsed, project).await?;
                    if let Err(error) = compact_remote_set(client, &parsed, project, false).await {
                        eprintln!("[collab] background checkpoint postponed: {error}");
                    }
                    Ok::<(), CollabError>(())
                };
                let result = result.await;
                let Some(project) = active.get_mut(&parsed) else {
                    continue;
                };
                if result.as_ref().err().is_some_and(lost_membership) {
                    project.role = ProjectRole::Viewer;
                    project.roster.access.role = ProjectRole::Viewer;
                    project.roster.devices.clear();
                }
                if result.is_ok() {
                    project.first_unpublished = None;
                    project.publish_failures = 0;
                } else if !matches!(
                    result.as_ref().err().map(|error| error.code),
                    Some(CollabErrorCode::Authorization | CollabErrorCode::ReadOnly)
                ) {
                    project.publish_failures = project.publish_failures.saturating_add(1);
                    schedule_publish(
                        actor_sender.clone(),
                        project_id.clone(),
                        generation,
                        publish_retry_delay(project.publish_failures),
                    );
                }
                rebuild_peer_authority(&active);
                if result.is_ok() {
                    if let Ok(projection) = doc::projection(parsed.as_str()) {
                        if let Some(sink) = change_sink.get() {
                            sink(&project_id, projection.revision);
                        }
                    }
                }
            }
            Command::InboundUpdate {
                project_id,
                peer_id,
                update,
                reply,
            } => {
                let result = async {
                    let parsed = ProjectId::parse(&project_id)?;
                    let project = active.get_mut(&parsed).ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "project is not open on this device",
                        )
                    })?;
                    // Cap authorisation reads during a live drawing session. Every durable publish
                    // still rechecks Convex; inbound P2P writes reuse the signed roster for at most
                    // thirty seconds, or longer only while Convex is unreachable.
                    let roster = if project.roster_checked_at.elapsed() < ROSTER_REFRESH_INTERVAL {
                        project.roster.clone()
                    } else {
                        let roster =
                            load_roster(convex.as_ref(), &parsed, &mut project.store, project.role)
                                .await?;
                        project.roster_checked_at = Instant::now();
                        roster
                    };
                    if !roster_allows_peer_write(&roster, &peer_id) {
                        return Err(CollabError::new(
                            CollabErrorCode::Authorization,
                            "peer is not authorised to write this project",
                        ));
                    }
                    project.role = roster.access.role;
                    project.roster = roster;
                    let applied = doc::merge(parsed.as_str(), &update).map_err(doc_error)?;
                    if applied.applied > 0 && enqueue_current_state(&parsed, project)? {
                        let delay =
                            publication_debounce(&mut project.first_unpublished, Instant::now());
                        project.publish_generation += 1;
                        schedule_publish(
                            actor_sender.clone(),
                            project_id.clone(),
                            project.publish_generation,
                            delay,
                        );
                    }
                    if applied.applied > 0 {
                        refresh_media_retention(&parsed)?;
                    }
                    Ok::<u64, CollabError>(applied.revision)
                }
                .await;
                rebuild_peer_authority(&active);
                if let Ok(revision) = result.as_ref() {
                    if let Some(sink) = change_sink.get() {
                        sink(&project_id, *revision);
                    }
                }
                let _ = reply.send(result.map(|_| ()));
            }
            Command::CreateProject { surface, reply } => {
                let result = async {
                    let surface = normalize_surface(&surface)?;
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Response {
                        project_id: String,
                    }
                    let response: Response = client
                        .mutation(
                            "projects:createProject",
                            serde_json::json!({ "surface": surface }),
                        )
                        .await?;
                    let project_id = ProjectId::parse(response.project_id)?;
                    let store_path =
                        storage_root.join(format!("{}.sqlite3", project_id.storage_key()));
                    let mut store = ProjectStore::open(&store_path)?;
                    let roster =
                        load_roster(Some(client), &project_id, &mut store, ProjectRole::Owner)
                            .await?;
                    ensure_key_epoch(Some(client), &project_id, &roster).await?;
                    Ok(CreatedProject {
                        project_id: project_id.as_str().to_owned(),
                    })
                }
                .await;
                let _ = reply.send(result);
            }
            Command::AbortProject { project_id, reply } => {
                let result = async {
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let project_id = ProjectId::parse(project_id)?;
                    let _: serde_json::Value = client
                        .mutation(
                            "projects:abortEmptyProject",
                            serde_json::json!({ "projectId": project_id.as_str() }),
                        )
                        .await?;
                    super::blobs::forget_project_pins(&project_id)
                        .map_err(|error| CollabError::storage(error.to_string()))?;
                    Ok(())
                }
                .await;
                let _ = reply.send(result);
            }
            Command::InviteMembers { request, reply } => {
                let result = async {
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let project_id = ProjectId::parse(request.project_id)?;
                    if request.user_ids.is_empty() || request.user_ids.len() > 14 {
                        return Err(CollabError::validation(
                            "invite needs between one and fourteen users",
                        ));
                    }
                    if request.role == ProjectRole::Owner {
                        return Err(CollabError::validation("the owner role cannot be invited"));
                    }
                    for user_id in &request.user_ids {
                        if user_id.is_empty() || user_id.len() > 256 {
                            return Err(CollabError::validation("invalid invitation account id"));
                        }
                    }
                    client
                        .mutation(
                            "projects:invite",
                            serde_json::json!({
                                "projectId": project_id.as_str(),
                                "userIds": request.user_ids,
                                "role": request.role,
                            }),
                        )
                        .await
                }
                .await;
                let _ = reply.send(result);
            }
            Command::RespondInvite { request, reply } => {
                let result = async {
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    if request.invite_id.is_empty() || request.invite_id.len() > 256 {
                        return Err(CollabError::validation("invalid invitation id"));
                    }
                    client
                        .mutation(
                            "projects:respondInvite",
                            serde_json::json!({
                                "inviteId": request.invite_id,
                                "accept": request.accept,
                            }),
                        )
                        .await
                }
                .await;
                let _ = reply.send(result);
            }
            Command::CancelInvite { invite_id, reply } => {
                let result = async {
                    if invite_id.is_empty() || invite_id.len() > 256 {
                        return Err(CollabError::validation("invalid invitation id"));
                    }
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let _: serde_json::Value = client
                        .mutation(
                            "projects:cancelInvite",
                            serde_json::json!({ "inviteId": invite_id }),
                        )
                        .await?;
                    Ok(())
                }
                .await;
                let _ = reply.send(result);
            }
            Command::ChangeMemberRole { request, reply } => {
                let result = async {
                    if request.role == ProjectRole::Owner {
                        return Err(CollabError::validation("ownership cannot be assigned"));
                    }
                    if request.user_id.is_empty() || request.user_id.len() > 256 {
                        return Err(CollabError::validation("invalid member account id"));
                    }
                    let project_id = ProjectId::parse(request.project_id)?;
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let response: serde_json::Value = client
                        .mutation(
                            "projects:setMemberRole",
                            serde_json::json!({
                                "projectId": project_id.as_str(),
                                "userId": request.user_id,
                                "role": request.role,
                            }),
                        )
                        .await?;
                    if let Some(project) = active.get_mut(&project_id) {
                        refresh_project_security(client, &project_id, project).await?;
                        if enqueue_current_state(&project_id, project)? {
                            project.publish_generation += 1;
                            project.first_unpublished.get_or_insert_with(Instant::now);
                            schedule_publish(
                                actor_sender.clone(),
                                project_id.as_str().to_owned(),
                                project.publish_generation,
                                Duration::ZERO,
                            );
                        }
                    }
                    Ok(response)
                }
                .await;
                rebuild_peer_authority(&active);
                let _ = reply.send(result);
            }
            Command::RemoveMember { request, reply } => {
                let result = async {
                    if request.user_id.is_empty() || request.user_id.len() > 256 {
                        return Err(CollabError::validation("invalid member account id"));
                    }
                    let project_id = ProjectId::parse(request.project_id)?;
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let response: serde_json::Value = client
                        .mutation(
                            "projects:removeMember",
                            serde_json::json!({
                                "projectId": project_id.as_str(),
                                "userId": request.user_id,
                            }),
                        )
                        .await?;
                    if let Some(project) = active.get_mut(&project_id) {
                        refresh_project_security(client, &project_id, project).await?;
                        if enqueue_current_state(&project_id, project)? {
                            project.publish_generation += 1;
                            project.first_unpublished.get_or_insert_with(Instant::now);
                            schedule_publish(
                                actor_sender.clone(),
                                project_id.as_str().to_owned(),
                                project.publish_generation,
                                Duration::ZERO,
                            );
                        }
                    }
                    Ok(response)
                }
                .await;
                rebuild_peer_authority(&active);
                let _ = reply.send(result);
            }
            Command::LeaveProject { project_id, reply } => {
                let result = async {
                    let project_id = ProjectId::parse(project_id)?;
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let _: serde_json::Value = client
                        .mutation(
                            "projects:leaveProject",
                            serde_json::json!({ "projectId": project_id.as_str() }),
                        )
                        .await?;
                    if let Some(closed) = active.remove(&project_id) {
                        subjects.remove(&subject_key(&closed.surface, &closed.subject_id));
                        doc::close(project_id.as_str()).map_err(doc_error)?;
                    }
                    super::blobs::forget_project_pins(&project_id)
                        .map_err(|error| CollabError::storage(error.to_string()))?;
                    Ok(())
                }
                .await;
                rebuild_peer_authority(&active);
                let _ = reply.send(result);
            }
            Command::DeleteProject { project_id, reply } => {
                let result = async {
                    let project_id = ProjectId::parse(project_id)?;
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let _: serde_json::Value = client
                        .mutation(
                            "projects:deleteProject",
                            serde_json::json!({ "projectId": project_id.as_str() }),
                        )
                        .await?;
                    if let Some(closed) = active.remove(&project_id) {
                        subjects.remove(&subject_key(&closed.surface, &closed.subject_id));
                        doc::close(project_id.as_str()).map_err(doc_error)?;
                    }
                    super::blobs::forget_project_pins(&project_id)
                        .map_err(|error| CollabError::storage(error.to_string()))?;
                    Ok(())
                }
                .await;
                rebuild_peer_authority(&active);
                let _ = reply.send(result);
            }
            Command::DiscardStaleHead { head_id, reply } => {
                let result = async {
                    if head_id.is_empty()
                        || head_id.len() > 256
                        || head_id.bytes().any(|byte| byte.is_ascii_control())
                    {
                        return Err(CollabError::validation("invalid recovery head id"));
                    }
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let _: serde_json::Value = client
                        .mutation(
                            "heads:discardStaleHead",
                            serde_json::json!({ "headId": head_id }),
                        )
                        .await?;
                    Ok(())
                }
                .await;
                let _ = reply.send(result);
            }
            Command::ForgetDevice { device_id, reply } => {
                let result = async {
                    if device_id.len() != 64
                        || !device_id
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    {
                        return Err(CollabError::validation("invalid device id"));
                    }
                    let identity = super::identity::get_or_init().map_err(|error| {
                        CollabError::new(CollabErrorCode::Corrupt, error.to_string())
                    })?;
                    if device_id == identity.public().device_id {
                        return Err(CollabError::validation(
                            "this running device cannot revoke itself",
                        ));
                    }
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let _: serde_json::Value = client
                        .mutation(
                            "devices:forgetDevice",
                            serde_json::json!({ "deviceId": device_id }),
                        )
                        .await?;
                    for (project_id, project) in &mut active {
                        if let Err(error) =
                            refresh_project_security(client, project_id, project).await
                        {
                            eprintln!("[collab] device revocation left rotation pending: {error}");
                        }
                    }
                    Ok(())
                }
                .await;
                rebuild_peer_authority(&active);
                let _ = reply.send(result);
            }
            Command::FlushCheckpoint { project_id, reply } => {
                let result = async {
                    let parsed = ProjectId::parse(project_id)?;
                    let client = convex.as_ref().ok_or_else(|| {
                        CollabError::new(
                            CollabErrorCode::Unavailable,
                            "collaboration authentication is unavailable",
                        )
                    })?;
                    let project = active.get_mut(&parsed).ok_or_else(|| {
                        CollabError::new(CollabErrorCode::Unavailable, "project is not open")
                    })?;
                    if !project.role.can_write() {
                        return Err(CollabError::new(
                            CollabErrorCode::ReadOnly,
                            "viewer projects are read-only",
                        ));
                    }
                    let roster =
                        load_roster(Some(client), &parsed, &mut project.store, project.role)
                            .await?;
                    let rotation_will_advance = roster.access.role == ProjectRole::Owner
                        && (roster.access.rotation_required || roster.access.key_epoch == 0);
                    ensure_key_epoch(Some(client), &parsed, &roster).await?;
                    let roster = if rotation_will_advance {
                        load_roster(
                            Some(client),
                            &parsed,
                            &mut project.store,
                            roster.access.role,
                        )
                        .await?
                    } else {
                        roster
                    };
                    project.role = roster.access.role;
                    project.roster = roster;
                    project.roster_checked_at = Instant::now();
                    if enqueue_current_state(&parsed, project)?
                        || project.store.latest_pending()?.is_some()
                    {
                        publish_latest(client, &parsed, project).await?;
                    }
                    let mut committed = false;
                    for _ in 0..3 {
                        match compact_remote_set(client, &parsed, project, true).await {
                            Ok(true) => {
                                committed = true;
                                break;
                            }
                            Ok(false) => break,
                            Err(error) if error.code == CollabErrorCode::Conflict => continue,
                            Err(error) => return Err(error),
                        }
                    }
                    if !committed {
                        return Err(CollabError::new(
                            CollabErrorCode::Conflict,
                            "checkpoint could not be committed after three concurrent changes",
                        ));
                    }
                    project.first_unpublished = None;
                    Ok(())
                }
                .await;
                rebuild_peer_authority(&active);
                let _ = reply.send(result);
            }
            Command::AuthorizeMediaImport { project_id, reply } => {
                let result = (|| {
                    let (_, project) = checked_project(&active, &project_id)?;
                    if !project.role.can_write() {
                        return Err(CollabError::new(
                            CollabErrorCode::ReadOnly,
                            "viewer projects are read-only",
                        ));
                    }
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Command::GrantKnownMedia {
                project_id,
                path,
                reply,
            } => {
                let result = (|| {
                    let (parsed, project) = checked_project(&active, &project_id)?;
                    if !project.role.can_write() {
                        return Err(CollabError::new(
                            CollabErrorCode::ReadOnly,
                            "viewer projects are read-only",
                        ));
                    }
                    super::blobs::issue_known_grant(
                        parsed,
                        &project.surface,
                        &project.subject_id,
                        &path,
                    )
                    .map_err(
                        |error| CollabError::new(CollabErrorCode::Authorization, error.to_string()),
                    )
                })();
                let _ = reply.send(result);
            }
            Command::MediaSources {
                project_id,
                hash,
                reply,
            } => {
                let result = (|| {
                    super::blobs::path_for(&hash)
                        .map_err(|error| CollabError::validation(error.to_string()))?;
                    let (parsed, project) = checked_project(&active, &project_id)?;
                    let hashes = doc::media_hashes(parsed.as_str()).map_err(doc_error)?;
                    if !hashes.contains(&hash) {
                        return Err(CollabError::new(
                            CollabErrorCode::Authorization,
                            "media is not referenced by this project",
                        ));
                    }
                    Ok(MediaSources {
                        peers: project
                            .roster
                            .devices
                            .iter()
                            .filter(|device| !device.is_current_account)
                            .map(|device| device.endpoint_id.clone())
                            .collect(),
                        collected_locally: super::blobs::was_collected(&hash),
                    })
                })();
                let _ = reply.send(result);
            }
            Command::RequestMedia {
                project_id,
                hash,
                reply,
            } => {
                let parsed = ProjectId::parse(&project_id).and_then(|parsed| {
                    active
                        .contains_key(&parsed)
                        .then_some(parsed)
                        .ok_or_else(|| {
                            CollabError::new(CollabErrorCode::Unavailable, "project is not open")
                        })
                });
                let result = match parsed {
                    Err(error) => Err(error),
                    Ok(parsed)
                        if active
                            .get(&parsed)
                            .and_then(|project| project.media_notices.get(&hash))
                            .is_some_and(|sent| sent.elapsed() < MEDIA_NOTICE_INTERVAL) =>
                    {
                        Ok(())
                    }
                    Ok(parsed) => {
                        async {
                            super::blobs::path_for(&hash)
                                .map_err(|error| CollabError::validation(error.to_string()))?;
                            let client = convex.as_ref().ok_or_else(|| {
                                CollabError::new(
                                    CollabErrorCode::Network,
                                    "Convex authentication is unavailable",
                                )
                            })?;
                            let _: serde_json::Value = client
                                .mutation(
                                    "media:request",
                                    serde_json::json!({
                                        "projectId": parsed.as_str(),
                                        "hashes": [hash],
                                    }),
                                )
                                .await?;
                            if let Some(project) = active.get_mut(&parsed) {
                                project.media_notices.insert(hash, Instant::now());
                            }
                            Ok(())
                        }
                        .await
                    }
                };
                let _ = reply.send(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        checkpoint_needs_rekey, has_remote_endpoint, publication_debounce, publish_retry_delay,
        registration_arguments, roster_allows_peer_write, CachedRoster, CloseProject,
        CollabService, OpenProject, ProjectAccess, ProjectRole, RosterDevice, MAX_PUBLISH_RETRY,
    };
    use crate::collab::ids::OpaqueToken;
    use crate::collab::ops::{CollabOp, Geometry, ItemKind, OperationBatch};
    use std::time::{Duration, Instant};

    fn add_batch() -> OperationBatch {
        OperationBatch::v1(vec![CollabOp::AddItem {
            item_id: "item".into(),
            kind: ItemKind::Text,
            geometry: Geometry {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
                rotation: 0.0,
                natural_width: None,
                natural_height: None,
                detached: false,
            },
        }])
    }

    fn service() -> CollabService {
        CollabService::spawn_at(std::env::temp_dir().join(format!(
            "netsurush-service-{}",
            OpaqueToken::generate().expect("token").as_str()
        )))
    }

    #[tokio::test]
    async fn viewer_cannot_apply_operations() {
        let service = service();
        service
            .open(OpenProject {
                project_id: "viewer-project".into(),
                subject_id: "scene".into(),
                surface: "board".into(),
                role: ProjectRole::Viewer,
            })
            .await
            .expect("open");
        let error = service
            .apply("viewer-project".into(), add_batch())
            .await
            .expect_err("read only");
        assert_eq!(error.code, crate::collab::error::CollabErrorCode::ReadOnly);
    }

    #[tokio::test]
    async fn closing_a_project_rejects_late_operations() {
        let service = service();
        let session = service
            .open(OpenProject {
                project_id: "closed-project".into(),
                subject_id: "scene".into(),
                surface: "board".into(),
                role: ProjectRole::Editor,
            })
            .await
            .expect("open");
        service
            .close(CloseProject {
                project_id: "closed-project".into(),
                lease_id: session.lease_id,
            })
            .await
            .expect("close");
        assert!(service
            .apply("closed-project".into(), add_batch())
            .await
            .is_err());
    }

    #[test]
    fn inbound_writes_require_the_exact_current_writer_endpoint() {
        let roster = CachedRoster {
            access: ProjectAccess {
                role: ProjectRole::Owner,
                key_epoch: 2,
                rotation_required: false,
            },
            devices: vec![RosterDevice {
                user_id: "user".into(),
                device_id: "writer".into(),
                signing_public: "writer".into(),
                exchange_public: "exchange".into(),
                endpoint_id: "endpoint".into(),
                can_write: true,
                is_current_account: false,
                has_current_envelope: true,
            }],
        };
        assert!(roster_allows_peer_write(&roster, "endpoint"));
        assert!(!roster_allows_peer_write(&roster, "revoked"));
        let viewer = CachedRoster {
            devices: vec![RosterDevice {
                can_write: false,
                ..roster.devices[0].clone()
            }],
            ..roster
        };
        assert!(!roster_allows_peer_write(&viewer, "endpoint"));
    }

    #[test]
    fn refreshed_roster_starts_listening_before_the_next_local_edit() {
        let endpoints = vec!["current".to_string(), "new-member".to_string()];
        assert!(has_remote_endpoint(&endpoints, "current"));
        assert!(!has_remote_endpoint(&["current".to_string()], "current"));
    }

    #[test]
    fn publication_retries_back_off_and_remain_bounded() {
        assert_eq!(publish_retry_delay(1).as_secs(), 30);
        assert_eq!(publish_retry_delay(2).as_secs(), 60);
        assert_eq!(publish_retry_delay(6).as_secs(), 15 * 60);
        assert_eq!(publish_retry_delay(u8::MAX), MAX_PUBLISH_RETRY);
    }

    #[test]
    fn continuous_changes_cannot_postpone_publication_past_thirty_seconds() {
        let first = Instant::now();
        let mut started = None;
        assert_eq!(
            publication_debounce(&mut started, first),
            Duration::from_secs(3)
        );
        assert_eq!(
            publication_debounce(&mut started, first + Duration::from_secs(29)),
            Duration::from_secs(1)
        );
        assert_eq!(
            publication_debounce(&mut started, first + Duration::from_secs(31)),
            Duration::ZERO
        );
    }

    #[test]
    fn key_rotation_requires_a_checkpoint_under_the_new_epoch() {
        assert!(!checkpoint_needs_rekey(None, 4));
        assert!(!checkpoint_needs_rekey(Some(4), 4));
        assert!(checkpoint_needs_rekey(Some(3), 4));
    }

    #[test]
    fn device_registration_omits_an_absent_or_blank_label() {
        let statement = serde_json::json!({ "deviceId": "device" });
        let absent = registration_arguments(&statement, "signature", None);
        assert!(absent.get("label").is_none());
        let blank = registration_arguments(&statement, "signature", Some("  "));
        assert!(blank.get("label").is_none());
        let named = registration_arguments(&statement, "signature", Some("Laptop"));
        assert_eq!(named["label"], "Laptop");
    }
}
