use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn build_minimal_media_info(path: &str) -> crate::player::mpv_wrapper::MediaInfo {
    let mut info = crate::player::mpv_wrapper::MediaInfo::empty();
    if let Ok(metadata) = std::fs::metadata(path) {
        info.file_size = i64::try_from(metadata.len()).unwrap_or(0);
    }
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
    {
        info.format_name = ext.to_ascii_lowercase();
    }
    info
}

fn probe_media_info_via_mediainfo(
    path: &str,
) -> Result<crate::player::mpv_wrapper::MediaInfo, String> {
    let mut command = Command::new(super::tools::resolve_tool("mediainfo.exe"));
    super::tools::configure_hidden_process(&mut command);
    let mut child = command
        .args(["--Output=JSON", path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("mediainfo indisponible: {}", e))?;

    let timeout = Duration::from_millis(2500);
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("mediainfo timeout (2.5s)".to_string());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                return Err(format!("mediainfo wait failed: {}", e));
            }
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("mediainfo output failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let root: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("mediainfo JSON invalide: {}", e))?;
    let tracks = root
        .get("media")
        .and_then(|m| m.get("track"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let get_type = |track: &Value| {
        track
            .get("@type")
            .or_else(|| track.get("Type"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    let general = tracks.iter().find(|t| get_type(t) == "general");
    let video = tracks.iter().find(|t| get_type(t) == "video");
    let audio = tracks.iter().find(|t| get_type(t) == "audio");

    let audio_track_count = tracks.iter().filter(|t| get_type(t) == "audio").count() as i64;
    let video_track_count = tracks.iter().filter(|t| get_type(t) == "video").count() as i64;
    let subtitle_track_count = tracks
        .iter()
        .filter(|t| {
            let kind = get_type(t);
            kind == "text" || kind == "subtitle" || kind == "subtitles"
        })
        .count() as i64;

    let mut duration = super::parsing::parse_json_f64(general.and_then(|g| g.get("Duration")));
    if duration > 10_000.0 {
        duration /= 1000.0;
    }

    Ok(crate::player::mpv_wrapper::MediaInfo {
        width: super::parsing::parse_json_i64(video.and_then(|v| v.get("Width"))),
        height: super::parsing::parse_json_i64(video.and_then(|v| v.get("Height"))),
        video_codec: {
            let codec = super::parsing::parse_json_string(video.and_then(|v| v.get("Format")));
            if codec.is_empty() {
                super::parsing::parse_json_string(video.and_then(|v| v.get("CodecID")))
            } else {
                codec
            }
        },
        audio_codec: {
            let codec = super::parsing::parse_json_string(audio.and_then(|a| a.get("Format")));
            if codec.is_empty() {
                super::parsing::parse_json_string(audio.and_then(|a| a.get("CodecID")))
            } else {
                codec
            }
        },
        file_size: super::parsing::parse_json_i64(general.and_then(|g| g.get("FileSize"))),
        video_bitrate: super::parsing::parse_json_i64(video.and_then(|v| v.get("BitRate"))),
        audio_bitrate: super::parsing::parse_json_i64(audio.and_then(|a| a.get("BitRate"))),
        fps: super::parsing::parse_json_f64(video.and_then(|v| v.get("FrameRate"))),
        sample_rate: super::parsing::parse_json_i64(audio.and_then(|a| a.get("SamplingRate"))),
        channels: super::parsing::parse_json_i64(audio.and_then(|a| a.get("Channels"))),
        format_name: super::parsing::parse_json_string(general.and_then(|g| g.get("Format"))),
        duration,
        format_long_name: {
            let name = super::parsing::parse_json_string(
                general.and_then(|g| g.get("Format_Commercial_IfAny")),
            );
            if name.is_empty() {
                super::parsing::parse_json_string(general.and_then(|g| g.get("Format_String")))
            } else {
                name
            }
        },
        overall_bitrate: super::parsing::parse_json_i64(
            general.and_then(|g| g.get("OverallBitRate")),
        ),
        video_profile: super::parsing::parse_json_string(
            video.and_then(|v| v.get("Format_Profile")),
        ),
        pixel_format: super::parsing::parse_json_string(
            video.and_then(|v| v.get("ChromaSubsampling")),
        ),
        color_space: super::parsing::parse_json_string(video.and_then(|v| v.get("ColorSpace"))),
        color_primaries: {
            let value =
                super::parsing::parse_json_string(video.and_then(|s| s.get("colour_primaries")));
            if value.is_empty() {
                super::parsing::parse_json_string(video.and_then(|s| s.get("ColorPrimaries")))
            } else {
                value
            }
        },
        color_transfer: {
            let value = super::parsing::parse_json_string(
                video.and_then(|s| s.get("transfer_characteristics")),
            );
            if value.is_empty() {
                super::parsing::parse_json_string(
                    video.and_then(|s| s.get("TransferCharacteristics")),
                )
            } else {
                value
            }
        },
        video_bit_depth: super::parsing::parse_json_i64(video.and_then(|v| v.get("BitDepth"))),
        audio_channel_layout: super::parsing::parse_json_string(
            audio.and_then(|a| a.get("ChannelLayout")),
        ),
        audio_language: super::parsing::parse_json_string(audio.and_then(|a| a.get("Language"))),
        audio_track_count,
        video_track_count,
        subtitle_track_count,
        video_frame_count: super::parsing::parse_json_i64(video.and_then(|v| v.get("FrameCount"))),
        sample_aspect_ratio: super::parsing::parse_json_string(
            video.and_then(|v| v.get("PixelAspectRatio")),
        ),
        display_aspect_ratio: super::parsing::parse_json_string(
            video.and_then(|v| v.get("DisplayAspectRatio")),
        ),
        rotation_degrees: {
            let raw = super::parsing::parse_json_i64(video.and_then(|v| v.get("Rotation")));
            let mut normalized = raw % 360;
            if normalized < 0 {
                normalized += 360;
            }
            normalized
        },
    })
}

pub(super) fn probe_media_info_open_source(
    path: &str,
) -> Result<crate::player::mpv_wrapper::MediaInfo, String> {
    match crate::player::mpv_wrapper::MpvPlayer::probe_media_info(path) {
        Ok(info) => Ok(info),
        Err(ffprobe_err) => probe_media_info_via_mediainfo(path).map_err(|mediainfo_err| {
            format!("ffprobe: {}; mediainfo: {}", ffprobe_err, mediainfo_err)
        }),
    }
}
