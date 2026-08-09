use super::MpvChildWindow;
use crate::player::mpv_win32::*;

impl MpvChildWindow {
    pub fn show(&self) {
        if !self.is_valid_window() {
            return;
        }
        unsafe {
            if self.is_detached() {
                // Detached window should come to front when explicitly shown,
                // but must not stay top-most globally.
                SetWindowPos(
                    self.hwnd,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            } else {
                // Le WebView2 est lui aussi un enfant Win32. Réaffirmer la position en tête de
                // l'ordre des enfants est indispensable : sinon il peut rester au-dessus de mpv
                // et la surface React affiche uniquement son fond noir. HTTRANSPARENT dans
                // mpv_win32.rs laisse ensuite les contrôles WebView2 recevoir les clics.
                SetWindowPos(
                    self.hwnd,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
    }

    pub fn hide(&self) {
        if !self.is_valid_window() {
            return;
        }
        unsafe {
            ShowWindow(self.hwnd, SW_HIDE);
        }
    }

    /// Minimize the detached player to the taskbar (native — button). No-op
    /// unless detached and windowed. The controls overlay is owned by this
    /// window so Windows hides it along with the player.
    pub fn minimize_detached(&self) {
        if !self.is_valid_window() || !self.is_detached() || self.is_fullscreen() {
            return;
        }
        unsafe {
            ShowWindow(self.hwnd, SW_MINIMIZE);
        }
    }

    /// True when the window is minimized (iconic). Used so the overlay sync
    /// does not resurrect the controls while the player sits in the taskbar.
    pub fn is_minimized(&self) -> bool {
        if !self.is_valid_window() {
            return false;
        }
        unsafe { IsIconic(self.hwnd) != 0 }
    }

    pub fn is_fullscreen(&self) -> bool {
        self.is_fullscreen
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn is_detached(&self) -> bool {
        self.is_detached.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn is_visible(&self) -> bool {
        if !self.is_valid_window() {
            return false;
        }
        unsafe { IsWindowVisible(self.hwnd) != 0 }
    }
}
