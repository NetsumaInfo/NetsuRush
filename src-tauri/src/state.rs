use crate::player::mpv_window::MpvChildWindow;
use crate::player::mpv_wrapper::MpvPlayer;
use std::sync::atomic::AtomicU64;
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
    /// Owner of the single mpv instance.
    ///
    /// There is ONE player for the whole app, but several surfaces can be mounted at once — in
    /// different panels and even in different windows, each with its own JavaScript context, so no
    /// renderer-side variable can arbitrate between them. Every surface takes a claim when it loads
    /// a file; the highest claim wins and the others must stop driving the player, otherwise the
    /// last one to react keeps its own media loaded under someone else's surface.
    pub player_claim: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            player: Mutex::new(None),
            child_window: Mutex::new(None),
            overlay_sync: Mutex::new(OverlaySyncState::default()),
            player_claim: AtomicU64::new(0),
        }
    }
}
