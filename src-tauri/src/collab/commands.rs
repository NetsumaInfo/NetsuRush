use tauri::{AppHandle, Emitter as _, State};

use super::blobs::Manifest;
use super::doc::{ApplyResult, ProjectProjection};
use super::error::CollabError;
use super::ops::OperationBatch;
use super::service::{
    AuthConfiguration, ChangeMemberRole, CloseProject, CollabService, CreatedProject,
    InviteMembers, OpenProject, ProjectSession, ProjectStatus, RemoveMember, RespondInvite,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMediaRequest {
    project_id: String,
    grant: String,
    mime: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveMediaRequest {
    project_id: String,
    asset: Manifest,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveMediaResult {
    status: &'static str,
    hash: String,
}

const CHANGED_EVENT: &str = "nr-collab-changed";

#[tauri::command]
pub fn collab_device_identity() -> Result<super::identity::DeviceIdentityPublic, CollabError> {
    let identity =
        super::identity::get_or_init().map_err(|error| CollabError::storage(error.to_string()))?;
    Ok(identity.public().clone())
}

fn announce(app: &AppHandle, project_id: &str, result: &ApplyResult) {
    let _ = app.emit(
        CHANGED_EVENT,
        serde_json::json!({ "projectId": project_id, "revision": result.revision }),
    );
}

#[tauri::command]
pub async fn collab_configure_auth(
    service: State<'_, CollabService>,
    configuration: AuthConfiguration,
) -> Result<(), CollabError> {
    service.configure_auth(configuration).await
}

#[tauri::command]
pub async fn collab_project_open(
    service: State<'_, CollabService>,
    request: OpenProject,
) -> Result<ProjectSession, CollabError> {
    service.open(request).await
}

#[tauri::command]
pub async fn collab_project_create(
    service: State<'_, CollabService>,
    surface: Option<String>,
) -> Result<CreatedProject, CollabError> {
    service.create_project(surface.unwrap_or_default()).await
}

#[tauri::command]
pub async fn collab_project_abort(
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<(), CollabError> {
    service.abort_project(project_id).await
}

#[tauri::command]
pub async fn collab_project_invite(
    service: State<'_, CollabService>,
    request: InviteMembers,
) -> Result<serde_json::Value, CollabError> {
    service.invite_members(request).await
}

#[tauri::command]
pub async fn collab_project_flush_checkpoint(
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<(), CollabError> {
    service.flush_checkpoint(project_id).await
}

#[tauri::command]
pub async fn collab_invite_respond(
    service: State<'_, CollabService>,
    request: RespondInvite,
) -> Result<serde_json::Value, CollabError> {
    service.respond_invite(request).await
}

#[tauri::command]
pub async fn collab_invite_cancel(
    service: State<'_, CollabService>,
    invite_id: String,
) -> Result<(), CollabError> {
    service.cancel_invite(invite_id).await
}

#[tauri::command]
pub async fn collab_member_set_role(
    service: State<'_, CollabService>,
    request: ChangeMemberRole,
) -> Result<serde_json::Value, CollabError> {
    service.change_member_role(request).await
}

#[tauri::command]
pub async fn collab_member_remove(
    service: State<'_, CollabService>,
    request: RemoveMember,
) -> Result<serde_json::Value, CollabError> {
    service.remove_member(request).await
}

#[tauri::command]
pub async fn collab_project_leave(
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<(), CollabError> {
    service.leave_project(project_id).await
}

#[tauri::command]
pub async fn collab_project_delete(
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<(), CollabError> {
    service.delete_project(project_id).await
}

#[tauri::command]
pub async fn collab_head_discard_stale(
    service: State<'_, CollabService>,
    head_id: String,
) -> Result<(), CollabError> {
    service.discard_stale_head(head_id).await
}

#[tauri::command]
pub async fn collab_device_forget(
    service: State<'_, CollabService>,
    device_id: String,
) -> Result<(), CollabError> {
    service.forget_device(device_id).await
}

#[tauri::command]
pub async fn collab_media_import(
    service: State<'_, CollabService>,
    request: ImportMediaRequest,
) -> Result<Manifest, CollabError> {
    let project_id = super::ids::ProjectId::parse(request.project_id.clone())?;
    super::ops::validate_mime(&request.mime)?;
    service.authorize_media_import(request.project_id).await?;
    let path =
        super::blobs::consume_import_grant(&project_id, &request.grant).map_err(|error| {
            CollabError::new(
                super::error::CollabErrorCode::Authorization,
                error.to_string(),
            )
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = path
            .to_str()
            .ok_or_else(|| super::blobs::BlobError::Io("media path is not valid Unicode".into()))?;
        super::blobs::put(source, &request.mime)
    })
    .await
    .map_err(|error| CollabError::storage(error.to_string()))?
    .map_err(|error| CollabError::storage(error.to_string()))
}

#[tauri::command]
pub async fn collab_media_grant_known(
    service: State<'_, CollabService>,
    project_id: String,
    path: String,
) -> Result<String, CollabError> {
    service.grant_known_media(project_id, path).await
}

/// Chemin sur disque des octets d'un média du projet OUVERT, ou `None` s'ils n'y sont pas encore.
///
/// Le service Node ne connaît que des fichiers : sans ce chemin, exporter un board partagé en
/// `.netsu` écrivait un document dont TOUS les médias étaient des placeholders — en annonçant que
/// l'export avait réussi. Ce sont les mêmes conditions que le protocole d'affichage : projet sous
/// bail et empreinte référencée par le document courant. Le renderer peut déjà lire ces octets par
/// ce protocole, connaître leur chemin ne lui ouvre donc rien de plus.
#[tauri::command]
pub async fn collab_media_path(
    project_id: String,
    hash: String,
) -> Result<Option<String>, CollabError> {
    let authorised = super::doc::open_media_hashes(&project_id)
        .map_err(|error| CollabError::validation(error.to_string()))?
        .is_some_and(|hashes| hashes.contains(&hash));
    if !authorised {
        return Err(CollabError::validation(
            "media is not part of the open project",
        ));
    }
    let path = super::blobs::path_for(&hash).map_err(|error| CollabError::validation(error.to_string()))?;
    Ok(path
        .is_file()
        .then(|| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn collab_media_resolve(
    service: State<'_, CollabService>,
    request: ResolveMediaRequest,
) -> Result<ResolveMediaResult, CollabError> {
    super::blobs::path_for(&request.asset.hash)
        .map_err(|error| CollabError::validation(error.to_string()))?;
    if request.asset.mime.is_empty()
        || request.asset.mime.len() > 255
        || request.asset.size > i64::MAX as u64
    {
        return Err(CollabError::validation("invalid media manifest"));
    }
    let sources = service
        .media_sources(request.project_id.clone(), request.asset.hash.clone())
        .await?;
    if super::blobs::has(&request.asset.hash) {
        super::blobs::store_manifest(&request.asset)
            .map_err(|error| CollabError::storage(error.to_string()))?;
        return Ok(ResolveMediaResult {
            status: "available",
            hash: request.asset.hash,
        });
    }
    for peer in sources.peers {
        if super::net::fetch_blob(
            &request.project_id,
            &peer,
            &request.asset.hash,
            request.asset.size,
        )
        .await
        .is_ok()
        {
            super::blobs::store_manifest(&request.asset)
                .map_err(|error| CollabError::storage(error.to_string()))?;
            return Ok(ResolveMediaResult {
                status: "available",
                hash: request.asset.hash,
            });
        }
    }
    if !sources.collected_locally {
        let _ = service
            .request_media(request.project_id.clone(), request.asset.hash.clone())
            .await;
    }
    Ok(ResolveMediaResult {
        status: if sources.collected_locally {
            "removed"
        } else {
            "waiting"
        },
        hash: request.asset.hash,
    })
}

#[tauri::command]
pub async fn collab_project_close(
    service: State<'_, CollabService>,
    request: CloseProject,
) -> Result<(), CollabError> {
    service.close(request).await
}

#[tauri::command]
pub async fn collab_project_apply(
    app: AppHandle,
    service: State<'_, CollabService>,
    project_id: String,
    batch: OperationBatch,
) -> Result<ApplyResult, CollabError> {
    let result = service.apply(project_id.clone(), batch).await?;
    announce(&app, &project_id, &result);
    Ok(result)
}

#[tauri::command]
pub async fn collab_project_projection(
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<ProjectProjection, CollabError> {
    service.projection(project_id).await
}

#[tauri::command]
pub async fn collab_project_status(
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<ProjectStatus, CollabError> {
    service.status(project_id).await
}

#[tauri::command]
pub async fn collab_project_undo(
    app: AppHandle,
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<ApplyResult, CollabError> {
    let result = service.undo(project_id.clone(), false).await?;
    announce(&app, &project_id, &result);
    Ok(result)
}

#[tauri::command]
pub async fn collab_project_redo(
    app: AppHandle,
    service: State<'_, CollabService>,
    project_id: String,
) -> Result<ApplyResult, CollabError> {
    let result = service.undo(project_id.clone(), true).await?;
    announce(&app, &project_id, &result);
    Ok(result)
}
