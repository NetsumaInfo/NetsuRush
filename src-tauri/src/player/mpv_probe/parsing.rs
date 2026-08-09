use serde_json::Value;

pub(super) fn parse_ratio(raw: &str) -> f64 {
    let text = raw.trim();
    if text.is_empty() {
        return 0.0;
    }
    if let Some((num, den)) = text.split_once('/') {
        let n = num.trim().parse::<f64>().unwrap_or(0.0);
        let d = den.trim().parse::<f64>().unwrap_or(1.0);
        if d.abs() < f64::EPSILON {
            return 0.0;
        }
        return n / d;
    }
    text.parse::<f64>().unwrap_or(0.0)
}

pub(super) fn parse_i64(value: Option<&Value>) -> i64 {
    fn parse_from_str(text: &str) -> Option<i64> {
        let t = text.trim();
        if t.is_empty() {
            return None;
        }
        if let Ok(v) = t.parse::<i64>() {
            return Some(v);
        }
        if let Ok(v) = t.parse::<f64>() {
            return Some(v.round() as i64);
        }
        let filtered: String = t
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
            .collect();
        if filtered.is_empty() {
            return None;
        }
        filtered.parse::<f64>().ok().map(|v| v.round() as i64)
    }

    value
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
                .or_else(|| v.as_f64().map(|f| f.round() as i64))
                .or_else(|| v.as_str().and_then(parse_from_str))
        })
        .unwrap_or(0)
}

pub(super) fn parse_f64(value: Option<&Value>) -> f64 {
    value
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_i64().map(|n| n as f64))
                .or_else(|| v.as_u64().map(|n| n as f64))
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        })
        .unwrap_or(0.0)
}

pub(super) fn parse_str(value: Option<&Value>) -> String {
    value
        .and_then(|v| {
            v.as_str()
                .map(|s| s.trim().to_string())
                .or_else(|| v.as_i64().map(|n| n.to_string()))
                .or_else(|| v.as_u64().map(|n| n.to_string()))
                .or_else(|| v.as_f64().map(|n| n.to_string()))
        })
        .unwrap_or_default()
}

pub(super) fn infer_bit_depth_from_pix_fmt(pix_fmt: &str) -> i64 {
    let lower = pix_fmt.to_ascii_lowercase();
    if lower.is_empty() {
        return 0;
    }
    if lower.contains("16") {
        return 16;
    }
    if lower.contains("14") {
        return 14;
    }
    if lower.contains("12") {
        return 12;
    }
    if lower.contains("10") {
        return 10;
    }
    if lower.contains("9") {
        return 9;
    }
    8
}

pub(super) fn parse_stream_i64(stream: Option<&Value>, field: &str) -> i64 {
    parse_i64(stream.and_then(|s| s.get(field)))
}

pub(super) fn parse_stream_tag_i64(stream: Option<&Value>, field: &str) -> i64 {
    parse_i64(
        stream
            .and_then(|s| s.get("tags"))
            .and_then(|t| t.get(field)),
    )
}

pub(super) fn parse_stream_str(stream: Option<&Value>, field: &str) -> String {
    parse_str(stream.and_then(|s| s.get(field)))
}
