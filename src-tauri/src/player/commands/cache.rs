use lazy_static::lazy_static;
use std::collections::HashMap;
use std::sync::Mutex;

const FRAME_PREVIEW_CACHE_MAX_ENTRIES: usize = 240;
const MEDIA_INFO_CACHE_MAX_ENTRIES: usize = 96;

/// LRU cache keyed by a monotonic tick instead of a separate ordering list.
/// Hits/inserts are O(1); only eviction scans for the least-recently-used
/// entry (O(N), and only when over capacity).
struct LruCache<V: Clone> {
    max_entries: usize,
    map: HashMap<String, (V, u64)>,
    tick: u64,
}

impl<V: Clone> LruCache<V> {
    fn new(max_entries: usize) -> Self {
        Self {
            max_entries,
            map: HashMap::new(),
            tick: 0,
        }
    }

    fn next_tick(&mut self) -> u64 {
        self.tick = self.tick.wrapping_add(1);
        self.tick
    }

    fn get(&mut self, key: &str) -> Option<V> {
        let tick = self.next_tick();
        let entry = self.map.get_mut(key)?;
        entry.1 = tick;
        Some(entry.0.clone())
    }

    fn put(&mut self, key: String, value: V) {
        let tick = self.next_tick();
        if let Some(entry) = self.map.get_mut(&key) {
            entry.0 = value;
            entry.1 = tick;
            return;
        }

        self.map.insert(key, (value, tick));

        while self.map.len() > self.max_entries {
            let oldest = self
                .map
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => break,
            }
        }
    }
}

lazy_static! {
    static ref FRAME_PREVIEW_CACHE: Mutex<LruCache<String>> =
        Mutex::new(LruCache::new(FRAME_PREVIEW_CACHE_MAX_ENTRIES));
    static ref MEDIA_INFO_CACHE: Mutex<LruCache<crate::player::mpv_wrapper::MediaInfo>> =
        Mutex::new(LruCache::new(MEDIA_INFO_CACHE_MAX_ENTRIES));
}

fn normalized_cache_path(path: &str) -> String {
    let normalized = super::parsing::normalize_path(path);
    #[cfg(target_os = "windows")]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        normalized
    }
}

fn media_info_cache_key(path: &str) -> String {
    normalized_cache_path(path)
}

fn frame_preview_cache_key(path: &str, seconds: f64, width: u32) -> String {
    let tick = if seconds.is_finite() {
        (seconds.max(0.0) * 1000.0).round() as i64
    } else {
        0
    };
    format!("{}|{}|{}", normalized_cache_path(path), tick, width)
}

pub(super) fn get_media_info_cached(path: &str) -> Option<crate::player::mpv_wrapper::MediaInfo> {
    let key = media_info_cache_key(path);
    let mut cache = MEDIA_INFO_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.get(&key)
}

pub(super) fn put_media_info_cache(path: &str, info: crate::player::mpv_wrapper::MediaInfo) {
    let key = media_info_cache_key(path);
    let mut cache = MEDIA_INFO_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.put(key, info);
}

pub(super) fn get_frame_preview_cached(path: &str, seconds: f64, width: u32) -> Option<String> {
    let key = frame_preview_cache_key(path, seconds, width);
    let mut cache = FRAME_PREVIEW_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache.get(&key)
}

pub(super) fn put_frame_preview_cache(path: &str, seconds: f64, width: u32, image: String) {
    let key = frame_preview_cache_key(path, seconds, width);
    let mut cache = FRAME_PREVIEW_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache.put(key, image);
}
