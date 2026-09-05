use std::fmt;
use std::time::Duration;

use reqwest::{Client, Url};
use serde::de::DeserializeOwned;
use serde::Serialize;
use zeroize::Zeroizing;

use super::error::{CollabError, CollabErrorCode};

const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct ConvexConfig {
    deployment: Url,
}

impl ConvexConfig {
    pub fn compiled(deployment: impl AsRef<str>) -> Result<Self, CollabError> {
        let deployment = parse_deployment(deployment.as_ref())?;
        Ok(Self { deployment })
    }

    pub fn validate_runtime_hint(&self, hint: impl AsRef<str>) -> Result<(), CollabError> {
        let hinted = parse_deployment(hint.as_ref())?;
        if hinted != self.deployment {
            return Err(CollabError::new(
                CollabErrorCode::Authorization,
                "Convex deployment does not match the compiled application configuration",
            ));
        }
        Ok(())
    }

    fn from_build(runtime_hint: &str) -> Result<Self, CollabError> {
        let configured = option_env!("NETSURUSH_CONVEX_URL").unwrap_or("").trim();
        if configured.is_empty() {
            let local = Self::compiled(runtime_hint)?;
            if cfg!(debug_assertions) && is_local(&local.deployment) {
                return Ok(local);
            }
            return Err(CollabError::new(
                CollabErrorCode::Unavailable,
                "collaboration was built without a pinned Convex deployment",
            ));
        }
        let pinned = Self::compiled(configured)?;
        pinned.validate_runtime_hint(runtime_hint)?;
        Ok(pinned)
    }
}

pub struct AuthSession {
    deployment: Url,
    token: Zeroizing<String>,
}

impl AuthSession {
    pub fn new(deployment: impl AsRef<str>, token: impl Into<String>) -> Result<Self, CollabError> {
        let config = ConvexConfig::from_build(deployment.as_ref())?;
        Self::from_config(config, token)
    }

    fn from_config(config: ConvexConfig, token: impl Into<String>) -> Result<Self, CollabError> {
        let token = token.into();
        if token.is_empty() || token.len() > 32 * 1024 || token.chars().any(char::is_control) {
            return Err(CollabError::validation("invalid Convex bearer token"));
        }
        Ok(Self {
            deployment: config.deployment,
            token: Zeroizing::new(token),
        })
    }
}

fn is_local(deployment: &Url) -> bool {
    matches!(deployment.host_str(), Some("127.0.0.1" | "localhost"))
}

fn parse_deployment(value: &str) -> Result<Url, CollabError> {
    let mut deployment =
        Url::parse(value).map_err(|_| CollabError::validation("invalid Convex deployment URL"))?;
    if deployment.path().is_empty() {
        deployment.set_path("/");
    }
    if deployment.path() != "/"
        || !deployment.username().is_empty()
        || deployment.password().is_some()
        || deployment.query().is_some()
        || deployment.fragment().is_some()
    {
        return Err(CollabError::validation(
            "Convex deployment URL contains unsupported parts",
        ));
    }
    if deployment.scheme() != "https" && !(is_local(&deployment) && deployment.scheme() == "http") {
        return Err(CollabError::validation("Convex deployment must use HTTPS"));
    }
    Ok(deployment)
}

impl fmt::Debug for AuthSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthSession")
            .field("deployment", &self.deployment.as_str())
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Copy)]
pub enum FunctionKind {
    Query,
    Mutation,
}

impl FunctionKind {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Mutation => "mutation",
        }
    }
}

pub struct ConvexClient {
    client: Client,
    session: AuthSession,
}

#[derive(Serialize)]
struct FunctionRequest<'a, A> {
    path: &'a str,
    args: A,
    format: &'static str,
}

impl ConvexClient {
    pub fn new(session: AuthSession) -> Result<Self, CollabError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| CollabError::new(CollabErrorCode::Network, error.to_string()))?;
        Ok(Self { client, session })
    }

    pub async fn query<A: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        args: A,
    ) -> Result<T, CollabError> {
        self.call(FunctionKind::Query, path, args).await
    }

    pub async fn mutation<A: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        args: A,
    ) -> Result<T, CollabError> {
        self.call(FunctionKind::Mutation, path, args).await
    }

    pub async fn upload(&self, upload_url: &str, bytes: Vec<u8>) -> Result<String, CollabError> {
        if bytes.is_empty() || bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CollabError::validation("invalid Convex upload size"));
        }
        let url = Url::parse(upload_url)
            .map_err(|_| CollabError::validation("invalid Convex upload URL"))?;
        if url.scheme() != "https"
            && !(matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                && url.scheme() == "http")
        {
            return Err(CollabError::validation("Convex upload must use HTTPS"));
        }
        let response = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(network)?;
        let status = response.status();
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|_| CollabError::new(CollabErrorCode::Network, "invalid upload response"))?;
        if !status.is_success() {
            return Err(CollabError::new(
                CollabErrorCode::Network,
                "Convex upload failed",
            ));
        }
        body.get("storageId")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .ok_or_else(|| CollabError::new(CollabErrorCode::Network, "missing storage id"))
    }

    pub async fn download(&self, download_url: &str) -> Result<Vec<u8>, CollabError> {
        let url = Url::parse(download_url)
            .map_err(|_| CollabError::validation("invalid Convex download URL"))?;
        if url.scheme() != "https"
            && !(matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                && url.scheme() == "http")
        {
            return Err(CollabError::validation("Convex download must use HTTPS"));
        }
        let response = self.client.get(url).send().await.map_err(network)?;
        if !response.status().is_success()
            || response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64
        {
            return Err(CollabError::new(
                CollabErrorCode::Network,
                "Convex download failed or is too large",
            ));
        }
        let bytes = response.bytes().await.map_err(network)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CollabError::new(
                CollabErrorCode::Network,
                "Convex download is too large",
            ));
        }
        Ok(bytes.to_vec())
    }

    async fn call<A: Serialize, T: DeserializeOwned>(
        &self,
        kind: FunctionKind,
        path: &str,
        args: A,
    ) -> Result<T, CollabError> {
        if path.is_empty()
            || path.len() > 256
            || !path.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b':' | b'.')
            })
        {
            return Err(CollabError::validation("invalid Convex function path"));
        }
        let url = self
            .session
            .deployment
            .join(&format!("/api/{}", kind.endpoint()))
            .map_err(|_| CollabError::validation("invalid Convex endpoint"))?;
        let response = self
            .client
            .post(url)
            .bearer_auth(self.session.token.as_str())
            .json(&FunctionRequest {
                path,
                args,
                format: "json",
            })
            .send()
            .await
            .map_err(network)?;
        if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
            return Err(CollabError::new(
                CollabErrorCode::Network,
                "Convex response is too large",
            ));
        }
        let status = response.status();
        let bytes = response.bytes().await.map_err(network)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CollabError::new(
                CollabErrorCode::Network,
                "Convex response is too large",
            ));
        }
        let body: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| CollabError::new(CollabErrorCode::Network, "invalid Convex response"))?;
        if !status.is_success()
            || body.get("status").and_then(|value| value.as_str()) != Some("success")
        {
            let message = body
                .get("errorMessage")
                .or_else(|| body.get("message"))
                .and_then(|value| value.as_str())
                .unwrap_or("Convex request failed");
            return Err(CollabError::new(
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    CollabErrorCode::Authorization
                } else {
                    CollabErrorCode::Network
                },
                message,
            ));
        }
        let mut value = body.get("value").cloned().ok_or_else(|| {
            CollabError::new(CollabErrorCode::Network, "missing Convex value")
        })?;
        normalize_numbers(&mut value);
        serde_json::from_value(value)
        // serde names the offending field and the type it got. Dropping it left every mismatch —
        // a renamed field, a number that arrived as a float, a null — looking identical.
        .map_err(|error| {
            CollabError::new(
                CollabErrorCode::Network,
                format!("unexpected Convex response shape: {error}"),
            )
        })
    }
}

/// Convex encodes every JavaScript number as a float, so an epoch, a size or a timestamp arrives as
/// `0.0` and serde refuses it for a `u32` or a `u64`. Whole floats are folded back to integers here,
/// once, at the transport boundary — the alternative is a custom deserializer on every numeric field
/// of every struct, and one forgotten field is an error nobody can read.
///
/// Fractional values are left alone: they are genuinely floats and must keep their precision.
fn normalize_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                if float.fract() == 0.0 && float.abs() <= i64::MAX as f64 {
                    *value = serde_json::Value::Number((float as i64).into());
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        serde_json::Value::Object(fields) => {
            fields.values_mut().for_each(normalize_numbers);
        }
        _ => {}
    }
}

fn network(error: reqwest::Error) -> CollabError {
    CollabError::new(CollabErrorCode::Network, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{AuthSession, ConvexConfig};

    #[test]
    fn compiled_deployment_rejects_a_different_runtime_hint() {
        let config = ConvexConfig::compiled("https://good.convex.cloud").expect("config");
        assert!(config
            .validate_runtime_hint("https://evil.convex.cloud")
            .is_err());
        assert!(config
            .validate_runtime_hint("https://good.convex.cloud/")
            .is_ok());
    }

    #[test]
    fn auth_configuration_rejects_non_https_remote_deployments() {
        assert!(ConvexConfig::compiled("http://evil.example").is_err());
        assert!(ConvexConfig::compiled("https://example.convex.cloud").is_ok());
        assert!(ConvexConfig::compiled("http://127.0.0.1:3210").is_ok());
    }

    #[test]
    fn auth_debug_never_prints_the_bearer_token() {
        let config = ConvexConfig::compiled("https://example.convex.cloud").expect("config");
        let session = AuthSession::from_config(config, "very-secret-token").expect("session");
        let debug = format!("{session:?}");
        assert!(!debug.contains("very-secret-token"));
        assert!(debug.contains("[redacted]"));
    }
}
