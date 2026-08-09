use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Resolve an external tool (ffmpeg, ffprobe, mediainfo) by checking
/// exe-relative paths first (for Tauri bundled apps), then fallback to PATH.
pub(super) fn resolve_tool(name: &str) -> PathBuf {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("resources").join("windows").join(name),
                exe_dir.join("resources").join(name),
                exe_dir.join(name),
            ];
            for candidate in &candidates {
                if candidate.exists() {
                    return candidate.clone();
                }
            }
        }
    }
    PathBuf::from(name)
}

pub(super) fn configure_hidden_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}
