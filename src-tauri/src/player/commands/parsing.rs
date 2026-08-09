use serde_json::Value;

pub(super) fn normalize_path(value: &str) -> String {
    value.replace('\\', "/")
}

pub(super) fn parse_json_i64(value: Option<&Value>) -> i64 {
    fn parse_from_str(text: &str) -> Option<i64> {
        let cleaned: String = text
            .trim()
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
            .collect();
        if cleaned.is_empty() {
            return None;
        }
        if let Ok(v) = cleaned.parse::<i64>() {
            return Some(v);
        }
        cleaned.parse::<f64>().ok().map(|v| v.round() as i64)
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

pub(super) fn parse_json_f64(value: Option<&Value>) -> f64 {
    fn parse_from_str(text: &str) -> Option<f64> {
        let cleaned: String = text
            .trim()
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
            .collect();
        if cleaned.is_empty() {
            return None;
        }
        cleaned.parse::<f64>().ok()
    }

    value
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_i64().map(|n| n as f64))
                .or_else(|| v.as_u64().map(|n| n as f64))
                .or_else(|| v.as_str().and_then(parse_from_str))
        })
        .unwrap_or(0.0)
}

pub(super) fn parse_json_string(value: Option<&Value>) -> String {
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
