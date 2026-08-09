#![allow(dead_code)]
use super::mpv_win32::*;
pub use super::mpv_win32::{set_window_owner_raw, set_window_pos_raw};

#[path = "mpv_window_geometry.rs"]
mod geometry;
#[path = "mpv_window_mode.rs"]
mod mode;
#[path = "mpv_window_state.rs"]
mod state;

/// A Win32 child window parented to the Tauri main window.
/// Used as the rendering target for mpv above the WebView2 surface.
pub struct MpvChildWindow {
    hwnd: isize,
    owner: isize,
    is_fullscreen: std::sync::atomic::AtomicBool,
    is_detached: std::sync::atomic::AtomicBool,
    // Detached window floats above the main app (owned window) when pinned;
    // unpinned it is a plain top-level window that can go behind the app.
    pinned_above_app: std::sync::atomic::AtomicBool,
    saved_geometry: std::sync::Mutex<(i32, i32, i32, i32)>,
    saved_detached_geometry: std::sync::Mutex<(i32, i32, i32, i32)>,
}

unsafe impl Send for MpvChildWindow {}
unsafe impl Sync for MpvChildWindow {}

impl MpvChildWindow {
    /// Create a popup window owned by the given parent HWND.
    /// Starts hidden - call show() after set_geometry().
    pub fn new(parent_hwnd: isize) -> Option<Self> {
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class_name = to_wide("AmvNotationMpvChild");
            let black_brush = CreateSolidBrush(0);

            let wc = WndClassExW {
                cb_size: std::mem::size_of::<WndClassExW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfn_wnd_proc: wnd_proc,
                cb_cls_extra: 0,
                cb_wnd_extra: 0,
                h_instance: instance,
                h_icon: 0,
                h_cursor: 0,
                hbr_background: black_brush,
                lpsz_menu_name: std::ptr::null(),
                lpsz_class_name: class_name.as_ptr(),
                h_icon_sm: 0,
            };

            // OK if registration fails (class may already exist)
            RegisterClassExW(&wc);

            let window_name = to_wide("mpv");
            // WS_CHILD : la vidéo est réellement attachée, déplacée et rognée avec l'application.
            // WS_EX_NOACTIVATE : elle ne vole jamais le focus à WebView2.
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE,
                class_name.as_ptr(),
                window_name.as_ptr(),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                parent_hwnd,
                0,
                instance,
                0,
            );

            if hwnd == 0 {
                eprintln!("[mpv] Failed to create popup window");
                return None;
            }

            eprintln!(
                "[mpv] Created embedded child window: hwnd={}, parent={}",
                hwnd, parent_hwnd
            );
            Some(MpvChildWindow {
                hwnd,
                owner: parent_hwnd,
                is_fullscreen: std::sync::atomic::AtomicBool::new(false),
                is_detached: std::sync::atomic::AtomicBool::new(false),
                pinned_above_app: std::sync::atomic::AtomicBool::new(true),
                saved_geometry: std::sync::Mutex::new((0, 0, 1, 1)),
                saved_detached_geometry: std::sync::Mutex::new((0, 0, 1, 1)),
            })
        }
    }

    pub fn hwnd(&self) -> isize {
        self.hwnd
    }

    fn is_valid_window(&self) -> bool {
        unsafe { IsWindow(self.hwnd) != 0 }
    }
}

impl Drop for MpvChildWindow {
    fn drop(&mut self) {
        if self.hwnd != 0 && self.is_valid_window() {
            unsafe {
                DestroyWindow(self.hwnd);
            }
        }
    }
}
