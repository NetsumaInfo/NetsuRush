use super::MpvChildWindow;
use crate::player::mpv_win32::*;

impl MpvChildWindow {
    pub fn set_fullscreen(&self, fullscreen: bool) {
        if fullscreen == self.is_fullscreen() {
            return;
        }
        if !self.is_valid_window() {
            return;
        }

        unsafe {
            if fullscreen {
                let monitor_target = if self.is_detached() {
                    self.hwnd
                } else {
                    self.owner
                };
                let monitor = MonitorFromWindow(monitor_target, MONITOR_DEFAULTTONEAREST);
                if monitor == 0 {
                    return;
                }

                let mut mi = MonitorInfo {
                    cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                    rc_monitor: Rect {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    rc_work: Rect {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    dw_flags: 0,
                };
                if GetMonitorInfoW(monitor, &mut mi) == 0 {
                    return;
                }

                if self.is_detached() {
                    let mut rect = Rect {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    };
                    if GetWindowRect(self.hwnd, &mut rect) != 0 {
                        let w = (rect.right - rect.left).max(1);
                        let h = (rect.bottom - rect.top).max(1);
                        if let Ok(mut saved) = self.saved_detached_geometry.lock() {
                            *saved = (rect.left, rect.top, w, h);
                        }
                    }

                    // Borderless style in fullscreen for true edge-to-edge video.
                    let fs_style = WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
                    SetWindowLongPtrW(self.hwnd, GWL_STYLE, fs_style as isize);
                    SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, WS_EX_APPWINDOW as isize);
                } else {
                    // Un WS_CHILD est rogné par son parent. Le plein écran le promeut
                    // temporairement en popup, puis la sortie le rattache au parent Tauri.
                    SetParent(self.hwnd, 0);
                    let fs_style = WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
                    SetWindowLongPtrW(self.hwnd, GWL_STYLE, fs_style as isize);
                    SetWindowLongPtrW(
                        self.hwnd,
                        GWL_EXSTYLE,
                        (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as isize,
                    );
                }

                let screen_w = mi.rc_monitor.right - mi.rc_monitor.left;
                let screen_h = mi.rc_monitor.bottom - mi.rc_monitor.top;
                // TOPMOST + full monitor rect (rc_monitor, not rc_work) so the
                // video covers the taskbar for a true 100% fullscreen. The
                // controls overlay is pushed into the top-most band above this
                // window (see sync_overlay_with_child → set_always_on_top).
                SetWindowPos(
                    self.hwnd,
                    HWND_TOPMOST,
                    mi.rc_monitor.left,
                    mi.rc_monitor.top,
                    screen_w,
                    screen_h,
                    SWP_SHOWWINDOW
                        | SWP_NOACTIVATE
                        | if self.is_detached() {
                            SWP_FRAMECHANGED
                        } else {
                            0
                        },
                );
            } else {
                let (x, y, w, h) = if self.is_detached() {
                    self.saved_detached_geometry
                        .lock()
                        .map(|g| *g)
                        .unwrap_or((0, 0, 1, 1))
                } else {
                    self.saved_geometry
                        .lock()
                        .map(|g| *g)
                        .unwrap_or((0, 0, 1, 1))
                };

                if self.is_detached() {
                    // Borderless (no WS_CAPTION): the React overlay draws the
                    // header/controls, so a native title bar would just be a
                    // redundant second header. WS_THICKFRAME keeps edge-resize.
                    let detached_style =
                        WS_POPUP | WS_VISIBLE | WS_THICKFRAME | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
                    SetWindowLongPtrW(self.hwnd, GWL_STYLE, detached_style as isize);
                    SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, WS_EX_APPWINDOW as isize);
                } else {
                    SetParent(self.hwnd, self.owner);
                    let attached_style = WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
                    SetWindowLongPtrW(self.hwnd, GWL_STYLE, attached_style as isize);
                    SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, WS_EX_NOACTIVATE as isize);
                }

                SetWindowPos(
                    self.hwnd,
                    HWND_NOTOPMOST,
                    x,
                    y,
                    w.max(1),
                    h.max(1),
                    SWP_SHOWWINDOW
                        | if self.is_detached() {
                            SWP_FRAMECHANGED
                        } else {
                            0
                        },
                );
            }
        }

        self.is_fullscreen
            .store(fullscreen, std::sync::atomic::Ordering::Relaxed);
    }

    /// Detach the mpv window from the Tauri parent.
    /// Makes it a standalone top-level window with title bar that can be
    /// freely moved to any monitor.
    pub fn detach(&self) {
        if self.is_detached() || self.is_fullscreen() {
            return;
        }
        if !self.is_valid_window() {
            return;
        }

        unsafe {
            let was_visible = IsWindowVisible(self.hwnd) != 0;

            // Get current screen position for initial placement
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetWindowRect(self.hwnd, &mut rect);
            let cur_w = (rect.right - rect.left).max(640);
            let cur_h = (rect.bottom - rect.top).max(360);

            if let Ok(mut saved) = self.saved_detached_geometry.lock() {
                *saved = (rect.left, rect.top, cur_w, cur_h);
            }

            // Promote the embedded child to a top-level window. Borderless: the React overlay provides the
            // header (clip name / close) and controls, so we drop WS_CAPTION to
            // avoid a second redundant title bar. WS_THICKFRAME keeps the window
            // resizable from its edges. Moving is driven by the overlay top bar
            // (see player_begin_drag).
            let new_style =
                WS_POPUP | WS_VISIBLE | WS_THICKFRAME | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
            SetParent(self.hwnd, 0);
            SetWindowLongPtrW(self.hwnd, GWL_STYLE, new_style as isize);

            // Change extended style: show in taskbar, allow activation
            let new_ex_style = WS_EX_APPWINDOW;
            SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, new_ex_style as isize);

            // Detached mode: when pinned, keep the main window as owner so the
            // video floats above the main app (Windows guarantees an owned
            // window stays above its owner). Unpinned, the video is a plain
            // standalone window and clicking the main app can bury it. The
            // controls overlay is in turn owned by this video window (see
            // sync_overlay_with_child), so the chain overlay > video is
            // preserved either way.
            let owner = if self.is_pinned_above_app() {
                self.owner
            } else {
                0
            };
            SetWindowLongPtrW(self.hwnd, GWLP_HWNDPARENT, owner);

            // Set window title
            let title = to_wide("AMV Notation - Video");
            SetWindowTextW(self.hwnd, title.as_ptr());

            // Apply frame changes and reposition
            let mut flags = SWP_FRAMECHANGED;
            if was_visible {
                flags |= SWP_SHOWWINDOW;
            }
            SetWindowPos(
                self.hwnd,
                HWND_NOTOPMOST,
                rect.left,
                rect.top,
                cur_w,
                cur_h,
                flags,
            );
            if !was_visible {
                ShowWindow(self.hwnd, SW_HIDE);
            }
        }

        self.is_detached
            .store(true, std::sync::atomic::Ordering::Relaxed);
        eprintln!("[mpv] Window detached");
    }

    /// Pin/unpin the detached player above the main application window.
    /// Pinned = owned by the main window (always floats above the app).
    /// Unpinned = standalone top-level window (normal z-order).
    pub fn set_pinned_above_app(&self, pinned: bool) {
        self.pinned_above_app
            .store(pinned, std::sync::atomic::Ordering::Relaxed);
        if !self.is_valid_window() || !self.is_detached() || self.is_fullscreen() {
            return;
        }
        unsafe {
            let owner = if pinned { self.owner } else { 0 };
            SetWindowLongPtrW(self.hwnd, GWLP_HWNDPARENT, owner);
            // Re-assert z-order so the ownership change applies immediately
            // instead of waiting for the next activation.
            SetWindowPos(
                self.hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    pub fn is_pinned_above_app(&self) -> bool {
        self.pinned_above_app
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Re-attach the mpv window to the Tauri parent.
    pub fn attach(&self) {
        if !self.is_detached() {
            return;
        }
        if !self.is_valid_window() {
            return;
        }
        if self.is_fullscreen() {
            self.set_fullscreen(false);
        }

        unsafe {
            // Restore the actual parent/child relationship before client-relative geometry.
            SetWindowLongPtrW(self.hwnd, GWLP_HWNDPARENT, 0);
            SetParent(self.hwnd, self.owner);
            let orig_style = WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
            SetWindowLongPtrW(self.hwnd, GWL_STYLE, orig_style as isize);

            // Restore extended style
            let orig_ex_style = WS_EX_NOACTIVATE;
            SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, orig_ex_style as isize);

            // Restore saved geometry
            let (x, y, w, h) = self
                .saved_geometry
                .lock()
                .map(|g| *g)
                .unwrap_or((0, 0, 1, 1));

            SetWindowPos(
                self.hwnd,
                HWND_NOTOPMOST,
                x,
                y,
                w.max(1),
                h.max(1),
                SWP_FRAMECHANGED | SWP_SHOWWINDOW,
            );
        }

        self.is_detached
            .store(false, std::sync::atomic::Ordering::Relaxed);
        eprintln!("[mpv] Window re-attached");
    }
}
