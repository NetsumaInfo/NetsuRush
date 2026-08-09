use crate::player::mpv_window::MpvChildWindow;
use crate::player::mpv_wrapper::MpvPlayer;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OverlaySyncState {
    pub visible: bool,
    pub detached: bool,
    pub fullscreen: bool,
    pub rect: Option<(i32, i32, i32, i32)>,
}

pub struct AppState {
    pub player: Mutex<Option<MpvPlayer>>,
    pub child_window: Mutex<Option<MpvChildWindow>>,
    pub overlay_sync: Mutex<OverlaySyncState>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            player: Mutex::new(None),
            child_window: Mutex::new(None),
            overlay_sync: Mutex::new(OverlaySyncState::default()),
        }
    }
}
