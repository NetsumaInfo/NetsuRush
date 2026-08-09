#![allow(dead_code)]
#![allow(non_snake_case)]

// Win32 constants
pub(crate) const WS_POPUP: u32 = 0x80000000;
pub(crate) const WS_CHILD: u32 = 0x40000000;
pub(crate) const WS_CLIPCHILDREN: u32 = 0x02000000;
pub(crate) const WS_CLIPSIBLINGS: u32 = 0x04000000;
pub(crate) const WS_EX_TOOLWINDOW: u32 = 0x00000080;
pub(crate) const WS_EX_NOACTIVATE: u32 = 0x08000000;
pub(crate) const CS_HREDRAW: u32 = 0x0002;
pub(crate) const CS_VREDRAW: u32 = 0x0001;
pub(crate) const SW_SHOW: i32 = 5;
pub(crate) const SW_HIDE: i32 = 0;
pub(crate) const SW_MINIMIZE: i32 = 6;
pub(crate) const SW_MAXIMIZE: i32 = 3;
pub(crate) const SW_RESTORE: i32 = 9;
pub(crate) const WM_MOUSEACTIVATE: u32 = 0x0021;
pub(crate) const WM_NCHITTEST: u32 = 0x0084;
pub(crate) const WM_CLOSE: u32 = 0x0010;
pub(crate) const MA_NOACTIVATE: isize = 3;
pub(crate) const HTTRANSPARENT: isize = -1;
pub(crate) const SWP_NOSIZE: u32 = 0x0001;
pub(crate) const SWP_NOMOVE: u32 = 0x0002;
pub(crate) const SWP_NOZORDER: u32 = 0x0004;
pub(crate) const SWP_NOACTIVATE: u32 = 0x0010;
pub(crate) const MONITOR_DEFAULTTONEAREST: u32 = 1;
pub(crate) const HWND_TOP: isize = 0;
pub(crate) const HWND_TOPMOST: isize = -1;
pub(crate) const HWND_NOTOPMOST: isize = -2;
pub(crate) const SWP_SHOWWINDOW: u32 = 0x0040;
pub(crate) const SWP_FRAMECHANGED: u32 = 0x0020;
pub(crate) const GWL_STYLE: i32 = -16;
pub(crate) const GWL_EXSTYLE: i32 = -20;
pub(crate) const GWLP_HWNDPARENT: i32 = -8;
pub(crate) const WS_CAPTION: u32 = 0x00C00000;
pub(crate) const WS_THICKFRAME: u32 = 0x00040000;
pub(crate) const WS_EX_APPWINDOW: u32 = 0x00040000;
pub(crate) const WS_VISIBLE: u32 = 0x10000000;

#[repr(C)]
pub(crate) struct WndClassExW {
    pub cb_size: u32,
    pub style: u32,
    pub lpfn_wnd_proc: unsafe extern "system" fn(isize, u32, usize, isize) -> isize,
    pub cb_cls_extra: i32,
    pub cb_wnd_extra: i32,
    pub h_instance: isize,
    pub h_icon: isize,
    pub h_cursor: isize,
    pub hbr_background: isize,
    pub lpsz_menu_name: *const u16,
    pub lpsz_class_name: *const u16,
    pub h_icon_sm: isize,
}

#[repr(C)]
pub(crate) struct Point {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
pub(crate) struct MonitorInfo {
    pub cb_size: u32,
    pub rc_monitor: Rect,
    pub rc_work: Rect,
    pub dw_flags: u32,
}

#[link(name = "user32")]
extern "system" {
    pub(crate) fn RegisterClassExW(lpwcx: *const WndClassExW) -> u16;
    pub(crate) fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: isize,
    ) -> isize;
    pub(crate) fn MoveWindow(hwnd: isize, x: i32, y: i32, w: i32, h: i32, repaint: i32) -> i32;
    pub(crate) fn ShowWindow(hwnd: isize, cmd_show: i32) -> i32;
    pub(crate) fn DestroyWindow(hwnd: isize) -> i32;
    pub(crate) fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    pub(crate) fn GetModuleHandleW(module_name: *const u16) -> isize;
    pub(crate) fn ClientToScreen(hwnd: isize, point: *mut Point) -> i32;
    pub(crate) fn SetWindowPos(
        hwnd: isize,
        hwnd_insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    pub(crate) fn MonitorFromWindow(hwnd: isize, dw_flags: u32) -> isize;
    pub(crate) fn GetMonitorInfoW(h_monitor: isize, lpmi: *mut MonitorInfo) -> i32;
    pub(crate) fn SetWindowLongPtrW(hwnd: isize, n_index: i32, dw_new_long: isize) -> isize;
    pub(crate) fn SetParent(child: isize, new_parent: isize) -> isize;
    pub(crate) fn GetWindowLongPtrW(hwnd: isize, n_index: i32) -> isize;
    pub(crate) fn GetWindowRect(hwnd: isize, lp_rect: *mut Rect) -> i32;
    pub(crate) fn GetClientRect(hwnd: isize, lp_rect: *mut Rect) -> i32;
    pub(crate) fn SetWindowTextW(hwnd: isize, lp_string: *const u16) -> i32;
    pub(crate) fn IsWindow(hwnd: isize) -> i32;
    pub(crate) fn IsWindowVisible(hwnd: isize) -> i32;
    pub(crate) fn IsIconic(hwnd: isize) -> i32;
    pub(crate) fn IsZoomed(hwnd: isize) -> i32;
    pub(crate) fn GetForegroundWindow() -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    pub(crate) fn CreateSolidBrush(color: u32) -> isize;
}

pub(crate) fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Window procedure: prevents focus stealing on click.
pub(crate) unsafe extern "system" fn wnd_proc(
    hwnd: isize,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    match msg {
        // La surface mpv ne doit pas voler les clics destinés aux contrôles React
        // superposés dans WebView2.
        WM_NCHITTEST => HTTRANSPARENT,
        WM_MOUSEACTIVATE => MA_NOACTIVATE,
        WM_CLOSE => {
            ShowWindow(hwnd, SW_HIDE);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Public helper so commands.rs can position the overlay window via Win32 API.
/// # Safety
/// Caller must pass a valid HWND.
pub unsafe fn set_window_pos_raw(
    hwnd: isize,
    hwnd_insert_after: isize,
    x: i32,
    y: i32,
    cx: i32,
    cy: i32,
    flags: u32,
) -> bool {
    SetWindowPos(hwnd, hwnd_insert_after, x, y, cx, cy, flags) != 0
}

/// Sets the owner window (GWLP_HWNDPARENT) for a top-level Win32 window.
/// # Safety
/// Caller must pass valid HWND values.
pub unsafe fn set_window_owner_raw(hwnd: isize, owner_hwnd: isize) {
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner_hwnd);
}

/// Make `hwnd` owned by `owner_hwnd` (0 to remove ownership), keeping it in the
/// taskbar via WS_EX_APPWINDOW. An owned window always floats above its owner
/// deterministically, so the notes/comments window stays above the main app
/// without global always-on-top and without the z-order flicker that a plain
/// top-level window shows when the mouse moves between windows.
/// # Safety
/// Caller must pass valid HWND values.
pub unsafe fn set_window_owned_taskbar(hwnd: isize, owner_hwnd: isize) {
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner_hwnd);
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_APPWINDOW) as isize);
    // HWND_NOTOPMOST (not HWND_TOP): re-assert the owner z-order and clear any
    // stale WS_EX_TOPMOST so the window is NEVER above other applications — it
    // only floats above its owner (the app / the video window).
    SetWindowPos(
        hwnd,
        HWND_NOTOPMOST,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
}

/// Returns the current foreground window HWND.
/// # Safety
/// Mirrors raw Win32 API usage.
pub unsafe fn get_foreground_window_raw() -> isize {
    GetForegroundWindow()
}
