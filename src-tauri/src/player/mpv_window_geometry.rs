use super::MpvChildWindow;
use crate::player::mpv_win32::*;

impl MpvChildWindow {
    /// Returns the current outer window rect as (left, top, width, height).
    pub fn get_window_rect(&self) -> Option<(i32, i32, i32, i32)> {
        if !self.is_valid_window() {
            return None;
        }
        unsafe {
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(self.hwnd, &mut rect) == 0 {
                return None;
            }
            let w = (rect.right - rect.left).max(1);
            let h = (rect.bottom - rect.top).max(1);
            Some((rect.left, rect.top, w, h))
        }
    }

    /// Returns the client/video area rect in screen coordinates as (left, top, width, height).
    /// Useful for detached mode so overlays don't cover the native title bar.
    pub fn get_client_rect_screen(&self) -> Option<(i32, i32, i32, i32)> {
        if !self.is_valid_window() {
            return None;
        }

        unsafe {
            let mut client = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetClientRect(self.hwnd, &mut client) == 0 {
                return None;
            }

            let mut top_left = Point {
                x: client.left,
                y: client.top,
            };
            let mut bottom_right = Point {
                x: client.right,
                y: client.bottom,
            };

            if ClientToScreen(self.hwnd, &mut top_left) == 0
                || ClientToScreen(self.hwnd, &mut bottom_right) == 0
            {
                return None;
            }

            let w = (bottom_right.x - top_left.x).max(1);
            let h = (bottom_right.y - top_left.y).max(1);
            Some((top_left.x, top_left.y, w, h))
        }
    }

    /// Position the embedded child. x/y are client-area coordinates of the parent window.
    /// Returns true when the window was actually moved (mpv resizes its own video output window
    /// in response, which blanks the current frame — the caller may need to force a redraw).
    pub fn set_geometry(&self, x: i32, y: i32, w: i32, h: i32) -> bool {
        if w > 0 && h > 0 {
            if !self.is_valid_window() {
                return false;
            }
            if self.is_fullscreen() || self.is_detached() {
                return false;
            }
            unsafe {
                if let Ok(mut saved) = self.saved_geometry.lock() {
                    if *saved == (x, y, w, h) {
                        return false;
                    }
                    *saved = (x, y, w, h);
                }
                MoveWindow(self.hwnd, x, y, w, h, 1);
                return true;
            }
        }
        false
    }

    /// Set absolute geometry when in detached mode (screen coordinates).
    pub fn set_detached_geometry_absolute(&self, x: i32, y: i32, w: i32, h: i32) {
        if !self.is_valid_window() || !self.is_detached() {
            return;
        }
        let width = w.max(1);
        let height = h.max(1);
        unsafe {
            SetWindowPos(
                self.hwnd,
                HWND_TOP,
                x,
                y,
                width,
                height,
                SWP_SHOWWINDOW | SWP_NOACTIVATE,
            );
        }
        if let Ok(mut saved) = self.saved_detached_geometry.lock() {
            *saved = (x, y, width, height);
        }
    }

    /// Returns (left, top, width, height) of the monitor the owner window is on.
    /// Used to position the overlay on the same monitor as mpv fullscreen.
    pub fn get_fullscreen_monitor_rect(&self) -> Option<(i32, i32, i32, i32)> {
        if !self.is_valid_window() {
            return None;
        }
        unsafe {
            let monitor_target = if self.is_detached() {
                self.hwnd
            } else {
                self.owner
            };
            let monitor = MonitorFromWindow(monitor_target, MONITOR_DEFAULTTONEAREST);
            if monitor == 0 {
                return None;
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
                return None;
            }
            let w = mi.rc_monitor.right - mi.rc_monitor.left;
            let h = mi.rc_monitor.bottom - mi.rc_monitor.top;
            Some((mi.rc_monitor.left, mi.rc_monitor.top, w, h))
        }
    }
}
