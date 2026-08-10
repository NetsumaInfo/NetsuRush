#![allow(dead_code)]
use super::mpv_ffi::*;
pub use super::mpv_types::{AudioLevels, MediaInfo, TrackInfo};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[path = "mpv_wrapper_media.rs"]
mod media;
#[path = "mpv_wrapper_properties.rs"]
mod properties;

pub struct MpvPlayer {
    lib: Arc<MpvLib>,
    handle: MpvHandle,
    initialized: AtomicBool,
    // Cached winning property-key indices for the audio level meter.
    // get_audio_levels() probes a list of fallback keys; the working one is
    // stable per session, so remembering it cuts each 16ms poll from up to
    // 21 FFI reads down to 3.
    pub(super) audio_key_left: AtomicUsize,
    pub(super) audio_key_right: AtomicUsize,
    pub(super) audio_key_left_peak: AtomicUsize,
    pub(super) audio_key_right_peak: AtomicUsize,
    pub(super) audio_key_overall: AtomicUsize,
}

unsafe impl Send for MpvPlayer {}
unsafe impl Sync for MpvPlayer {}

impl MpvPlayer {
    pub fn new(wid: Option<i64>) -> Result<Self, String> {
        let lib = Arc::new(MpvLib::load()?);

        let handle = unsafe { (lib.create)() };
        if handle.is_null() {
            return Err("Failed to create mpv instance".to_string());
        }

        // Configure mpv options before initialization
        let options = [
            ("keep-open", "yes"),
            ("idle", "yes"),
            ("osc", "no"),
            // mpv draws its own white OSD progress bar on every seek/volume
            // change. The app has its own overlay timeline, so disable mpv's OSD
            // entirely (bar + text) to stop that bar flashing when seeking.
            ("osd-bar", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("terminal", "no"),
            ("msg-level", "all=no"),
            // NOTE: the dB-meter `af` (astats) is intentionally NOT set here.
            // On the stripped FFmpeg build that filter fails to build for some
            // clips and mpv then disables audio output entirely (no sound).
            // The filter is now applied lazily via `set_audio_meter()` only when
            // the user enables the VU-mètre, so audio is never sacrificed by
            // default. See player_set_audio_meter command.
        ];

        for (key, value) in &options {
            let key_c = to_cstring(key);
            let value_c = to_cstring(value);
            unsafe {
                (lib.set_option_string)(handle, key_c.as_ptr(), value_c.as_ptr());
            }
        }

        // Set wid for embedded rendering, or force-window=no for headless
        if let Some(w) = wid {
            let key_c = to_cstring("wid");
            let value_c = to_cstring(&w.to_string());
            unsafe {
                (lib.set_option_string)(handle, key_c.as_ptr(), value_c.as_ptr());
            }
            eprintln!("[mpv] Embedding into window: wid={}", w);
        } else {
            let key_c = to_cstring("force-window");
            let value_c = to_cstring("no");
            unsafe {
                (lib.set_option_string)(handle, key_c.as_ptr(), value_c.as_ptr());
            }
        }

        let result = unsafe { (lib.initialize)(handle) };
        if result < 0 {
            unsafe { (lib.terminate_destroy)(handle) };
            return Err(format!("Failed to initialize mpv: error code {}", result));
        }

        // Observe key properties for updates
        let properties = [
            ("time-pos", MPV_FORMAT_DOUBLE),
            ("duration", MPV_FORMAT_DOUBLE),
            ("pause", MPV_FORMAT_FLAG),
            ("volume", MPV_FORMAT_DOUBLE),
            ("speed", MPV_FORMAT_DOUBLE),
            ("eof-reached", MPV_FORMAT_FLAG),
        ];

        for (i, (prop, format)) in properties.iter().enumerate() {
            let prop_c = to_cstring(prop);
            unsafe {
                (lib.observe_property)(handle, i as u64, prop_c.as_ptr(), *format);
            }
        }

        Ok(Self {
            lib,
            handle,
            initialized: AtomicBool::new(true),
            audio_key_left: AtomicUsize::new(usize::MAX),
            audio_key_right: AtomicUsize::new(usize::MAX),
            audio_key_left_peak: AtomicUsize::new(usize::MAX),
            audio_key_right_peak: AtomicUsize::new(usize::MAX),
            audio_key_overall: AtomicUsize::new(usize::MAX),
        })
    }

    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::Relaxed)
    }

    pub fn load_file(&self, path: &str) -> Result<(), String> {
        // No start position: clear any leftover `start` from a previous load_file_at.
        let _ = self.set_property_string("start", "none");
        let cmd = format!("loadfile \"{}\"", path.replace('\\', "/"));
        self.execute_command(&cmd)
    }

    /// Load a file and open it AT `position` seconds.
    ///
    /// `loadfile` is asynchronous: a `seek` issued right after it is applied to
    /// the file still loaded (or rejected outright), so the opening frame was
    /// never the requested one — the player showed a leftover frame and looked
    /// frozen. The `start` option is consumed by mpv when the new file is
    /// initialized, so the position is applied exactly once, without a race.
    pub fn load_file_at(&self, path: &str, position: f64) -> Result<(), String> {
        if position > 0.0 {
            self.set_property_string("start", &format!("{:.3}", position))?;
        } else {
            let _ = self.set_property_string("start", "none");
        }
        let cmd = format!("loadfile \"{}\"", path.replace('\\', "/"));
        self.execute_command(&cmd)
    }

    pub fn play(&self) -> Result<(), String> {
        self.set_property_flag("pause", false)
    }

    pub fn pause(&self) -> Result<(), String> {
        self.set_property_flag("pause", true)
    }

    pub fn toggle_pause(&self) -> Result<(), String> {
        let paused = self.get_property_flag("pause").unwrap_or(true);
        self.set_property_flag("pause", !paused)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.execute_command("stop")
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        // `exact` : sans lui mpv suit l'option `hr-seek` et peut s'arrêter sur l'image clé la plus
        // proche — inutilisable pour poser des bornes à l'image près.
        let cmd = format!("seek {} absolute+exact", position);
        self.execute_command(&cmd)
    }

    /// Force mpv to render the CURRENT frame again, without moving.
    ///
    /// Resizing the video output window drops the presented frame; while paused mpv has no next
    /// frame to draw, so the surface stays black until playback resumes. A null exact seek lands
    /// on the same frame and makes mpv render it.
    pub fn redraw(&self) -> Result<(), String> {
        self.execute_command("seek 0 relative+exact")
    }

    pub fn seek_relative(&self, offset: f64) -> Result<(), String> {
        let cmd = format!("seek {} relative", offset);
        self.execute_command(&cmd)
    }

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        self.set_property_double("volume", volume)
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.set_property_double("speed", speed)
    }

    pub fn set_loop_file(&self, enabled: bool) -> Result<(), String> {
        self.set_property_string("loop-file", if enabled { "inf" } else { "no" })
    }

    pub fn get_loop_file(&self) -> bool {
        let value = self.get_property_string_safe("loop-file");
        value == "inf" || value == "yes" || value.parse::<i64>().map(|n| n != 0).unwrap_or(false)
    }

    pub fn ab_loop_set_a(&self, time: f64) -> Result<(), String> {
        self.set_property_double("ab-loop-a", time)
    }

    pub fn ab_loop_set_b(&self, time: f64) -> Result<(), String> {
        self.set_property_double("ab-loop-b", time)
    }

    pub fn ab_loop_clear(&self) -> Result<(), String> {
        self.set_property_string("ab-loop-a", "no")?;
        self.set_property_string("ab-loop-b", "no")
    }

    pub fn get_ab_loop(&self) -> (Option<f64>, Option<f64>) {
        let parse = |raw: String| -> Option<f64> {
            if raw.is_empty() || raw == "no" {
                None
            } else {
                raw.parse::<f64>().ok()
            }
        };
        (
            parse(self.get_property_string_safe("ab-loop-a")),
            parse(self.get_property_string_safe("ab-loop-b")),
        )
    }

    /// Absolute path of the file mpv currently has loaded ("" when idle).
    pub fn get_loaded_path(&self) -> String {
        self.get_property_string_safe("path")
    }

    pub fn get_time_pos(&self) -> f64 {
        self.get_property_double("time-pos").unwrap_or(0.0)
    }

    pub fn get_duration(&self) -> f64 {
        self.get_property_double("duration").unwrap_or(0.0)
    }

    pub fn get_paused(&self) -> bool {
        self.get_property_flag("pause").unwrap_or(true)
    }

    pub fn get_volume(&self) -> f64 {
        self.get_property_double("volume").unwrap_or(100.0)
    }

    pub fn get_speed(&self) -> f64 {
        self.get_property_double("speed").unwrap_or(1.0)
    }

    pub fn set_wid(&self, wid: i64) -> Result<(), String> {
        self.set_property_string("wid", &wid.to_string())
    }

    /// Enable/disable the L/R dB meter audio filter (FFmpeg `astats`).
    ///
    /// Applied lazily instead of at init: on the stripped FFmpeg build this
    /// filter can fail to build for some clips, which makes mpv drop audio
    /// output entirely. Keeping it opt-in guarantees sound by default. The
    /// `af` property is global (persists across loadfiles), so one call is
    /// enough. An empty value clears the chain.
    pub fn set_audio_meter(&self, enabled: bool) -> Result<(), String> {
        let value = if enabled {
            "@dbmeter:lavfi=[astats=metadata=1:reset=1]"
        } else {
            ""
        };
        self.set_property_string("af", value)
    }
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        if self.initialized.load(Ordering::Relaxed) {
            unsafe {
                (self.lib.terminate_destroy)(self.handle);
            }
            self.initialized.store(false, Ordering::Relaxed);
        }
    }
}
