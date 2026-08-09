use super::MpvPlayer;
use super::TrackInfo;
use super::{AudioLevels, MediaInfo};

impl MpvPlayer {
    pub fn set_subtitle_track(&self, id: Option<i64>) -> Result<(), String> {
        match id {
            Some(track_id) => self.set_property_string("sid", &track_id.to_string()),
            None => self.set_property_string("sid", "no"),
        }
    }

    pub fn set_audio_track(&self, id: i64) -> Result<(), String> {
        self.set_property_string("aid", &id.to_string())
    }

    pub fn get_track_list(&self) -> Vec<TrackInfo> {
        let count_str = self.get_property_string_safe("track-list/count");
        let count: i64 = count_str.parse().unwrap_or(0);

        let mut tracks = Vec::with_capacity(count.max(0) as usize);

        for i in 0..count {
            let prefix = format!("track-list/{}", i);

            let id_str = self.get_property_string_safe(&format!("{}/id", prefix));
            let id: i64 = id_str.parse().unwrap_or(0);

            let track_type = self.get_property_string_safe(&format!("{}/type", prefix));
            let title_raw = self.get_property_string_safe(&format!("{}/title", prefix));
            let title = if title_raw.is_empty() {
                None
            } else {
                Some(title_raw)
            };
            let lang_raw = self.get_property_string_safe(&format!("{}/lang", prefix));
            let lang = if lang_raw.is_empty() {
                None
            } else {
                Some(lang_raw)
            };
            let codec_raw = self.get_property_string_safe(&format!("{}/codec", prefix));
            let codec = if codec_raw.is_empty() {
                None
            } else {
                Some(codec_raw)
            };
            let external_str = self.get_property_string_safe(&format!("{}/external", prefix));
            let external = external_str == "yes";

            tracks.push(TrackInfo {
                id,
                track_type,
                title,
                lang,
                codec,
                external,
            });
        }

        tracks
    }

    pub fn frame_step(&self) -> Result<(), String> {
        self.execute_command("frame-step")
    }

    pub fn frame_back_step(&self) -> Result<(), String> {
        self.execute_command("frame-back-step")
    }

    pub fn screenshot(&self, path: &str) -> Result<(), String> {
        let cmd = format!("screenshot-to-file \"{}\" video", path.replace('\\', "/"));
        self.execute_command(&cmd)
    }

    pub fn get_media_info(&self) -> MediaInfo {
        let tracks = self.get_track_list();
        let audio_track_count = tracks.iter().filter(|t| t.track_type == "audio").count() as i64;
        let video_track_count = tracks.iter().filter(|t| t.track_type == "video").count() as i64;
        let subtitle_track_count = tracks
            .iter()
            .filter(|t| t.track_type == "sub" || t.track_type == "subtitle")
            .count() as i64;

        MediaInfo {
            width: self.get_property_string_safe("width").parse().unwrap_or(0),
            height: self.get_property_string_safe("height").parse().unwrap_or(0),
            video_codec: self.get_property_string_safe("video-codec"),
            audio_codec: self.get_property_string_safe("audio-codec-name"),
            file_size: self
                .get_property_string_safe("file-size")
                .parse()
                .unwrap_or(0),
            video_bitrate: self
                .get_property_string_safe("video-bitrate")
                .parse()
                .unwrap_or(0),
            audio_bitrate: self
                .get_property_string_safe("audio-bitrate")
                .parse()
                .unwrap_or(0),
            fps: self.get_property_double("container-fps").unwrap_or(0.0),
            sample_rate: self
                .get_property_string_safe("audio-params/samplerate")
                .parse()
                .unwrap_or(0),
            channels: self
                .get_property_string_safe("audio-params/channel-count")
                .parse()
                .unwrap_or(0),
            format_name: self.get_property_string_safe("file-format"),
            duration: self.get_duration(),
            format_long_name: String::new(),
            overall_bitrate: self
                .get_property_string_safe("video-bitrate")
                .parse()
                .unwrap_or(0)
                + self
                    .get_property_string_safe("audio-bitrate")
                    .parse()
                    .unwrap_or(0),
            video_profile: self.get_property_string_safe("video-params/profile"),
            pixel_format: self.get_property_string_safe("video-params/pixelformat"),
            color_space: self.get_property_string_safe("video-params/colormatrix"),
            color_primaries: self.get_property_string_safe("video-params/primaries"),
            color_transfer: self.get_property_string_safe("video-params/gamma"),
            video_bit_depth: self
                .get_property_string_safe("video-params/bit-depth")
                .parse()
                .unwrap_or(0),
            audio_channel_layout: self.get_property_string_safe("audio-params/channel-layout"),
            audio_language: String::new(),
            audio_track_count,
            video_track_count,
            subtitle_track_count,
            video_frame_count: 0,
            sample_aspect_ratio: self.get_property_string_safe("video-params/sar"),
            display_aspect_ratio: self.get_property_string_safe("video-params/dar"),
            rotation_degrees: self
                .get_property_string_safe("video-params/rotate")
                .parse()
                .unwrap_or(0),
        }
    }

    pub fn get_current_path(&self) -> String {
        self.get_property_string_safe("path")
    }

    pub fn get_audio_levels(&self) -> AudioLevels {
        fn parse_db(raw: &str) -> Option<f64> {
            let value = raw.trim();
            if value.is_empty() || value.eq_ignore_ascii_case("nan") {
                return None;
            }
            if value.eq_ignore_ascii_case("-inf") || value.eq_ignore_ascii_case("inf") {
                return Some(-90.0);
            }
            let normalized = value
                .replace("dB", "")
                .replace("db", "")
                .replace(',', ".")
                .trim()
                .to_string();
            let first_token = normalized.split_whitespace().next().unwrap_or("");
            first_token.parse::<f64>().ok()
        }

        use std::sync::atomic::{AtomicUsize, Ordering};

        // Try the cached winning key first; fall back to a full scan and
        // remember the new winner. Keeps the 16ms real-time meter cheap.
        fn first_available_db(
            player: &MpvPlayer,
            cache: &AtomicUsize,
            keys: &[&str],
        ) -> Option<f64> {
            let cached = cache.load(Ordering::Relaxed);
            if cached < keys.len() {
                if let Some(v) = parse_db(&player.get_property_string_safe(keys[cached])) {
                    return Some(v);
                }
            }
            for (i, key) in keys.iter().enumerate() {
                if i == cached {
                    continue;
                }
                if let Some(v) = parse_db(&player.get_property_string_safe(key)) {
                    cache.store(i, Ordering::Relaxed);
                    return Some(v);
                }
            }
            None
        }

        // RMS and Peak are read through separate caches: mixing both metric
        // kinds in one fallback list let a cached Peak key masquerade as RMS
        // (or vice versa), which made the displayed level wrong by several dB.
        let left = first_available_db(
            self,
            &self.audio_key_left,
            &[
                "af-metadata/dbmeter/by-key/lavfi.astats.1.RMS_level",
                "af-metadata/@dbmeter/by-key/lavfi.astats.1.RMS_level",
                "af-metadata/by-key/lavfi.astats.1.RMS_level",
            ],
        );

        let right = first_available_db(
            self,
            &self.audio_key_right,
            &[
                "af-metadata/dbmeter/by-key/lavfi.astats.2.RMS_level",
                "af-metadata/@dbmeter/by-key/lavfi.astats.2.RMS_level",
                "af-metadata/by-key/lavfi.astats.2.RMS_level",
            ],
        );

        let left_peak = first_available_db(
            self,
            &self.audio_key_left_peak,
            &[
                "af-metadata/dbmeter/by-key/lavfi.astats.1.Peak_level",
                "af-metadata/@dbmeter/by-key/lavfi.astats.1.Peak_level",
                "af-metadata/by-key/lavfi.astats.1.Peak_level",
            ],
        );

        let right_peak = first_available_db(
            self,
            &self.audio_key_right_peak,
            &[
                "af-metadata/dbmeter/by-key/lavfi.astats.2.Peak_level",
                "af-metadata/@dbmeter/by-key/lavfi.astats.2.Peak_level",
                "af-metadata/by-key/lavfi.astats.2.Peak_level",
            ],
        );

        let overall = first_available_db(
            self,
            &self.audio_key_overall,
            &[
                "af-metadata/dbmeter/by-key/lavfi.astats.Overall.RMS_level",
                "af-metadata/@dbmeter/by-key/lavfi.astats.Overall.RMS_level",
                "af-metadata/by-key/lavfi.astats.Overall.RMS_level",
                "af-metadata/dbmeter/by-key/lavfi.r128.M",
                "af-metadata/@dbmeter/by-key/lavfi.r128.M",
                "af-metadata/by-key/lavfi.r128.M",
            ],
        );

        let left_db = left.or(overall).unwrap_or(-90.0);
        let right_db = right.or(overall).unwrap_or(left_db);
        // Mono sources expose only channel 1: mirror its peak on the right.
        let left_peak_db = left_peak.unwrap_or(left_db);
        let right_peak_db = right_peak.or(left_peak).unwrap_or(right_db);
        let overall_db = overall.unwrap_or((left_db + right_db) * 0.5);

        AudioLevels {
            left_db,
            right_db,
            left_peak_db,
            right_peak_db,
            overall_db,
            available: left.is_some() || right.is_some() || overall.is_some(),
        }
    }

    pub fn probe_media_info(path: &str) -> Result<MediaInfo, String> {
        crate::player::mpv_probe::probe_media_info(path)
    }

    pub fn set_detached_controls_enabled(&self, enabled: bool) -> Result<(), String> {
        let flag = if enabled { "yes" } else { "no" };
        self.set_property_string("osc", flag)?;
        self.set_property_string("input-default-bindings", flag)?;
        Ok(())
    }
}
