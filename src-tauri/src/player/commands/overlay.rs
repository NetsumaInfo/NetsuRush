pub(super) fn sync_overlay_with_child(
    app_handle: &tauri::AppHandle,
    cw: &crate::player::mpv_window::MpvChildWindow,
    focus_overlay: bool,
    sync_state: &mut crate::state::OverlaySyncState,
) {
    use tauri::{Emitter, Manager};

    let Some(overlay) = app_handle.get_webview_window("fullscreen-overlay") else {
        return;
    };

    let is_detached = cw.is_detached();
    let is_fullscreen = cw.is_fullscreen();
    let should_show = (is_detached || is_fullscreen) && cw.is_visible() && !cw.is_minimized();
    let overlay_visible = overlay.is_visible().unwrap_or(sync_state.visible);

    if !should_show {
        if overlay_visible || sync_state.visible {
            let _ = overlay.set_fullscreen(false);
            let _ = overlay.hide();
            let _ = overlay.emit("overlay:visibility", false);
        }
        sync_state.visible = false;
        sync_state.detached = is_detached;
        sync_state.fullscreen = is_fullscreen;
        sync_state.rect = None;
        return;
    }

    let target_rect = if is_detached && !is_fullscreen {
        cw.get_client_rect_screen().or_else(|| cw.get_window_rect())
    } else {
        cw.get_window_rect()
            .or_else(|| cw.get_fullscreen_monitor_rect())
    };

    let mode_changed = sync_state.detached != is_detached || sync_state.fullscreen != is_fullscreen;
    let rect_changed = sync_state.rect != target_rect;
    let became_visible = !overlay_visible || !sync_state.visible;
    let needs_reposition = mode_changed || rect_changed || became_visible;

    if became_visible {
        let _ = overlay.set_shadow(false);
        let _ = overlay.set_ignore_cursor_events(false);
    }

    if mode_changed || became_visible {
        // The fullscreen video window is TOPMOST, so the overlay must also be
        // top-most to stay above it. In windowed/detached mode it must NOT be
        // top-most or it would float over other apps.
        let _ = overlay.set_always_on_top(is_fullscreen);
        // Ensure we can freely place the window before optional fullscreen fallback.
        let _ = overlay.set_fullscreen(false);
    }

    if needs_reposition {
        if let Some((mx, my, mw, mh)) = target_rect {
            #[cfg(target_os = "windows")]
            {
                if let Ok(hwnd) = overlay.hwnd() {
                    let overlay_hwnd = hwnd.0 as isize;
                    let video_hwnd = cw.hwnd();
                    unsafe {
                        crate::player::mpv_window::set_window_owner_raw(overlay_hwnd, video_hwnd);
                    }
                    let positioned_above_video = unsafe {
                        crate::player::mpv_window::set_window_pos_raw(
                            overlay_hwnd,
                            0,
                            mx,
                            my,
                            mw,
                            mh,
                            0x0010,
                        )
                    };
                    if !positioned_above_video {
                        let _ = unsafe {
                            crate::player::mpv_window::set_window_pos_raw(
                                video_hwnd, -2, 0, 0, 0, 0, 0x0013,
                            )
                        };
                        let retry_above_video = unsafe {
                            crate::player::mpv_window::set_window_pos_raw(
                                overlay_hwnd,
                                0,
                                mx,
                                my,
                                mw,
                                mh,
                                0x0010,
                            )
                        };
                        if !retry_above_video {
                            let positioned_top = unsafe {
                                crate::player::mpv_window::set_window_pos_raw(
                                    overlay_hwnd,
                                    0,
                                    mx,
                                    my,
                                    mw,
                                    mh,
                                    0x0010,
                                )
                            };
                            if !positioned_top && is_fullscreen {
                                let _ = overlay.set_fullscreen(true);
                            }
                        }
                    }
                } else if is_fullscreen {
                    let _ = overlay.set_fullscreen(true);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = overlay.set_fullscreen(true);
            }
        } else if is_fullscreen {
            let _ = overlay.set_fullscreen(true);
        }
    }

    if became_visible {
        let _ = overlay.show();
        let _ = overlay.emit("overlay:visibility", true);
    }

    if focus_overlay {
        let _ = overlay.set_focus();
    }

    sync_state.visible = true;
    sync_state.detached = is_detached;
    sync_state.fullscreen = is_fullscreen;
    sync_state.rect = target_rect;
}
