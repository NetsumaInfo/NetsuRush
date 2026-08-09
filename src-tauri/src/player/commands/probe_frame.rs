use crate::player::mpv_probe::process_wait::{wait_with_output_timeout, WaitOutcome};
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use std::fs;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn probe_frame_preview_with_ffmpeg(
    path: &str,
    seconds: f64,
    width: u32,
) -> Result<String, String> {
    let safe_seconds = if seconds.is_finite() && seconds >= 0.0 {
        seconds
    } else {
        0.0
    };
    let safe_width = width.clamp(120, 640);
    let coarse_offset = (safe_seconds - 2.0).max(0.0);
    let fine_offset = safe_seconds - coarse_offset;
    let coarse_seek = format!("{:.3}", coarse_offset);
    let fine_seek = format!("{:.3}", fine_offset);
    let scale = format!("scale={}:-1:flags=lanczos", safe_width);

    let ffmpeg_bin = super::tools::resolve_tool("ffmpeg.exe");
    let mut command = Command::new(&ffmpeg_bin);
    super::tools::configure_hidden_process(&mut command);
    let child = command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-ss",
            &coarse_seek,
            "-i",
            path,
            "-ss",
            &fine_seek,
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            &scale,
            "-q:v",
            "2",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg indisponible ({}): {}", ffmpeg_bin.display(), e))?;

    let timeout = Duration::from_millis(3500);
    let output = match wait_with_output_timeout(child, timeout) {
        WaitOutcome::Finished(output) => output,
        WaitOutcome::TimedOut => return Err("ffmpeg timeout (3.5s)".to_string()),
        WaitOutcome::WaitFailed(e) => return Err(format!("ffmpeg wait failed: {}", e)),
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "ffmpeg a échoué à extraire le frame".to_string()
        } else {
            err
        });
    }

    if output.stdout.is_empty() {
        return Err("Aucune image extraite".to_string());
    }

    let b64 = BASE64_STD.encode(output.stdout);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

pub(super) fn probe_frame_preview_with_mpv(path: &str, seconds: f64) -> Result<String, String> {
    let safe_seconds = if seconds.is_finite() && seconds >= 0.0 {
        seconds
    } else {
        0.0
    };

    let preview_player = crate::player::mpv_wrapper::MpvPlayer::new(None)
        .map_err(|e| format!("mpv preview init impossible: {}", e))?;

    preview_player
        .load_file(path)
        .map_err(|e| format!("mpv preview load impossible: {}", e))?;
    let _ = preview_player.pause();

    let start_load = Instant::now();
    let mut load_backoff = Duration::from_millis(30);
    while start_load.elapsed() < Duration::from_millis(2200) {
        let loaded_path = super::parsing::normalize_path(&preview_player.get_current_path());
        let duration = preview_player.get_duration();
        if !loaded_path.is_empty() && duration.is_finite() && duration > 0.0 {
            break;
        }
        std::thread::sleep(load_backoff);
        load_backoff = (load_backoff * 2).min(Duration::from_millis(100));
    }

    preview_player
        .seek(safe_seconds)
        .map_err(|e| format!("mpv preview seek impossible: {}", e))?;
    let _ = preview_player.pause();
    std::thread::sleep(Duration::from_millis(120));

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = std::env::temp_dir().join(format!("amv-preview-{}.png", nonce));
    let tmp_path_str = tmp_path.to_string_lossy().to_string();

    preview_player
        .screenshot(&tmp_path_str)
        .map_err(|e| format!("mpv preview screenshot impossible: {}", e))?;

    let start_wait = Instant::now();
    let mut file_backoff = Duration::from_millis(25);
    while start_wait.elapsed() < Duration::from_millis(1200) {
        if let Ok(meta) = fs::metadata(&tmp_path) {
            if meta.len() > 0 {
                break;
            }
        }
        std::thread::sleep(file_backoff);
        file_backoff = (file_backoff * 2).min(Duration::from_millis(100));
    }

    let bytes = fs::read(&tmp_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("lecture preview impossible: {}", e)
    })?;
    let _ = fs::remove_file(&tmp_path);

    if bytes.is_empty() {
        return Err("preview vide".to_string());
    }

    let mime = if is_jpeg(&bytes) {
        "image/jpeg"
    } else {
        "image/png"
    };
    Ok(format!("data:{};base64,{}", mime, BASE64_STD.encode(bytes)))
}

fn is_jpeg(data: &[u8]) -> bool {
    data.len() > 3
        && data[0] == 0xFF
        && data[1] == 0xD8
        && data[data.len() - 2] == 0xFF
        && data[data.len() - 1] == 0xD9
}
