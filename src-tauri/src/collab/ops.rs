use serde::{Deserialize, Serialize};

use super::error::CollabError;

pub const OP_PROTOCOL_VERSION: u32 = 1;

const MAX_ID_LEN: usize = 128;
const MAX_TEXT_LEN: usize = 1_000_000;
const MAX_SHORT_TEXT_LEN: usize = 8_192;
const MAX_URL_LEN: usize = 8_192;
const MAX_ARRAY_LEN: usize = 100_000;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ItemId(String);

impl ItemId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn validate(&self) -> Result<(), CollabError> {
        validate_id("item id", &self.0)
    }
}

impl From<&str> for ItemId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for ItemId {
    fn from(value: String) -> Self {
        Self(value)
    }
}


#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Image,
    Video,
    Youtube,
    Embed,
    Text,
    Frame,
    Draw,
    Sequence,
    Palette,
}


#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Crop {
    fn validate(&self) -> Result<(), CollabError> {
        unit("crop.x", self.x)?;
        unit("crop.y", self.y)?;
        unit_positive("crop.width", self.width)?;
        unit_positive("crop.height", self.height)?;
        if self.x + self.width > 1.0 + f64::EPSILON || self.y + self.height > 1.0 + f64::EPSILON {
            return Err(CollabError::validation("crop exceeds source bounds"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trim {
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

impl Trim {
    fn validate(&self) -> Result<(), CollabError> {
        non_negative_finite("trim.start", self.start)?;
        non_negative_finite("trim.end", self.end)?;
        if self.end < self.start {
            return Err(CollabError::validation("trim end precedes start"));
        }
        if let Some(duration) = self.duration {
            non_negative_finite("trim.duration", duration)?;
            if self.end > duration + f64::EPSILON {
                return Err(CollabError::validation("trim exceeds media duration"));
            }
        }
        Ok(())
    }
}


#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAsset {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube_id: Option<String>,
    pub display_name: String,
    pub mime: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Small JPEG rendition of the original, stored as its own blob. Peers fetch it first, so a
    /// heavy original shows SOMETHING within one small transfer instead of a placeholder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_size: Option<u64>,
}

/// A preview is a thumbnail, not a second media: anything past this is refused so a writer cannot
/// smuggle a full-size file under the label.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

impl MediaAsset {
    pub fn validate(&self) -> Result<(), CollabError> {
        match (&self.content_hash, &self.remote_url, &self.youtube_id) {
            (Some(hash), None, None) => validate_hash(hash)?,
            (None, Some(url), None) => validate_remote_url(url)?,
            (None, None, Some(id)) => validate_youtube_id(id)?,
            _ => {
                return Err(CollabError::validation(
                    "media asset needs exactly one hash, remote URL, or YouTube id",
                ))
            }
        }
        match (&self.preview_hash, self.preview_size) {
            (None, None) => {}
            (Some(hash), Some(size)) => {
                if self.content_hash.is_none() {
                    return Err(CollabError::validation(
                        "a preview only accompanies a hashed media",
                    ));
                }
                validate_hash(hash)?;
                if size == 0 || size > MAX_PREVIEW_BYTES {
                    return Err(CollabError::validation("invalid media preview size"));
                }
            }
            _ => {
                return Err(CollabError::validation(
                    "a media preview needs both its hash and its size",
                ))
            }
        }
        validate_text("media.displayName", &self.display_name, 1024)?;
        validate_mime(&self.mime)?;
        if self.size > i64::MAX as u64 {
            return Err(CollabError::validation("media is too large"));
        }
        if let Some(source_url) = &self.source_url {
            validate_remote_url(source_url)?;
        }
        Ok(())
    }
}

pub(crate) fn validate_mime(value: &str) -> Result<(), CollabError> {
    validate_text("media.mime", value, 255)?;
    let mut parts = value.split('/');
    let valid_token = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-' | b'*'
                    )
            })
    };
    if !parts.next().is_some_and(valid_token)
        || !parts.next().is_some_and(valid_token)
        || parts.next().is_some()
    {
        return Err(CollabError::validation("invalid media MIME type"));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaVariant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ItemKind>,
    pub asset: MediaAsset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim: Option<Trim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_height: Option<f64>,
}

impl MediaVariant {
    fn validate(&self) -> Result<(), CollabError> {
        self.asset.validate()?;
        if let Some(trim) = &self.trim {
            trim.validate()?;
        }
        if let Some(crop) = &self.crop {
            crop.validate()?;
        }
        optional_positive_finite("media.naturalWidth", self.natural_width)?;
        optional_positive_finite("media.naturalHeight", self.natural_height)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaManifest {
    pub primary: MediaAsset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<MediaVariant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<MediaVariant>,
}

impl MediaManifest {
    pub fn validate(&self) -> Result<(), CollabError> {
        self.primary.validate()?;
        if let Some(previous) = &self.previous {
            previous.validate()?;
        }
        if let Some(local) = &self.local {
            local.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CollabOp {
    SurfaceRestoreEntry { entry_id: ItemId },
    SurfaceSetEntry { entry_id: ItemId, kind: SurfaceEntryKind, fields: std::collections::BTreeMap<String, serde_json::Value> },
    SurfaceDeleteEntry { entry_id: ItemId },
    SurfaceTextInsert { entry_id: ItemId, field: String, index: u32, text: String },
    SurfaceTextFormat { entry_id: ItemId, field: String, start: u32, end: u32, style: String, value: Option<String> },
    SurfaceTextDelete { entry_id: ItemId, field: String, index: u32, length: u32 },
    SurfaceSetMedia { entry_id: ItemId, field: String, manifest: Option<Box<MediaManifest>> },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SurfaceEntryKind { Notebook, Page, Block, Database, Collection, CollectionItem }

fn validate_surface_fields(fields: &std::collections::BTreeMap<String, serde_json::Value>) -> Result<(), CollabError> {
    fn value(v: &serde_json::Value, depth: usize) -> Result<(), CollabError> {
        if depth > 32 { return Err(CollabError::validation("surface field nesting exceeds limit")); }
        match v {
            serde_json::Value::Object(map) => for (key, child) in map { validate_id("surface key", key)?; value(child, depth + 1)?; },
            serde_json::Value::Array(array) => { validate_count("surface array", array.len(), MAX_ARRAY_LEN)?; for child in array { value(child, depth + 1)?; } },
            serde_json::Value::String(text) => validate_text("surface value", text, MAX_TEXT_LEN)?,
            _ => (),
        }
        Ok(())
    }
    validate_count("surface fields", fields.len(), 256)?;
    for (key, child) in fields { validate_id("surface field", key)?; value(child, 0)?; }
    if serde_json::to_vec(fields).map_err(|_| CollabError::validation("invalid surface fields"))?.len() > 2 * MAX_TEXT_LEN { return Err(CollabError::validation("surface entry too large")); }
    Ok(())
}

impl CollabOp {
    pub fn validate(&self) -> Result<(), CollabError> {
        match self {
            Self::SurfaceRestoreEntry { entry_id } => entry_id.validate(),
            Self::SurfaceSetEntry { entry_id, fields, .. } => { entry_id.validate()?; validate_surface_fields(fields) }
            Self::SurfaceDeleteEntry { entry_id } => entry_id.validate(),
            Self::SurfaceTextInsert { entry_id, field, text, .. } => { entry_id.validate()?; validate_id("text field", field)?; validate_text("inserted text", text, MAX_TEXT_LEN) }
            Self::SurfaceTextFormat { entry_id, field, start, end, style, value } => {
                entry_id.validate()?; validate_id("text field", field)?;
                if start >= end || !["bold", "italic", "underline", "strike", "code", "textColor", "backgroundColor", "link", "inline"].contains(&style.as_str()) { return Err(CollabError::validation("invalid surface text format")); }
                if let Some(value) = value { validate_text("text format", value, MAX_SHORT_TEXT_LEN)?; }
                Ok(())
            }
            Self::SurfaceTextDelete { entry_id, field, .. } => { entry_id.validate()?; validate_id("text field", field) }
            Self::SurfaceSetMedia { entry_id, field, manifest } => { entry_id.validate()?; validate_id("media field", field)?; if let Some(manifest) = manifest { manifest.validate()?; } Ok(()) }
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationBatch {
    pub protocol: u32,
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub ops: Vec<CollabOp>,
}

impl OperationBatch {
    pub fn v1(ops: Vec<CollabOp>) -> Self {
        Self {
            protocol: OP_PROTOCOL_VERSION,
            base_revision: None,
            ops,
        }
    }

    pub fn validate(&self) -> Result<(), CollabError> {
        if self.protocol != OP_PROTOCOL_VERSION {
            return Err(CollabError::validation("unsupported operation protocol"));
        }
        if self.ops.is_empty() || self.ops.len() > 10_000 {
            return Err(CollabError::validation("invalid operation batch size"));
        }
        for operation in &self.ops {
            operation.validate()?;
        }
        Ok(())
    }
}

fn validate_id(label: &str, value: &str) -> Result<(), CollabError> {
    if value.is_empty()
        || value.len() > MAX_ID_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(CollabError::validation(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), CollabError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CollabError::validation("invalid media content hash"));
    }
    Ok(())
}

fn validate_remote_url(value: &str) -> Result<(), CollabError> {
    validate_text("remote URL", value, MAX_URL_LEN)?;
    let lower = value.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(CollabError::validation("unsupported remote URL scheme"));
    }
    if value.chars().any(char::is_control) {
        return Err(CollabError::validation("invalid remote URL"));
    }
    Ok(())
}

fn validate_youtube_id(value: &str) -> Result<(), CollabError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(CollabError::validation("invalid YouTube id"));
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max: usize) -> Result<(), CollabError> {
    if value.len() > max || value.chars().any(|character| character == '\0') {
        return Err(CollabError::validation(format!("invalid {label}")));
    }
    Ok(())
}


fn validate_count(label: &str, count: usize, max: usize) -> Result<(), CollabError> {
    if count > max {
        return Err(CollabError::validation(format!("too many {label}")));
    }
    Ok(())
}


fn finite(label: &str, value: f64) -> Result<(), CollabError> {
    if !value.is_finite() {
        return Err(CollabError::validation(format!("{label} is not finite")));
    }
    Ok(())
}

fn positive_finite(label: &str, value: f64) -> Result<(), CollabError> {
    finite(label, value)?;
    if value <= 0.0 {
        return Err(CollabError::validation(format!("{label} must be positive")));
    }
    Ok(())
}

fn optional_positive_finite(label: &str, value: Option<f64>) -> Result<(), CollabError> {
    if let Some(value) = value {
        positive_finite(label, value)?;
    }
    Ok(())
}

fn non_negative_finite(label: &str, value: f64) -> Result<(), CollabError> {
    finite(label, value)?;
    if value < 0.0 {
        return Err(CollabError::validation(format!(
            "{label} must not be negative"
        )));
    }
    Ok(())
}


fn unit(label: &str, value: f64) -> Result<(), CollabError> {
    finite(label, value)?;
    if !(0.0..=1.0).contains(&value) {
        return Err(CollabError::validation(format!("{label} is outside 0..1")));
    }
    Ok(())
}

fn unit_positive(label: &str, value: f64) -> Result<(), CollabError> {
    unit(label, value)?;
    if value == 0.0 {
        return Err(CollabError::validation(format!("{label} must be positive")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_mime, CollabOp, Crop, MediaAsset, MediaManifest, MediaVariant, OperationBatch};

    fn hashed_asset() -> MediaAsset {
        MediaAsset {
            content_hash: Some("a".repeat(64)),
            remote_url: None,
            youtube_id: None,
            display_name: "clip.mp4".into(),
            mime: "video/mp4".into(),
            size: 1024,
            source_url: None,
            preview_hash: None,
            preview_size: None,
        }
    }

    #[test]
    fn rejects_an_invalid_variant_crop() {
        let manifest = MediaManifest {
            primary: hashed_asset(),
            previous: Some(MediaVariant {
                kind: None,
                asset: hashed_asset(),
                trim: None,
                crop: Some(Crop { x: 0.9, y: 0.0, width: 0.2, height: 1.0 }),
                natural_width: None,
                natural_height: None,
            }),
            local: None,
        };
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn media_manifests_never_accept_sender_file_paths() {
        let mut primary = hashed_asset();
        primary.content_hash = None;
        primary.remote_url = Some(r#"C:\Users\Alice\secret.mov"#.into());
        let manifest = MediaManifest { primary, previous: None, local: None };
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn media_previews_require_hash_size_and_a_hashed_original() {
        let asset = |preview_hash: Option<&str>, preview_size: Option<u64>| MediaAsset {
            preview_hash: preview_hash.map(str::to_owned),
            preview_size,
            ..hashed_asset()
        };
        let hash = "b".repeat(64);
        assert!(asset(Some(&hash), Some(48_000)).validate().is_ok());
        assert!(asset(Some(&hash), None).validate().is_err());
        assert!(asset(None, Some(48_000)).validate().is_err());
        assert!(asset(Some("nope"), Some(48_000)).validate().is_err());
        assert!(asset(Some(&hash), Some(0)).validate().is_err());
        assert!(asset(Some(&hash), Some(64 * 1024 * 1024)).validate().is_err());
        let mut remote = asset(Some(&hash), Some(48_000));
        remote.content_hash = None;
        remote.remote_url = Some("https://example.com/clip.mp4".into());
        assert!(remote.validate().is_err());
    }

    #[test]
    fn mime_types_cannot_inject_native_response_headers() {
        assert!(validate_mime("image/png").is_ok());
        assert!(validate_mime("video/*").is_ok());
        assert!(validate_mime("image/png\r\nX-Evil: yes").is_err());
        assert!(validate_mime("image/png\u{7}").is_err());
        assert!(validate_mime("image/png/extra").is_err());
    }

    #[test]
    fn operation_wire_format_is_camel_case_and_versioned() {
        let batch = OperationBatch::v1(vec![CollabOp::SurfaceDeleteEntry { entry_id: "a".into() }]);
        let json = serde_json::to_value(batch).expect("serialize batch");
        assert_eq!(json["protocol"], 1);
        assert_eq!(json["ops"][0]["type"], "surfaceDeleteEntry");
        assert_eq!(json["ops"][0]["entryId"], "a");
    }
}
