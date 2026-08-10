use crate::state::AppState;
use tauri::State;

use super::shared::with_child_window;

#[tauri::command]
pub fn player_set_geometry(
    state: State<'_, AppState>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let moved = with_child_window(&state, |cw| Ok(cw.set_geometry(x, y, width, height)))?;
    if moved {
        // mpv suit la fenêtre parente et redimensionne sa sortie vidéo : l'image présentée est
        // perdue, et en PAUSE aucune image suivante ne vient la remplacer — surface NOIRE. On lui
        // redemande donc l'image courante.
        if let Ok(player) = state.player.lock() {
            if let Some(p) = player.as_ref() {
                if p.get_paused() {
                    let _ = p.redraw();
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn player_show(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<(), String> {
    with_child_window(&state, |cw| {
        cw.show();
        let mut overlay_sync = state.overlay_sync.lock().map_err(|e| e.to_string())?;
        super::overlay::sync_overlay_with_child(&app_handle, cw, false, &mut overlay_sync);
        Ok(())
    })
}

#[tauri::command]
pub fn player_hide(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    with_child_window(&state, |cw| {
        cw.hide();
        if let Some(overlay) = app_handle.get_webview_window("fullscreen-overlay") {
            let _ = overlay.set_fullscreen(false);
            let _ = overlay.hide();
            let _ = overlay.emit("overlay:visibility", false);
        }
        if let Ok(mut overlay_sync) = state.overlay_sync.lock() {
            *overlay_sync = crate::state::OverlaySyncState::default();
        }
        Ok(())
    })
}

#[tauri::command]
pub fn player_hide_surface(state: State<'_, AppState>) -> Result<(), String> {
    with_child_window(&state, |cw| {
        cw.hide();
        Ok(())
    })
}

#[tauri::command]
pub fn player_set_fullscreen(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    fullscreen: bool,
) -> Result<(), String> {
    use tauri::Manager;
    with_child_window(&state, |cw| {
        let mut overlay_sync = state.overlay_sync.lock().map_err(|e| e.to_string())?;
        if fullscreen {
            cw.show();
            cw.set_fullscreen(true);
            super::overlay::sync_overlay_with_child(&app_handle, cw, true, &mut overlay_sync);
        } else {
            cw.set_fullscreen(false);
            super::overlay::sync_overlay_with_child(
                &app_handle,
                cw,
                cw.is_detached(),
                &mut overlay_sync,
            );
            if !cw.is_detached() {
                if let Some(main) = app_handle.get_webview_window("main") {
                    let _ = main.set_focus();
                }
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn player_is_fullscreen(state: State<'_, AppState>) -> Result<bool, String> {
    let child = state.child_window.lock().map_err(|e| e.to_string())?;
    Ok(child.as_ref().map(|cw| cw.is_fullscreen()).unwrap_or(false))
}

#[tauri::command]
pub fn player_is_visible(state: State<'_, AppState>) -> Result<bool, String> {
    let child = state.child_window.lock().map_err(|e| e.to_string())?;
    Ok(child.as_ref().map(|cw| cw.is_visible()).unwrap_or(false))
}

/// Current detached player window rect (screen px) as (x, y, w, h).
/// Used as the drag anchor by the overlay top bar.
#[tauri::command]
pub fn player_get_detached_rect(state: State<'_, AppState>) -> Result<(i32, i32, i32, i32), String> {
    with_child_window(&state, |cw| {
        cw.get_window_rect()
            .ok_or_else(|| "no detached window rect".to_string())
    })
}

/// Move the borderless detached player to an absolute screen position, keeping
/// its size, then re-glue the overlay so it follows in lockstep. Driven by the
/// overlay top-bar JS drag (a native title-bar move loop can't be started from
/// the separate overlay window/thread).
#[tauri::command]
pub fn player_move_detached(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    x: i32,
    y: i32,
) -> Result<(), String> {
    with_child_window(&state, |cw| {
        if !cw.is_detached() || cw.is_fullscreen() {
            return Ok(());
        }
        if let Some((_, _, w, h)) = cw.get_window_rect() {
            cw.set_detached_geometry_absolute(x, y, w, h);
        }
        let mut overlay_sync = state.overlay_sync.lock().map_err(|e| e.to_string())?;
        super::overlay::sync_overlay_with_child(&app_handle, cw, false, &mut overlay_sync);
        Ok(())
    })
}

/// Native minimize (—) for the borderless detached player. No-op unless
/// detached and windowed.
#[tauri::command]
pub fn player_minimize_detached(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    with_child_window(&state, |cw| {
        cw.minimize_detached();
        // Pull the controls overlay down with the player right away.
        let mut overlay_sync = state.overlay_sync.lock().map_err(|e| e.to_string())?;
        super::overlay::sync_overlay_with_child(&app_handle, cw, false, &mut overlay_sync);
        Ok(())
    })
}

/// Pin/unpin the detached player above the main application window (📌 in the
/// overlay top bar). Pinned = owned popup, always floats above the app.
#[tauri::command]
pub fn player_set_detached_pinned(state: State<'_, AppState>, pinned: bool) -> Result<(), String> {
    with_child_window(&state, |cw| {
        cw.set_pinned_above_app(pinned);
        Ok(())
    })
}

#[tauri::command]
pub fn player_is_detached_pinned(state: State<'_, AppState>) -> Result<bool, String> {
    let child = state.child_window.lock().map_err(|e| e.to_string())?;
    Ok(child
        .as_ref()
        .map(|cw| cw.is_pinned_above_app())
        .unwrap_or(true))
}

#[tauri::command]
pub fn player_sync_overlay(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    with_child_window(&state, |cw| {
        let mut overlay_sync = state.overlay_sync.lock().map_err(|e| e.to_string())?;
        let previous = *overlay_sync;
        super::overlay::sync_overlay_with_child(&app_handle, cw, false, &mut overlay_sync);
        Ok(previous != *overlay_sync)
    })
}
