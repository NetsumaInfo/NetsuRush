use super::process_wait::{wait_with_output_timeout, WaitOutcome};
use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::Duration;

pub fn run_ffprobe(path: &str) -> Result<Value, String> {
    let mut command = Command::new(crate::player::commands::resolve_tool("ffprobe.exe"));
    crate::player::commands::configure_hidden_process(&mut command);
    let child = command
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffprobe indisponible: {}", e))?;

    let timeout = Duration::from_secs(4);
    let output = match wait_with_output_timeout(child, timeout) {
        WaitOutcome::Finished(output) => output,
        WaitOutcome::TimedOut => return Err("ffprobe timeout (4s)".to_string()),
        WaitOutcome::WaitFailed(e) => return Err(format!("ffprobe wait failed: {}", e)),
    };

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    serde_json::from_slice(&output.stdout).map_err(|e| format!("ffprobe JSON invalide: {}", e))
}
