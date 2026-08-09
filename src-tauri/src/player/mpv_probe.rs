mod ffprobe;
mod media_info;
mod parsing;
pub(crate) mod process_wait;

use crate::player::mpv_wrapper::MediaInfo;
use ffprobe::run_ffprobe;
use media_info::media_info_from_probe;

pub fn probe_media_info(path: &str) -> Result<MediaInfo, String> {
    let root = run_ffprobe(path)?;
    Ok(media_info_from_probe(root))
}
