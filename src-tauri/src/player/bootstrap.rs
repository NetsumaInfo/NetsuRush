use crate::state::AppState;
use tauri::Manager;

#[cfg(target_os = "windows")]
pub fn initialize_embedded_player(app: &tauri::App, state: &tauri::State<'_, AppState>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[AMV] Main window not found at setup; continuing without player");
        return;
    };

    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(e) => {
            eprintln!("[AMV] Failed to get window HWND: {}", e);
            return;
        }
    };
    let parent_hwnd = hwnd.0 as isize;
    eprintln!("[AMV] Main window HWND: {}", parent_hwnd);

    if let Some(child) = super::mpv_window::MpvChildWindow::new(parent_hwnd) {
        let child_hwnd = child.hwnd();
        eprintln!("[AMV] Child window HWND: {}", child_hwnd);

        match super::mpv_wrapper::MpvPlayer::new(Some(child_hwnd as i64)) {
            Ok(p) => {
                match state.player.lock() {
                    Ok(mut player_slot) => {
                        *player_slot = Some(p);
                    }
                    Err(e) => {
                        eprintln!("[AMV] Failed to store player state: {}", e);
                    }
                }
                match state.child_window.lock() {
                    Ok(mut child_slot) => {
                        *child_slot = Some(child);
                    }
                    Err(e) => {
                        eprintln!("[AMV] Failed to store child window state: {}", e);
                    }
                }
                eprintln!("[AMV] mpv player initialized with embedded window");
            }
            Err(e) => {
                eprintln!("[AMV] Warning: mpv not available: {}", e);
                eprintln!("[AMV] Video playback will be disabled.");
            }
        }
    } else {
        eprintln!("[AMV] Failed to create child window");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn initialize_embedded_player(_app: &tauri::App, _state: &tauri::State<'_, AppState>) {}
