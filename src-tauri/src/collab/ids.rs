use super::error::CollabError;
use std::fmt;
use std::io::Write as _;
use std::path::Path;
#[cfg(test)]
use std::path::{Component, PathBuf};

const MAX_PROJECT_ID_BYTES: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectId(String);

impl ProjectId {
    pub fn parse(value: impl Into<String>) -> Result<Self, CollabError> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_PROJECT_ID_BYTES {
            return Err(CollabError::validation("project id length is invalid"));
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(CollabError::validation(
                "project id contains unsupported characters",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn storage_key(&self) -> String {
        blake3::hash(self.0.as_bytes()).to_hex().to_string()
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct OpaqueToken(String);

impl OpaqueToken {
    pub fn generate() -> Result<Self, CollabError> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|error| CollabError::storage(format!("OS randomness unavailable: {error}")))?;
        Ok(Self(hex_lower(&bytes)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for OpaqueToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpaqueToken([redacted])")
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

/// Atomically replaces a durable metadata file. `std::fs::rename` does not replace an existing
/// destination on Windows, while removing first creates a crash window where the file disappears.
pub fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt as _;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        use windows_core::PCWSTR;

        let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination_wide: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source_wide.as_ptr()),
                PCWSTR(destination_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(std::io::Error::other)
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(source, destination)
    }
}

pub fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), CollabError> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let token = OpaqueToken::generate()?;
    let temp = destination.with_extension(format!("{}.part", token.as_str()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temp, destination)?;
        Ok::<(), CollabError>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
pub fn confined_child(root: &Path, relative: &Path) -> Result<PathBuf, CollabError> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CollabError::validation("relative path is not confined"));
    }

    let canonical_root = std::fs::canonicalize(root)?;
    let candidate = canonical_root.join(relative);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| CollabError::validation("path has no confined ancestor"))?;
    }

    let canonical_existing = std::fs::canonicalize(existing)?;
    if !canonical_existing.starts_with(&canonical_root) {
        return Err(CollabError::validation("path resolves outside its root"));
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::{confined_child, OpaqueToken, ProjectId};
    use std::path::Path;

    #[test]
    fn project_storage_key_never_contains_user_input() {
        let id = ProjectId::parse("jx71exampleproject").expect("valid id");
        let key = id.storage_key();
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!key.contains(id.as_str()));
    }

    #[test]
    fn project_id_rejects_path_syntax() {
        for value in ["../escape", r"..\escape", "C:/escape", "a/b", "a:b"] {
            assert!(ProjectId::parse(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn project_id_accepts_the_convex_safe_alphabet() {
        let id = ProjectId::parse("project_A-19").expect("valid id");
        assert_eq!(id.as_str(), "project_A-19");
    }

    #[test]
    fn opaque_token_is_random_and_fixed_width() {
        let first = OpaqueToken::generate().expect("first token");
        let second = OpaqueToken::generate().expect("second token");
        assert_ne!(first, second);
        assert_eq!(first.as_str().len(), 64);
        assert!(first.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn confined_child_rejects_escape_and_absolute_paths() {
        let root =
            std::env::temp_dir().join(OpaqueToken::generate().expect("temporary token").as_str());
        std::fs::create_dir_all(&root).expect("create root");

        assert!(confined_child(&root, Path::new("nested/file.bin")).is_ok());
        assert!(confined_child(&root, Path::new("../escape.bin")).is_err());
        assert!(confined_child(&root, Path::new(r"C:\escape.bin")).is_err());

        std::fs::remove_dir_all(&root).expect("remove root");
    }
}
