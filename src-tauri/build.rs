fn main() {
    // Collaboration pins its Convex deployment at BUILD time and refuses a runtime hint that does
    // not match it (`collab/convex.rs`): a renderer must not be able to point the native service,
    // which holds the account's bearer token, at a deployment of its choosing.
    println!("cargo:rerun-if-env-changed=VITE_CONVEX_URL");
    println!("cargo:rerun-if-changed=../.env.local");
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=../.env.production");
    if let Some(url) = convex_url() {
        println!("cargo:rustc-env=NETSURUSH_CONVEX_URL={url}");
    }
    tauri_build::build()
}

fn convex_url() -> Option<String> {
    std::env::var("VITE_CONVEX_URL")
        .ok()
        .filter(|value| valid_env_value(value))
        .or_else(|| read_env_file("../.env.local"))
        .or_else(|| read_env_file("../.env.production"))
        .or_else(|| read_env_file("../.env"))
}

fn read_env_file(path: &str) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    body.lines().find_map(|line| {
        let value = line.trim().strip_prefix("VITE_CONVEX_URL=")?.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(value)
            .to_owned();
        valid_env_value(&value).then_some(value)
    })
}

fn valid_env_value(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(char::is_control)
}
