use crate::state::AppState;
use std::sync::atomic::Ordering;
use tauri::State;

use super::shared::{with_player, PlayerStatus, TrackItem, TrackListResult};

#[tauri::command]
pub fn player_load(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_player(
        &state,
        "Player not initialized. Make sure mpv-2.dll is available.",
        |p| p.load_file(&path),
    )
}

/// Take ownership of the shared player and return the new claim id.
///
/// Called by a surface right before it loads its own media. Surfaces holding an older claim see it
/// in `player_get_status` and stop driving the player.
#[tauri::command]
pub fn player_claim(state: State<'_, AppState>) -> u64 {
    state.player_claim.fetch_add(1, Ordering::SeqCst) + 1
}

/// Load a file already positioned at `position` seconds (see `load_file_at`).
#[tauri::command]
pub fn player_load_at(
    state: State<'_, AppState>,
    path: String,
    position: f64,
) -> Result<(), String> {
    with_player(
        &state,
        "Player not initialized. Make sure mpv-2.dll is available.",
        |p| p.load_file_at(&path, position),
    )
}

#[tauri::command]
pub fn player_play(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.play())
}

#[tauri::command]
pub fn player_pause(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.pause())
}

#[tauri::command]
pub fn player_toggle_pause(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.toggle_pause())
}

#[tauri::command]
pub fn player_stop(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.stop())
}

#[tauri::command]
pub fn player_seek(state: State<'_, AppState>, position: f64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.seek(position))
}

#[tauri::command]
pub fn player_seek_relative(state: State<'_, AppState>, offset: f64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| {
        p.seek_relative(offset)
    })
}

#[tauri::command]
pub fn player_set_volume(state: State<'_, AppState>, volume: f64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.set_volume(volume))
}

#[tauri::command]
pub fn player_set_speed(state: State<'_, AppState>, speed: f64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.set_speed(speed))
}

#[tauri::command]
pub fn player_set_audio_meter(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| {
        p.set_audio_meter(enabled)
    })
}

#[derive(serde::Serialize)]
pub struct LoopState {
    pub loop_file: bool,
    pub ab_a: Option<f64>,
    pub ab_b: Option<f64>,
}

#[tauri::command]
pub fn player_set_loop_file(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.set_loop_file(enabled))
}

#[tauri::command]
pub fn player_ab_loop_mark_a(state: State<'_, AppState>, time: f64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.ab_loop_set_a(time))
}

#[tauri::command]
pub fn player_ab_loop_mark_b(state: State<'_, AppState>, time: f64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.ab_loop_set_b(time))
}

#[tauri::command]
pub fn player_ab_loop_clear(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.ab_loop_clear())
}

#[tauri::command]
pub fn player_get_loop_state(state: State<'_, AppState>) -> Result<LoopState, String> {
    let player = state.player.lock().map_err(|e| e.to_string())?;
    match &*player {
        Some(p) => {
            let (ab_a, ab_b) = p.get_ab_loop();
            Ok(LoopState {
                loop_file: p.get_loop_file(),
                ab_a,
                ab_b,
            })
        }
        None => Ok(LoopState {
            loop_file: false,
            ab_a: None,
            ab_b: None,
        }),
    }
}

#[tauri::command]
pub fn player_get_status(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    let claim = state.player_claim.load(Ordering::SeqCst);
    let player = state.player.lock().map_err(|e| e.to_string())?;
    match &*player {
        Some(p) => Ok(PlayerStatus {
            is_playing: !p.get_paused(),
            current_time: p.get_time_pos(),
            duration: p.get_duration(),
            volume: p.get_volume(),
            speed: p.get_speed(),
            path: p.get_loaded_path(),
            claim,
        }),
        None => Ok(PlayerStatus {
            is_playing: false,
            current_time: 0.0,
            duration: 0.0,
            volume: 80.0,
            speed: 1.0,
            path: String::new(),
            claim,
        }),
    }
}

#[tauri::command]
pub fn player_get_tracks(state: State<'_, AppState>) -> Result<TrackListResult, String> {
    let player = state.player.lock().map_err(|e| e.to_string())?;
    match &*player {
        Some(p) => {
            let tracks = p.get_track_list();
            let audio_tracks: Vec<TrackItem> = tracks
                .iter()
                .filter(|t| t.track_type == "audio")
                .map(|t| TrackItem {
                    id: t.id,
                    title: t.title.clone(),
                    lang: t.lang.clone(),
                    codec: t.codec.clone(),
                    external: t.external,
                })
                .collect();
            let subtitle_tracks: Vec<TrackItem> = tracks
                .iter()
                .filter(|t| t.track_type == "sub")
                .map(|t| TrackItem {
                    id: t.id,
                    title: t.title.clone(),
                    lang: t.lang.clone(),
                    codec: t.codec.clone(),
                    external: t.external,
                })
                .collect();
            Ok(TrackListResult {
                audio_tracks,
                subtitle_tracks,
            })
        }
        None => Ok(TrackListResult {
            audio_tracks: vec![],
            subtitle_tracks: vec![],
        }),
    }
}

#[tauri::command]
pub fn player_set_subtitle_track(
    state: State<'_, AppState>,
    id: Option<i64>,
) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| {
        p.set_subtitle_track(id)
    })
}

#[tauri::command]
pub fn player_set_audio_track(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.set_audio_track(id))
}

#[tauri::command]
pub fn player_frame_step(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.frame_step())
}

#[tauri::command]
pub fn player_frame_back_step(state: State<'_, AppState>) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.frame_back_step())
}

#[tauri::command]
pub fn player_screenshot(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_player(&state, "Player not initialized", |p| p.screenshot(&path))
}

#[tauri::command]
pub fn player_get_audio_levels(
    state: State<'_, AppState>,
) -> Result<crate::player::mpv_wrapper::AudioLevels, String> {
    let player = state.player.lock().map_err(|e| e.to_string())?;
    match &*player {
        Some(p) => Ok(p.get_audio_levels()),
        None => Ok(crate::player::mpv_wrapper::AudioLevels {
            left_db: -90.0,
            right_db: -90.0,
            left_peak_db: -90.0,
            right_peak_db: -90.0,
            overall_db: -90.0,
            available: false,
        }),
    }
}

#[tauri::command]
pub fn player_is_available(state: State<'_, AppState>) -> bool {
    let player = state.player.lock().unwrap_or_else(|e| e.into_inner());
    player.is_some()
}
