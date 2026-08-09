use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct MediaInfo {
    pub width: i64,
    pub height: i64,
    pub video_codec: String,
    pub audio_codec: String,
    pub file_size: i64,
    pub video_bitrate: i64,
    pub audio_bitrate: i64,
    pub fps: f64,
    pub sample_rate: i64,
    pub channels: i64,
    pub format_name: String,
    pub duration: f64,
    pub format_long_name: String,
    pub overall_bitrate: i64,
    pub video_profile: String,
    pub pixel_format: String,
    pub color_space: String,
    pub color_primaries: String,
    pub color_transfer: String,
    pub video_bit_depth: i64,
    pub audio_channel_layout: String,
    pub audio_language: String,
    pub audio_track_count: i64,
    pub video_track_count: i64,
    pub subtitle_track_count: i64,
    pub video_frame_count: i64,
    pub sample_aspect_ratio: String,
    pub display_aspect_ratio: String,
    pub rotation_degrees: i64,
}

impl MediaInfo {
    pub fn empty() -> Self {
        Self {
            width: 0,
            height: 0,
            video_codec: String::new(),
            audio_codec: String::new(),
            file_size: 0,
            video_bitrate: 0,
            audio_bitrate: 0,
            fps: 0.0,
            sample_rate: 0,
            channels: 0,
            format_name: String::new(),
            duration: 0.0,
            format_long_name: String::new(),
            overall_bitrate: 0,
            video_profile: String::new(),
            pixel_format: String::new(),
            color_space: String::new(),
            color_primaries: String::new(),
            color_transfer: String::new(),
            video_bit_depth: 0,
            audio_channel_layout: String::new(),
            audio_language: String::new(),
            audio_track_count: 0,
            video_track_count: 0,
            subtitle_track_count: 0,
            video_frame_count: 0,
            sample_aspect_ratio: String::new(),
            display_aspect_ratio: String::new(),
            rotation_degrees: 0,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct TrackInfo {
    pub id: i64,
    pub track_type: String,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub codec: Option<String>,
    pub external: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioLevels {
    pub left_db: f64,
    pub right_db: f64,
    pub left_peak_db: f64,
    pub right_peak_db: f64,
    pub overall_db: f64,
    pub available: bool,
}
