use serde::Serialize;
use std::fmt;

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CollabErrorCode {
    Authorization,
    Conflict,
    Corrupt,
    KeyPending,
    Network,
    ReadOnly,
    Storage,
    Unavailable,
    Validation,
}

#[derive(Debug, Serialize)]
pub struct CollabError {
    pub code: CollabErrorCode,
    pub message: String,
}

impl CollabError {
    pub fn new(code: CollabErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(CollabErrorCode::Validation, message)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(CollabErrorCode::Storage, message)
    }
}

impl fmt::Display for CollabError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CollabError {}

impl From<std::io::Error> for CollabError {
    fn from(error: std::io::Error) -> Self {
        Self::storage(error.to_string())
    }
}
