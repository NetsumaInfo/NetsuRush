use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct PlayerStatus {
    pub is_playing: bool,
    pub current_time: f64,
    pub duration: f64,
    pub volume: f64,
    pub speed: f64,
}

#[derive(Debug, Serialize)]
pub struct TrackListResult {
    pub audio_tracks: Vec<TrackItem>,
    pub subtitle_tracks: Vec<TrackItem>,
}

#[derive(Debug, Serialize)]
pub struct TrackItem {
    pub id: i64,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub codec: Option<String>,
    pub external: bool,
}

pub(super) fn with_player<T, F>(
    state: &State<'_, AppState>,
    err_msg: &str,
    op: F,
) -> Result<T, String>
where
    F: FnOnce(&crate::player::mpv_wrapper::MpvPlayer) -> Result<T, String>,
{
    let player = state.player.lock().map_err(|e| e.to_string())?;
    match &*player {
        Some(p) => op(p),
        None => Err(err_msg.to_string()),
    }
}

pub(super) fn with_child_window<T, F>(state: &State<'_, AppState>, op: F) -> Result<T, String>
where
    F: FnOnce(&crate::player::mpv_window::MpvChildWindow) -> Result<T, String>,
{
    let child = state.child_window.lock().map_err(|e| e.to_string())?;
    match &*child {
        Some(cw) => op(cw),
        None => Err("Child window not available".to_string()),
    }
}
