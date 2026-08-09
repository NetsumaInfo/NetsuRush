pub(super) fn build_minimal_media_info(path: &str) -> crate::player::mpv_wrapper::MediaInfo {
    super::probe_media::build_minimal_media_info(path)
}

pub(super) fn probe_media_info_open_source(
    path: &str,
) -> Result<crate::player::mpv_wrapper::MediaInfo, String> {
    super::probe_media::probe_media_info_open_source(path)
}

pub(super) fn probe_frame_preview_with_ffmpeg(
    path: &str,
    seconds: f64,
    width: u32,
) -> Result<String, String> {
    super::probe_frame::probe_frame_preview_with_ffmpeg(path, seconds, width)
}

pub(super) fn probe_frame_preview_with_mpv(path: &str, seconds: f64) -> Result<String, String> {
    super::probe_frame::probe_frame_preview_with_mpv(path, seconds)
}
