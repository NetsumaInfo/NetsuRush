use serde::{Deserialize, Serialize};

use super::error::CollabError;

pub const OP_PROTOCOL_VERSION: u32 = 1;

const MAX_ID_LEN: usize = 128;
const MAX_TEXT_LEN: usize = 1_000_000;
const MAX_SHORT_TEXT_LEN: usize = 8_192;
const MAX_URL_LEN: usize = 8_192;
const MAX_ARRAY_LEN: usize = 100_000;
const MAX_STROKE_BYTES: usize = 16 * 1024 * 1024;

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

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ShapeId(String);

impl ShapeId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn validate(&self) -> Result<(), CollabError> {
        validate_id("shape id", &self.0)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct StrokeId(String);

impl StrokeId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn validate(&self) -> Result<(), CollabError> {
        validate_id("stroke id", &self.0)
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
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_height: Option<f64>,
    #[serde(default)]
    pub detached: bool,
}

impl Geometry {
    fn validate(&self) -> Result<(), CollabError> {
        finite("geometry.x", self.x)?;
        finite("geometry.y", self.y)?;
        positive_finite("geometry.width", self.width)?;
        positive_finite("geometry.height", self.height)?;
        finite("geometry.rotation", self.rotation)?;
        optional_positive_finite("geometry.naturalWidth", self.natural_width)?;
        optional_positive_finite("geometry.naturalHeight", self.natural_height)
    }
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

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Appearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub flip_horizontal: bool,
    #[serde(default)]
    pub flip_vertical: bool,
}

impl Appearance {
    fn validate(&self) -> Result<(), CollabError> {
        optional_text("appearance.title", &self.title, MAX_SHORT_TEXT_LEN)?;
        if let Some(opacity) = self.opacity {
            unit("appearance.opacity", opacity)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent: Option<u16>,
    #[serde(default)]
    pub bullet: bool,
    #[serde(default)]
    pub numbered: bool,
    #[serde(default)]
    pub strike: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<TextAlign>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
}

impl TextStyle {
    fn validate(&self) -> Result<(), CollabError> {
        optional_positive_finite("textStyle.fontSize", self.font_size)?;
        optional_text("textStyle.fontFamily", &self.font_family, 512)?;
        optional_text("textStyle.color", &self.color, 128)?;
        optional_text("textStyle.background", &self.background, 128)?;
        optional_text("textStyle.highlight", &self.highlight, 128)?;
        optional_positive_finite("textStyle.lineHeight", self.line_height)?;
        if self.indent.unwrap_or_default() > 100 {
            return Err(CollabError::validation("text indent is too large"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FillMode {
    None,
    Tint,
    Solid,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_mode: Option<FillMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_background: Option<String>,
}

impl FrameStyle {
    fn validate(&self) -> Result<(), CollabError> {
        optional_text("frame.fillColor", &self.fill_color, 128)?;
        optional_text("frame.titleBackground", &self.title_background, 128)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode {
    Loop,
    Pingpong,
    Off,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playback {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub play_mode: Option<PlayMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default)]
    pub sequence_playing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_in: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_out: Option<u32>,
}

impl Playback {
    fn validate(&self) -> Result<(), CollabError> {
        optional_positive_finite("playback.fps", self.fps)?;
        optional_positive_finite("playback.speed", self.speed)?;
        if let (Some(start), Some(end)) = (self.sequence_in, self.sequence_out) {
            if end < start {
                return Err(CollabError::validation("sequence end precedes start"));
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Url,
    File,
    Item,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkMetadata {
    pub kind: LinkKind,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl LinkMetadata {
    fn validate(&self) -> Result<(), CollabError> {
        match self.kind {
            LinkKind::Url => validate_remote_url(&self.target)?,
            LinkKind::File => validate_hash(&self.target)?,
            LinkKind::Item => validate_id("link target", &self.target)?,
        }
        optional_text("link.label", &self.label, 1024)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbedLevel {
    Link,
    Preview,
    Margin,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbedQuality {
    Eco,
    Standard,
    High,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbedMetadata {
    pub level: EmbedLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<EmbedQuality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_seconds: Option<f64>,
}

impl EmbedMetadata {
    fn validate(&self) -> Result<(), CollabError> {
        optional_non_negative_finite("embed.marginSeconds", self.margin_seconds)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SequenceMetadata {
    pub frames: Vec<MediaAsset>,
}

impl SequenceMetadata {
    fn validate(&self) -> Result<(), CollabError> {
        validate_count("sequence frames", self.frames.len(), MAX_ARRAY_LEN)?;
        if self.frames.is_empty() {
            return Err(CollabError::validation("sequence has no frames"));
        }
        for frame in &self.frames {
            frame.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorFormat {
    Hex,
    Rgb,
    Hsl,
    Hsb,
    Oklch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaletteLayout {
    Row,
    Col,
    Grid,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardPalette {
    pub colors: Vec<String>,
    #[serde(default)]
    pub source_item_ids: Vec<ItemId>,
    #[serde(default)]
    pub show_values: bool,
    pub color_format: ColorFormat,
    pub layout: PaletteLayout,
}

impl BoardPalette {
    fn validate(&self) -> Result<(), CollabError> {
        validate_count("palette colors", self.colors.len(), 1024)?;
        validate_count("palette sources", self.source_item_ids.len(), 1024)?;
        for color in &self.colors {
            validate_text("palette color", color, 128)?;
        }
        for id in &self.source_item_ids {
            id.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShapeAnchor {
    pub item_id: ItemId,
    pub x_fraction: f64,
    pub y_fraction: f64,
}

impl ShapeAnchor {
    fn validate(&self) -> Result<(), CollabError> {
        self.item_id.validate()?;
        unit("anchor.xFraction", self.x_fraction)?;
        unit("anchor.yFraction", self.y_fraction)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    Line,
    Arrow,
    Rect,
    Ellipse,
    Diamond,
    Text,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArrowHead {
    None,
    Arrow,
    Triangle,
    Dot,
    Bar,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DashStyle {
    Solid,
    Dashed,
    Dotted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteStyle {
    Straight,
    Curved,
    Elbow,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorShape {
    pub shape_id: ShapeId,
    pub kind: ShapeKind,
    pub color: String,
    pub width: f64,
    pub points: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_point: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_head: Option<ArrowHead>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_head: Option<ArrowHead>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<DashStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub rounded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_item_id: Option<ItemId>,
    #[serde(default)]
    pub owner_points: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_anchor: Option<ShapeAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_anchor: Option<ShapeAnchor>,
    #[serde(default)]
    pub detached: bool,
}

impl VectorShape {
    fn validate(&self) -> Result<(), CollabError> {
        self.shape_id.validate()?;
        validate_text("shape.color", &self.color, 128)?;
        positive_finite("shape.width", self.width)?;
        validate_numeric_array("shape.points", &self.points)?;
        validate_numeric_array("shape.ownerPoints", &self.owner_points)?;
        optional_text("shape.fill", &self.fill, 128)?;
        optional_text("shape.text", &self.text, MAX_SHORT_TEXT_LEN)?;
        if let Some(point) = self.control_point {
            finite("shape.controlPoint.x", point[0])?;
            finite("shape.controlPoint.y", point[1])?;
        }
        if let Some(opacity) = self.opacity {
            unit("shape.opacity", opacity)?;
        }
        if let Some(owner) = &self.owner_item_id {
            owner.validate()?;
        }
        if let Some(anchor) = &self.start_anchor {
            anchor.validate()?;
        }
        if let Some(anchor) = &self.end_anchor {
            anchor.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stroke {
    pub stroke_id: StrokeId,
    pub color: String,
    pub width: f64,
    pub opacity: f64,
    #[serde(with = "base64_bytes")]
    pub encoded_points: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_item_id: Option<ItemId>,
    #[serde(default)]
    pub detached: bool,
}

impl Stroke {
    fn validate(&self) -> Result<(), CollabError> {
        self.stroke_id.validate()?;
        validate_text("stroke.color", &self.color, 128)?;
        positive_finite("stroke.width", self.width)?;
        unit("stroke.opacity", self.opacity)?;
        if self.encoded_points.is_empty() || self.encoded_points.len() > MAX_STROKE_BYTES {
            return Err(CollabError::validation("invalid encoded stroke size"));
        }
        if let Some(owner) = &self.owner_item_id {
            owner.validate()?;
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
    AddItem {
        item_id: ItemId,
        kind: ItemKind,
        geometry: Geometry,
    },
    DeleteItem {
        item_id: ItemId,
    },
    SetGeometry {
        item_id: ItemId,
        geometry: Geometry,
    },
    SetCrop {
        item_id: ItemId,
        crop: Option<Crop>,
    },
    SetTrim {
        item_id: ItemId,
        trim: Option<Trim>,
    },
    SetAppearance {
        item_id: ItemId,
        appearance: Appearance,
    },
    SetTextStyle {
        item_id: ItemId,
        style: TextStyle,
    },
    TextInsert {
        item_id: ItemId,
        index: u32,
        text: String,
    },
    TextDelete {
        item_id: ItemId,
        index: u32,
        len: u32,
    },
    SetFrameStyle {
        item_id: ItemId,
        frame: FrameStyle,
    },
    SetPlayback {
        item_id: ItemId,
        playback: Playback,
    },
    SetMediaManifest {
        item_id: ItemId,
        manifest: Option<Box<MediaManifest>>,
    },
    SetLink {
        item_id: ItemId,
        link: Option<LinkMetadata>,
    },
    SetEmbed {
        item_id: ItemId,
        embed: Option<EmbedMetadata>,
    },
    SetSequence {
        item_id: ItemId,
        sequence: Option<SequenceMetadata>,
    },
    SetPalette {
        item_id: ItemId,
        palette: BoardPalette,
    },
    MoveItem {
        item_id: ItemId,
        before: Option<ItemId>,
    },
    AddStroke(Stroke),
    DeleteStroke {
        stroke_id: StrokeId,
    },
    UpsertShape(VectorShape),
    DeleteShape {
        shape_id: ShapeId,
    },
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
            Self::AddItem {
                item_id, geometry, ..
            }
            | Self::SetGeometry {
                item_id, geometry, ..
            } => {
                item_id.validate()?;
                geometry.validate()
            }
            Self::DeleteItem { item_id } => item_id.validate(),
            Self::SetCrop { item_id, crop } => {
                item_id.validate()?;
                if let Some(crop) = crop {
                    crop.validate()?;
                }
                Ok(())
            }
            Self::SetTrim { item_id, trim } => {
                item_id.validate()?;
                if let Some(trim) = trim {
                    trim.validate()?;
                }
                Ok(())
            }
            Self::SetAppearance {
                item_id,
                appearance,
            } => {
                item_id.validate()?;
                appearance.validate()
            }
            Self::SetTextStyle { item_id, style } => {
                item_id.validate()?;
                style.validate()
            }
            Self::TextInsert { item_id, text, .. } => {
                item_id.validate()?;
                validate_text("inserted text", text, MAX_TEXT_LEN)
            }
            Self::TextDelete { item_id, .. } => item_id.validate(),
            Self::SetFrameStyle { item_id, frame } => {
                item_id.validate()?;
                frame.validate()
            }
            Self::SetPlayback { item_id, playback } => {
                item_id.validate()?;
                playback.validate()
            }
            Self::SetMediaManifest { item_id, manifest } => {
                item_id.validate()?;
                if let Some(manifest) = manifest {
                    manifest.validate()?;
                }
                Ok(())
            }
            Self::SetLink { item_id, link } => {
                item_id.validate()?;
                if let Some(link) = link {
                    link.validate()?;
                }
                Ok(())
            }
            Self::SetEmbed { item_id, embed } => {
                item_id.validate()?;
                if let Some(embed) = embed {
                    embed.validate()?;
                }
                Ok(())
            }
            Self::SetSequence { item_id, sequence } => {
                item_id.validate()?;
                if let Some(sequence) = sequence {
                    sequence.validate()?;
                }
                Ok(())
            }
            Self::SetPalette { item_id, palette } => {
                item_id.validate()?;
                palette.validate()
            }
            Self::MoveItem { item_id, before } => {
                item_id.validate()?;
                if let Some(before) = before {
                    before.validate()?;
                    if before == item_id {
                        return Err(CollabError::validation("item cannot move before itself"));
                    }
                }
                Ok(())
            }
            Self::AddStroke(stroke) => stroke.validate(),
            Self::DeleteStroke { stroke_id } => stroke_id.validate(),
            Self::UpsertShape(shape) => shape.validate(),
            Self::DeleteShape { shape_id } => shape_id.validate(),
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

fn optional_text(label: &str, value: &Option<String>, max: usize) -> Result<(), CollabError> {
    if let Some(value) = value {
        validate_text(label, value, max)?;
    }
    Ok(())
}

fn validate_count(label: &str, count: usize, max: usize) -> Result<(), CollabError> {
    if count > max {
        return Err(CollabError::validation(format!("too many {label}")));
    }
    Ok(())
}

fn validate_numeric_array(label: &str, values: &[f64]) -> Result<(), CollabError> {
    validate_count(label, values.len(), MAX_ARRAY_LEN)?;
    for value in values {
        finite(label, *value)?;
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

fn optional_non_negative_finite(label: &str, value: Option<f64>) -> Result<(), CollabError> {
    if let Some(value) = value {
        non_negative_finite(label, value)?;
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

mod base64_bytes {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        STANDARD.decode(encoded).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        validate_mime, CollabOp, Crop, Geometry, ItemKind, MediaAsset, MediaManifest,
        OperationBatch,
    };

    #[test]
    fn rejects_non_finite_geometry_and_invalid_crop() {
        let bad_geometry = OperationBatch::v1(vec![CollabOp::AddItem {
            item_id: "item-1".into(),
            kind: ItemKind::Image,
            geometry: Geometry {
                x: f64::NAN,
                y: 0.0,
                width: 100.0,
                height: 100.0,
                rotation: 0.0,
                natural_width: None,
                natural_height: None,
                detached: false,
            },
        }]);
        assert!(bad_geometry.validate().is_err());

        let bad_crop = OperationBatch::v1(vec![CollabOp::SetCrop {
            item_id: "item-1".into(),
            crop: Some(Crop {
                x: 0.9,
                y: 0.0,
                width: 0.2,
                height: 1.0,
            }),
        }]);
        assert!(bad_crop.validate().is_err());
    }

    #[test]
    fn media_manifests_never_accept_sender_file_paths() {
        let manifest = MediaManifest {
            primary: MediaAsset {
                content_hash: None,
                remote_url: Some(r#"C:\\Users\\Alice\\secret.mov"#.into()),
                youtube_id: None,
                display_name: "secret.mov".into(),
                mime: "video/quicktime".into(),
                size: 12,
                source_url: None,
                preview_hash: None,
                preview_size: None,
            },
            previous: None,
            local: None,
        };
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn media_previews_require_hash_size_and_a_hashed_original() {
        let asset = |preview_hash: Option<&str>, preview_size: Option<u64>| MediaAsset {
            content_hash: Some("a".repeat(64)),
            remote_url: None,
            youtube_id: None,
            display_name: "clip.mp4".into(),
            mime: "video/mp4".into(),
            size: 1024,
            source_url: None,
            preview_hash: preview_hash.map(str::to_owned),
            preview_size,
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
        let batch = OperationBatch::v1(vec![CollabOp::DeleteItem {
            item_id: "a".into(),
        }]);
        let json = serde_json::to_value(batch).expect("serialize batch");
        assert_eq!(json["protocol"], 1);
        assert_eq!(json["ops"][0]["type"], "deleteItem");
        assert_eq!(json["ops"][0]["itemId"], "a");
    }
}
