//! Surface records use field registers and independent Loro text containers.
//! Only an explicit restore clears a tombstone; stale metadata never resurrects an entry.
use std::collections::BTreeMap;
use loro::{LoroDoc, LoroMap, LoroValue};
use serde::Serialize;
use super::{DocError, atomic, is_tombstoned, json};
use crate::collab::ops::{CollabOp, MediaManifest, SurfaceEntryKind};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceEntryProjection {
    pub entry_id: String,
    pub kind: SurfaceEntryKind,
    pub fields: BTreeMap<String, serde_json::Value>,
    pub texts: BTreeMap<String, String>,
    pub rich_texts: BTreeMap<String, Vec<loro::TextDelta>>,
    pub media: BTreeMap<String, MediaManifest>,
}

fn entry(doc: &LoroDoc, id: &str) -> Result<LoroMap, DocError> {
    let map = doc.get_map("surfaceEntries").ensure_mergeable_map(id)?;
    if !id.starts_with("ci_") && is_tombstoned(&map) { return Err(DocError::Rejected("surface entry is deleted".into())); }
    if map.get("kind").is_none() { return Err(DocError::Rejected("unknown surface entry".into())); }
    Ok(map)
}

pub fn apply(doc: &LoroDoc, op: &CollabOp) -> Result<(), DocError> {
    match op {
        CollabOp::SurfaceRestoreEntry { entry_id } => {
            if entry_id.as_str().starts_with("ci_") { return Err(DocError::Rejected("collection entries cannot be restored through document operations".into())); }
            let map = doc.get_map("surfaceEntries").ensure_mergeable_map(entry_id.as_str())?;
            if is_tombstoned(&map) {
                // The renderer restores a complete snapshot from an absent entry. Retaining old
                // text here would append that snapshot to the deleted text a second time.
                let texts = map.ensure_mergeable_map("texts")?;
                let mut values = Vec::new();
                texts.for_each(|_, value| {
                    if let Some(text) = value.into_container().ok().and_then(|v| v.into_text().ok()) { values.push(text); }
                });
                for text in values { let length = text.len_unicode(); if length > 0 { text.delete(0, length)?; } }
                for name in ["fields", "media"] {
                    let values = map.ensure_mergeable_map(name)?;
                    let mut keys = Vec::new();
                    values.for_each(|key, _| keys.push(key.to_owned()));
                    for key in keys { values.delete(&key)?; }
                }
                map.insert("deleted", false)?;
            }
        }
        CollabOp::SurfaceSetEntry { entry_id, kind, fields } => {
            if entry_id.as_str().starts_with("ci_") != matches!(kind, SurfaceEntryKind::CollectionItem) { return Err(DocError::Rejected("collection item id must use reserved ci_ prefix".into())); }
            let map = doc.get_map("surfaceEntries").ensure_mergeable_map(entry_id.as_str())?;
            if is_tombstoned(&map) { return Err(DocError::Rejected("surface entry is deleted".into())); }
            if let Some(old) = atomic::<SurfaceEntryKind>(&map, "kind")? {
                if old != *kind { return Err(DocError::Rejected("surface kind cannot change".into())); }
            } else { map.insert("kind", json(kind)?)?; }
            let values = map.ensure_mergeable_map("fields")?;
            for (key, value) in fields { values.insert(key, json(value)?)?; }
        }
        CollabOp::SurfaceDeleteEntry { entry_id } => {
            if entry_id.as_str().starts_with("ci_") { return Err(DocError::Rejected("collection removal requires server authorization".into())); }
            doc.get_map("surfaceEntries").ensure_mergeable_map(entry_id.as_str())?.insert("deleted", true)?;
        }
        CollabOp::SurfaceTextInsert { entry_id, field, index, text } => {
            let texts = entry(doc, entry_id.as_str())?.ensure_mergeable_map("texts")?;
            let value = texts.ensure_mergeable_text(field)?;
            if *index as usize > value.len_unicode() { return Err(DocError::Rejected("surface text index out of bounds".into())); }
            if value.len_unicode().saturating_add(text.chars().count()) > 1_000_000 { return Err(DocError::Rejected("surface text too long".into())); }
            value.insert(*index as usize, text)?;
        }
        CollabOp::SurfaceTextFormat { entry_id, field, start, end, style, value } => {
            let mut styles = loro::StyleConfigMap::new();
            for key in ["bold", "italic", "underline", "strike", "code", "textColor", "backgroundColor", "link", "inline"] { styles.insert(key.into(), loro::StyleConfig { expand: loro::ExpandType::After }); }
            doc.config_text_style(styles);
            let text = entry(doc, entry_id.as_str())?.ensure_mergeable_map("texts")?.ensure_mergeable_text(field)?;
            if *end as usize > text.len_unicode() { return Err(DocError::Rejected("surface format range out of bounds".into())); }
            if let Some(value) = value { text.mark(*start as usize..*end as usize, style, value.as_str())?; }
            else { text.unmark(*start as usize..*end as usize, style)?; }
        }
        CollabOp::SurfaceTextDelete { entry_id, field, index, length } => {
            let texts = entry(doc, entry_id.as_str())?.ensure_mergeable_map("texts")?;
            let value = texts.ensure_mergeable_text(field)?;
            if (*index as usize).saturating_add(*length as usize) > value.len_unicode() { return Err(DocError::Rejected("surface text range out of bounds".into())); }
            value.delete(*index as usize, *length as usize)?;
        }
        CollabOp::SurfaceSetMedia { entry_id, field, manifest } => {
            entry(doc, entry_id.as_str())?.ensure_mergeable_map("media")?.insert(field, json(manifest)?)?;
        }
        _ => return Err(DocError::Rejected("not a surface operation".into())),
    }
    Ok(())
}

pub fn projection(doc: &LoroDoc) -> Result<Vec<SurfaceEntryProjection>, DocError> {
    let mut output = Vec::new();
    let mut ids = Vec::new();
    doc.get_map("surfaceEntries").for_each(|key, _| { ids.push(key.to_string()); });
    ids.sort();
    for id in ids {
        let Ok(map) = entry(doc, &id) else { continue; };
        let Some(stored_kind) = atomic::<SurfaceEntryKind>(&map, "kind")? else { continue; };
        let kind = if id.starts_with("ci_") { SurfaceEntryKind::CollectionItem } else { stored_kind };
        let mut fields = BTreeMap::new();
        let mut error = None;
        map.ensure_mergeable_map("fields")?.for_each(|key, value| {
            if let Ok(LoroValue::String(text)) = value.into_value() {
                match serde_json::from_str(&text) { Ok(value) => { fields.insert(key.to_owned(), value); }, Err(e) => error = Some(e.to_string()) }
            }
        });
        if let Some(error) = error { return Err(DocError::Loro(error)); }
        let mut texts = BTreeMap::new();
        let mut rich_texts = BTreeMap::new();
        map.ensure_mergeable_map("texts")?.for_each(|key, value| {
            if let Some(text) = value.into_container().ok().and_then(|v| v.into_text().ok()) { rich_texts.insert(key.to_owned(), text.to_delta()); texts.insert(key.to_owned(), text.to_string()); }
        });
        let mut media = BTreeMap::new();
        map.ensure_mergeable_map("media")?.for_each(|key, value| {
            if let Ok(LoroValue::String(text)) = value.into_value() {
                match serde_json::from_str::<Option<MediaManifest>>(&text) { Ok(Some(value)) => { media.insert(key.to_owned(), value); }, Ok(None) => (), Err(e) => error = Some(e.to_string()) }
            }
        });
        if let Some(error) = error { return Err(DocError::Loro(error)); }
        output.push(SurfaceEntryProjection { entry_id: id, kind, fields, texts, rich_texts, media });
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro::ExportMode;
    use serde_json::json;

    fn operation(doc: &LoroDoc, value: serde_json::Value) {
        apply(doc, &serde_json::from_value(value).expect("typed operation")).expect("apply");
        doc.commit();
    }

    #[test]
    fn restore_replaces_deleted_text_once() {
        let doc = LoroDoc::new();
        operation(&doc, json!({"type":"surfaceSetEntry","entryId":"block","kind":"block","fields":{}}));
        operation(&doc, json!({"type":"surfaceTextInsert","entryId":"block","field":"content","index":0,"text":"Hello 🌍"}));
        operation(&doc, json!({"type":"surfaceDeleteEntry","entryId":"block"}));
        assert!(projection(&doc).unwrap().is_empty());
        operation(&doc, json!({"type":"surfaceRestoreEntry","entryId":"block"}));
        operation(&doc, json!({"type":"surfaceTextInsert","entryId":"block","field":"content","index":0,"text":"Hello 🌍"}));
        assert_eq!(projection(&doc).unwrap()[0].texts["content"], "Hello 🌍");
    }

    #[test]
    fn fifteen_writers_converge_on_one_text() {
        let initial = LoroDoc::new();
        operation(&initial, json!({"type":"surfaceSetEntry","entryId":"block","kind":"block","fields":{}}));
        operation(&initial, json!({"type":"surfaceTextInsert","entryId":"block","field":"content","index":0,"text":"🌍"}));
        let snapshot = initial.export(ExportMode::Snapshot).unwrap();
        let version = initial.oplog_vv();
        let mut updates = Vec::new();
        for peer in 1..=15 {
            let doc = LoroDoc::new();
            doc.import(&snapshot).unwrap();
            doc.set_peer_id(peer).unwrap();
            operation(&doc, json!({"type":"surfaceTextInsert","entryId":"block","field":"content","index":1,"text":format!("[{peer}]")}));
            updates.push(doc.export(ExportMode::updates(&version)).unwrap());
        }
        let left = LoroDoc::new(); let right = LoroDoc::new();
        left.import(&snapshot).unwrap(); right.import(&snapshot).unwrap();
        for update in &updates { left.import(update).unwrap(); }
        for update in updates.iter().rev() { right.import(update).unwrap(); }
        let text = projection(&left).unwrap()[0].texts["content"].clone();
        assert_eq!(text, projection(&right).unwrap()[0].texts["content"]);
        for peer in 1..=15 { assert!(text.contains(&format!("[{peer}]"))); }
    }
}
