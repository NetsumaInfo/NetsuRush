use crate::player::mpv_probe::parsing::{
    infer_bit_depth_from_pix_fmt, parse_f64, parse_i64, parse_ratio, parse_str, parse_stream_i64,
    parse_stream_str, parse_stream_tag_i64,
};
use crate::player::mpv_wrapper::MediaInfo;
use serde_json::Value;

fn normalize_rotation(raw: i64) -> i64 {
    let mut normalized = raw % 360;
    if normalized < 0 {
        normalized += 360;
    }
    normalized
}

fn parse_rotation_degrees(video_stream: Option<&Value>) -> i64 {
    let direct = parse_stream_i64(video_stream, "rotation");
    if direct != 0 {
        return normalize_rotation(direct);
    }

    let from_tag = parse_i64(
        video_stream
            .and_then(|stream| stream.get("tags"))
            .and_then(|tags| tags.get("rotate")),
    );
    if from_tag != 0 {
        return normalize_rotation(from_tag);
    }

    if let Some(side_data_list) = video_stream
        .and_then(|stream| stream.get("side_data_list"))
        .and_then(|side_data| side_data.as_array())
    {
        for side_data in side_data_list {
            let side_rotation = parse_i64(side_data.get("rotation"));
            if side_rotation != 0 {
                return normalize_rotation(side_rotation);
            }
        }
    }

    0
}

pub fn media_info_from_probe(root: Value) -> MediaInfo {
    let streams = root
        .get("streams")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let format = root
        .get("format")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let video_stream = streams.iter().find(|stream| {
        stream
            .get("codec_type")
            .and_then(|v| v.as_str())
            .map(|kind| kind == "video")
            .unwrap_or(false)
    });
    let audio_stream = streams.iter().find(|stream| {
        stream
            .get("codec_type")
            .and_then(|v| v.as_str())
            .map(|kind| kind == "audio")
            .unwrap_or(false)
    });
    let subtitle_track_count = streams
        .iter()
        .filter(|stream| {
            stream
                .get("codec_type")
                .and_then(|v| v.as_str())
                .map(|kind| kind == "subtitle" || kind == "sub")
                .unwrap_or(false)
        })
        .count() as i64;
    let audio_track_count = streams
        .iter()
        .filter(|stream| {
            stream
                .get("codec_type")
                .and_then(|v| v.as_str())
                .map(|kind| kind == "audio")
                .unwrap_or(false)
        })
        .count() as i64;
    let video_track_count = streams
        .iter()
        .filter(|stream| {
            stream
                .get("codec_type")
                .and_then(|v| v.as_str())
                .map(|kind| kind == "video")
                .unwrap_or(false)
        })
        .count() as i64;

    let width = video_stream
        .and_then(|stream| stream.get("width"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let height = video_stream
        .and_then(|stream| stream.get("height"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let video_codec = video_stream
        .and_then(|stream| stream.get("codec_name"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let audio_codec = audio_stream
        .and_then(|stream| stream.get("codec_name"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let mut video_bitrate = parse_stream_i64(video_stream, "bit_rate");
    if video_bitrate <= 0 {
        video_bitrate = parse_stream_tag_i64(video_stream, "BPS");
    }
    if video_bitrate <= 0 {
        video_bitrate = parse_stream_tag_i64(video_stream, "BPS-eng");
    }

    let mut audio_bitrate = parse_stream_i64(audio_stream, "bit_rate");
    if audio_bitrate <= 0 {
        audio_bitrate = parse_stream_tag_i64(audio_stream, "BPS");
    }
    if audio_bitrate <= 0 {
        audio_bitrate = parse_stream_tag_i64(audio_stream, "BPS-eng");
    }

    let fps = video_stream
        .and_then(|stream| stream.get("avg_frame_rate"))
        .and_then(|v| v.as_str())
        .map(parse_ratio)
        .filter(|v| *v > 0.0)
        .or_else(|| {
            video_stream
                .and_then(|stream| stream.get("r_frame_rate"))
                .and_then(|v| v.as_str())
                .map(parse_ratio)
                .filter(|v| *v > 0.0)
        })
        .unwrap_or_else(|| parse_f64(video_stream.and_then(|s| s.get("fps"))));

    let sample_rate = parse_stream_i64(audio_stream, "sample_rate");
    let channels = audio_stream
        .and_then(|stream| stream.get("channels"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let audio_channel_layout = audio_stream
        .and_then(|stream| stream.get("channel_layout"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let audio_language = audio_stream
        .and_then(|stream| stream.get("tags"))
        .and_then(|tags| tags.get("language"))
        .and_then(|v| v.as_str())
        .filter(|lang| !lang.eq_ignore_ascii_case("und"))
        .unwrap_or_default()
        .to_string();
    let video_profile = parse_stream_str(video_stream, "profile");
    let pixel_format = parse_stream_str(video_stream, "pix_fmt");
    let color_space = parse_stream_str(video_stream, "color_space");
    let color_primaries = parse_stream_str(video_stream, "color_primaries");
    let color_transfer = parse_stream_str(video_stream, "color_transfer");
    let video_bit_depth = video_stream
        .and_then(|stream| {
            stream
                .get("bits_per_raw_sample")
                .or_else(|| stream.get("bits_per_sample"))
        })
        .map(|v| parse_i64(Some(v)))
        .unwrap_or(0);
    let video_frame_count = {
        let nb_frames = parse_stream_i64(video_stream, "nb_frames");
        if nb_frames > 0 {
            nb_frames
        } else {
            parse_stream_i64(video_stream, "nb_read_frames")
        }
    };
    let sample_aspect_ratio = parse_stream_str(video_stream, "sample_aspect_ratio");
    let display_aspect_ratio = parse_stream_str(video_stream, "display_aspect_ratio");
    let rotation_degrees = parse_rotation_degrees(video_stream);

    let format_name = parse_str(format.get("format_name"));
    let format_long_name = parse_str(format.get("format_long_name"));
    let file_size = parse_i64(format.get("size"));
    let mut overall_bitrate = parse_i64(format.get("bit_rate"));
    if overall_bitrate <= 0 {
        overall_bitrate = video_bitrate.saturating_add(audio_bitrate);
    }
    let duration = {
        let d = parse_f64(format.get("duration"));
        if d > 0.0 {
            d
        } else {
            let v = parse_f64(video_stream.and_then(|s| s.get("duration")));
            if v > 0.0 {
                v
            } else {
                parse_f64(audio_stream.and_then(|s| s.get("duration")))
            }
        }
    };

    let video_frame_count = if video_frame_count > 0 {
        video_frame_count
    } else if fps > 0.0 && duration > 0.0 {
        (fps * duration).round() as i64
    } else {
        0
    };

    let video_bit_depth = if video_bit_depth > 0 {
        video_bit_depth
    } else {
        infer_bit_depth_from_pix_fmt(&pixel_format)
    };

    MediaInfo {
        width,
        height,
        video_codec,
        audio_codec,
        file_size,
        video_bitrate,
        audio_bitrate,
        fps,
        sample_rate,
        channels,
        format_name,
        duration,
        format_long_name,
        overall_bitrate,
        video_profile,
        pixel_format,
        color_space,
        color_primaries,
        color_transfer,
        video_bit_depth,
        audio_channel_layout,
        audio_language,
        audio_track_count,
        video_track_count,
        subtitle_track_count,
        video_frame_count,
        sample_aspect_ratio,
        display_aspect_ratio,
        rotation_degrees,
    }
}
