use crate::state::AppState;
use std::sync::mpsc;
use std::time::Duration;
use tauri::State;

#[tauri::command]
pub async fn player_get_media_info(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<crate::player::mpv_wrapper::MediaInfo, String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    if let Some(target_path) = path {
        let trimmed = target_path.trim().to_string();
        if !trimmed.is_empty() {
            let normalized_target = super::parsing::normalize_path(&trimmed);
            if let Some(cached) = super::cache::get_media_info_cached(&normalized_target) {
                return Ok(cached);
            }

            // (b) probe via channel/timeout, off the event-loop thread.
            let probe_result = {
                let probe_target = normalized_target.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let (tx, rx) = mpsc::channel();
                    std::thread::spawn({
                        let probe_path = probe_target.clone();
                        move || {
                            let _ =
                                tx.send(super::probe::probe_media_info_open_source(&probe_path));
                        }
                    });
                    rx.recv_timeout(Duration::from_millis(2500))
                })
                .await
                .map_err(|join_error| format!("Media info task failed: {}", join_error))?
            };

            if let Ok(Ok(info)) = probe_result {
                super::cache::put_media_info_cache(&normalized_target, info.clone());
                return Ok(info);
            }

            // (c) try_lock the live player; do not hold the lock across an await.
            if let Ok(player) = state.player.try_lock() {
                if let Some(p) = &*player {
                    let current_path = super::parsing::normalize_path(&p.get_current_path());
                    if !current_path.is_empty()
                        && current_path.eq_ignore_ascii_case(&normalized_target)
                    {
                        let info = catch_unwind(AssertUnwindSafe(|| p.get_media_info()))
                            .unwrap_or_else(|_| crate::player::mpv_wrapper::MediaInfo::empty());
                        super::cache::put_media_info_cache(&normalized_target, info.clone());
                        return Ok(info);
                    }
                }
            }

            // (d) minimal fallback.
            let fallback = super::probe::build_minimal_media_info(&trimmed);
            super::cache::put_media_info_cache(&normalized_target, fallback.clone());
            return Ok(fallback);
        }
    }

    if let Ok(player) = state.player.try_lock() {
        if let Some(p) = &*player {
            let info = catch_unwind(AssertUnwindSafe(|| p.get_media_info()))
                .unwrap_or_else(|_| crate::player::mpv_wrapper::MediaInfo::empty());
            let current_path = super::parsing::normalize_path(&p.get_current_path());
            if !current_path.is_empty() {
                super::cache::put_media_info_cache(&current_path, info.clone());
            }
            return Ok(info);
        }
        return Err("Player not initialized".to_string());
    }

    Ok(crate::player::mpv_wrapper::MediaInfo::empty())
}

#[tauri::command]
pub async fn player_get_frame_preview(
    state: State<'_, AppState>,
    path: Option<String>,
    seconds: f64,
    width: Option<u32>,
) -> Result<String, String> {
    let mut target_path = path.unwrap_or_default().trim().to_string();
    if target_path.is_empty() {
        let player = state.player.lock().map_err(|e| e.to_string())?;
        if let Some(p) = &*player {
            target_path = p.get_current_path();
        }
    }

    if target_path.trim().is_empty() {
        return Err("Aucun fichier vidéo disponible pour le preview".to_string());
    }

    let safe_width = width.unwrap_or(320).clamp(120, 640);
    let normalized_path = super::parsing::normalize_path(target_path.trim());
    if let Some(cached) =
        super::cache::get_frame_preview_cached(&normalized_path, seconds, safe_width)
    {
        return Ok(cached);
    }

    let probe_path = normalized_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        match super::probe::probe_frame_preview_with_ffmpeg(&probe_path, seconds, safe_width) {
            Ok(image) => Ok(image),
            Err(ffmpeg_err) => super::probe::probe_frame_preview_with_mpv(&probe_path, seconds)
                .map_err(|mpv_err| format!("ffmpeg: {}; mpv: {}", ffmpeg_err, mpv_err)),
        }
    })
    .await
    .map_err(|join_error| format!("Preview task failed: {}", join_error))?;

    match result {
        Ok(image) => {
            super::cache::put_frame_preview_cache(
                &normalized_path,
                seconds,
                safe_width,
                image.clone(),
            );
            Ok(image)
        }
        Err(error) => Err(error),
    }
}
