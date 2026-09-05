//! Persistent device identity (`docs/collab.md` §6).
//!
//! Two keys per installation, generated once and never regenerated:
//!
//! * an **Ed25519** signing key — the device identity. These are the same 32 secret bytes iroh will
//!   use as its `SecretKey`, so the EndpointId a peer allowlists today stays valid forever.
//! * an **X25519** exchange key, used later to wrap project keys with HPKE. It is generated
//!   independently: no key material is derived from the Ed25519 identity.
//!
//! Both secrets are protected at rest with DPAPI, scoped to the current Windows account, and live
//! in a single file replaced atomically.
//!
//! **A lost or damaged key ring is a hard, visible error.** Regenerating an identity silently would
//! look like a brand-new device to every peer: it would drop off every allowlist, lose access to
//! every project key envelope, and orphan any unpublished local branch. Recovery means enrolling
//! again through another authorised member, which the user must be told about — never guessed at.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as ExchangePublic, StaticSecret as ExchangeSecret};
use zeroize::Zeroizing;

/// Key-ring format. A file carrying anything else is refused, never rewritten.
const RING_VERSION: u32 = 1;

/// DPAPI optional entropy. Ties the ciphertext to this purpose, so a blob lifted from another
/// NetsuRush file cannot be unprotected as an identity.
const DPAPI_ENTROPY: &[u8] = b"NetsuRush.collab.device-identity.v1";

const SECRET_LEN: usize = 64; // 32 bytes of Ed25519 seed followed by 32 bytes of X25519 scalar

#[derive(Debug)]
pub enum IdentityError {
    Io(io::Error),
    /// The file exists but cannot be trusted. Never followed by a regeneration.
    Corrupt(String),
    UnknownVersion(u32),
    /// A local failure that says nothing about the file: no OS randomness, encoding refused.
    /// Kept apart from `Corrupt` so the user is not told a healthy key ring is damaged.
    Internal(String),
    Dpapi(String),
    /// At-rest protection is unavailable, so no secret is written. NetsuRush ships on Windows only;
    /// this arm exists so a non-Windows build fails loudly instead of storing a bare secret.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "device identity: {err}"),
            Self::Corrupt(what) => write!(f, "device identity is unreadable: {what}"),
            Self::Internal(what) => write!(f, "device identity could not be created: {what}"),
            Self::UnknownVersion(found) => write!(
                f,
                "device identity was written by a newer build (format {found}, this build reads {RING_VERSION})"
            ),
            Self::Dpapi(what) => write!(f, "device identity could not be unprotected: {what}"),
            Self::Unsupported => write!(f, "device identity requires Windows DPAPI"),
        }
    }
}

impl std::error::Error for IdentityError {}

impl From<io::Error> for IdentityError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

/// Everything the renderer is allowed to know. No secret has a field here, by construction.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentityPublic {
    /// Ed25519 public key, lowercase hex. The iroh EndpointId string form arrives with the iroh
    /// integration; the bytes below are already the final identity.
    pub device_id: String,
    /// X25519 public key, lowercase hex. Published to Convex signed by the device identity.
    pub exchange_public: String,
    pub created_at: u64,
}

/// On-disk shape. `protected` is the DPAPI blob; the two public fields are stored in clear so a
/// mismatch after unprotecting is detectable.
#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    version: u32,
    created_at: u64,
    device_id: String,
    exchange_public: String,
    protected: String,
}

pub struct DeviceIdentity {
    /// Signs envelopes and authenticates connections. Kept private: callers get `sign`, never bytes.
    signing: SigningKey,
    /// Wraps project keys. Held here so the ring is read once per process.
    exchange: ExchangeSecret,
    public: DeviceIdentityPublic,
}

impl DeviceIdentity {
    pub fn public(&self) -> &DeviceIdentityPublic {
        &self.public
    }

    pub fn registration_proof(
        &self,
        challenge: &str,
        account_id: &str,
    ) -> Result<super::device::RegistrationProof, super::error::CollabError> {
        let statement = super::device::RegistrationStatement::new(
            challenge,
            account_id,
            &self.public.device_id,
            &self.public.device_id,
            &self.public.exchange_public,
            &self.public.device_id,
        )?;
        super::device::RegistrationProof::sign(statement, &self.signing)
    }

    /// Detached Ed25519 signature. Every envelope header and ciphertext is signed with this.
    #[allow(dead_code)]
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer as _;
        self.signing.sign(message).to_bytes()
    }

    pub fn verify_self(&self, message: &[u8], signature: &[u8]) -> bool {
        use ed25519_dalek::{Signature, Verifier as _};
        let Ok(signature) = <&[u8; 64]>::try_from(signature) else {
            return false;
        };
        self.signing
            .verifying_key()
            .verify(message, &Signature::from_bytes(signature))
            .is_ok()
    }

    /// The 32 secret bytes, for building the iroh endpoint from this very identity.
    ///
    /// Crate-private on purpose: this is the only place the seed is handed out, and it never leaves
    /// Rust. Rebuilding the endpoint from these bytes is what makes the EndpointId a peer put in its
    /// allowlist survive restarts, reinstalls and updates.
    pub(crate) fn signing_seed(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// The X25519 scalar, for opening an HPKE-wrapped project key. Crate-private, like the seed.
    pub(crate) fn exchange_scalar(&self) -> [u8; 32] {
        self.exchange.to_bytes()
    }
}

static IDENTITY: OnceLock<DeviceIdentity> = OnceLock::new();
static LOAD_LOCK: Mutex<()> = Mutex::new(());

/// Loads the key ring, creating it only when the file is absent.
///
/// Both windows share one process, so one lock is enough to keep two renderers from creating two
/// identities. A second NetsuRush process cannot exist: `tauri-plugin-single-instance` routes it
/// into the first one.
pub fn get_or_init() -> Result<&'static DeviceIdentity, IdentityError> {
    if let Some(identity) = IDENTITY.get() {
        return Ok(identity);
    }
    let _guard = LOAD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(identity) = IDENTITY.get() {
        return Ok(identity);
    }
    let identity = load_or_create()?;
    let _ = IDENTITY.set(identity);
    Ok(IDENTITY.get().expect("identity set under the load lock"))
}

/// Where the core keeps the user's own documents — scenes, collections, notebooks, reference
/// assets. It MUST resolve exactly like `DATA_DIR` in `core/config.js`: everything collaborative
/// is anchored to it, and looking anywhere else means Rust reads an empty directory, finds no
/// document, and refuses every media.
///
/// Deliberately not `%LOCALAPPDATA%\NetsuRush` (`NR_HOME`), which holds the installed runtime, the
/// models and `nr.config.json` — machine state rather than the user's work.
pub(crate) fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("NR_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let profile = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    profile.join(".netsurush")
}

/// Root of everything collaborative on this machine: key ring, project snapshots, blob store.
pub(crate) fn collab_dir() -> PathBuf {
    data_dir().join("collab")
}

/// Root a shared document's local media is authorised against (`<data>/reference/assets` among
/// others). The same directory as `data_dir`, named apart because it answers another question.
pub(crate) fn board_data_dir() -> PathBuf {
    data_dir()
}

fn ring_path() -> PathBuf {
    collab_dir().join("device-identity.json")
}

fn load_or_create() -> Result<DeviceIdentity, IdentityError> {
    let path = ring_path();
    match fs::read(&path) {
        Ok(bytes) => decode(&bytes),
        Err(err) if err.kind() == io::ErrorKind::NotFound => match create(&path) {
            // Lost a race against another writer: read what landed rather than overwrite it.
            Err(IdentityError::Io(err)) if err.kind() == io::ErrorKind::AlreadyExists => {
                decode(&fs::read(&path)?)
            }
            other => other,
        },
        Err(err) => Err(IdentityError::Io(err)),
    }
}

/// Creation is the only path that may write a new identity, and only when nothing is there.
///
/// `create_new` is what makes that true: no temporary file, no rename, so a concurrent creator gets
/// `AlreadyExists` instead of silently replacing a key ring. Later updates — key rotation — will
/// need write-to-temp-then-rename; creation must not.
fn create(path: &PathBuf) -> Result<DeviceIdentity, IdentityError> {
    let mut secret = Zeroizing::new([0u8; SECRET_LEN]);
    getrandom::fill(secret.as_mut_slice())
        .map_err(|err| IdentityError::Internal(format!("no OS randomness: {err}")))?;

    let identity = from_secret(&secret, now_seconds())?;
    let stored = StoredIdentity {
        version: RING_VERSION,
        created_at: identity.public.created_at,
        device_id: identity.public.device_id.clone(),
        exchange_public: identity.public.exchange_public.clone(),
        protected: BASE64.encode(protect(secret.as_slice())?),
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(&stored)
        .map_err(|err| IdentityError::Internal(format!("cannot encode the key ring: {err}")))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    io::Write::write_all(&mut file, &body)?;
    file.sync_all()?;

    Ok(identity)
}

fn decode(bytes: &[u8]) -> Result<DeviceIdentity, IdentityError> {
    let stored: StoredIdentity = serde_json::from_slice(bytes)
        .map_err(|err| IdentityError::Corrupt(format!("malformed key ring: {err}")))?;
    if stored.version != RING_VERSION {
        return Err(IdentityError::UnknownVersion(stored.version));
    }
    let blob = BASE64
        .decode(stored.protected.as_bytes())
        .map_err(|err| IdentityError::Corrupt(format!("malformed protected blob: {err}")))?;
    let secret = unprotect(&blob)?;
    if secret.len() != SECRET_LEN {
        return Err(IdentityError::Corrupt(format!(
            "expected {SECRET_LEN} secret bytes, found {}",
            secret.len()
        )));
    }
    let mut fixed = Zeroizing::new([0u8; SECRET_LEN]);
    fixed.copy_from_slice(&secret);

    let identity = from_secret(&fixed, stored.created_at)?;
    // The public halves are stored in clear, so recomputing them from the secret is a free integrity
    // check: a mismatch means the file was edited or the wrong blob was unprotected.
    if identity.public.device_id != stored.device_id
        || identity.public.exchange_public != stored.exchange_public
    {
        return Err(IdentityError::Corrupt(
            "the stored public keys do not match the protected secret".into(),
        ));
    }
    Ok(identity)
}

fn from_secret(
    secret: &[u8; SECRET_LEN],
    created_at: u64,
) -> Result<DeviceIdentity, IdentityError> {
    let mut ed_seed = Zeroizing::new([0u8; 32]);
    ed_seed.copy_from_slice(&secret[..32]);
    let mut x_scalar = Zeroizing::new([0u8; 32]);
    x_scalar.copy_from_slice(&secret[32..]);

    let signing = SigningKey::from_bytes(&ed_seed);
    let exchange = ExchangeSecret::from(*x_scalar);
    let public = DeviceIdentityPublic {
        device_id: to_hex(&signing.verifying_key().to_bytes()),
        exchange_public: to_hex(ExchangePublic::from(&exchange).as_bytes()),
        created_at,
    };
    Ok(DeviceIdentity {
        signing,
        exchange,
        public,
    })
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// At-rest protection for any other collaborative secret — the project key ring uses it too.
pub(crate) fn protect_bytes(secret: &[u8]) -> Result<Vec<u8>, IdentityError> {
    protect(secret)
}

pub(crate) fn unprotect_bytes(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
    unprotect(blob)
}

/// The X25519 scalar of this device, loading the ring if needed.
pub(crate) fn exchange_secret_bytes() -> Result<Zeroizing<[u8; 32]>, IdentityError> {
    Ok(Zeroizing::new(get_or_init()?.exchange_scalar()))
}

#[cfg(windows)]
fn protect(secret: &[u8]) -> Result<Vec<u8>, IdentityError> {
    dpapi::run(secret, dpapi::Direction::Protect)
}

#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
    dpapi::run(blob, dpapi::Direction::Unprotect).map(Zeroizing::new)
}

#[cfg(not(windows))]
fn protect(_secret: &[u8]) -> Result<Vec<u8>, IdentityError> {
    Err(IdentityError::Unsupported)
}

#[cfg(not(windows))]
fn unprotect(_blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
    Err(IdentityError::Unsupported)
}

#[cfg(windows)]
mod dpapi {
    use super::{IdentityError, DPAPI_ENTROPY};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub enum Direction {
        Protect,
        Unprotect,
    }

    /// One body for both directions: the two DPAPI calls take and return the same blob shape, and
    /// the output buffer must be released with `LocalFree` either way.
    pub fn run(input: &[u8], direction: Direction) -> Result<Vec<u8>, IdentityError> {
        let input_blob = CRYPT_INTEGER_BLOB {
            cbData: input.len() as u32,
            pbData: input.as_ptr() as *mut u8,
        };
        let entropy_blob = CRYPT_INTEGER_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();

        // SAFETY: both input blobs point at live slices for the duration of the call, and the
        // output buffer allocated by DPAPI is copied then freed before returning.
        let result = unsafe {
            match direction {
                Direction::Protect => CryptProtectData(
                    &input_blob,
                    None,
                    Some(&entropy_blob),
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                ),
                Direction::Unprotect => CryptUnprotectData(
                    &input_blob,
                    None,
                    Some(&entropy_blob),
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                ),
            }
        };
        result.map_err(|err| IdentityError::Dpapi(err.message().to_string()))?;

        // SAFETY: DPAPI reports how many bytes it wrote and owns the buffer until `LocalFree`.
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_lowercase_and_fixed_width() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn an_unknown_format_is_refused_rather_than_rewritten() {
        let stored = StoredIdentity {
            version: RING_VERSION + 1,
            created_at: 0,
            device_id: String::new(),
            exchange_public: String::new(),
            protected: String::new(),
        };
        let bytes = serde_json::to_vec(&stored).expect("encode");
        match decode(&bytes) {
            Err(IdentityError::UnknownVersion(found)) => assert_eq!(found, RING_VERSION + 1),
            Err(other) => panic!("expected UnknownVersion, got {other:?}"),
            Ok(_) => panic!("a newer format must never yield an identity"),
        }
    }

    #[test]
    fn a_truncated_file_is_corrupt_not_a_new_identity() {
        match decode(b"{ not json") {
            Err(IdentityError::Corrupt(_)) => {}
            Err(other) => panic!("expected Corrupt, got {other:?}"),
            Ok(_) => panic!("a damaged file must never yield an identity"),
        }
    }

    #[test]
    fn identity_signs_a_complete_registration_proof() {
        let identity = from_secret(&[9_u8; SECRET_LEN], 42).expect("identity");
        let proof = identity
            .registration_proof("challenge", "account")
            .expect("registration proof");
        proof.verify().expect("valid proof");
        assert_eq!(proof.statement.device_id, identity.public().device_id);
        assert_eq!(proof.statement.endpoint_id, identity.public().device_id);
        assert_eq!(
            proof.statement.exchange_public,
            identity.public().exchange_public
        );
    }

    #[test]
    fn public_identity_serializes_for_the_typescript_contract() {
        let public = DeviceIdentityPublic {
            device_id: "device".into(),
            exchange_public: "exchange".into(),
            created_at: 42,
        };
        let value = serde_json::to_value(public).expect("serialize public identity");
        assert_eq!(value["deviceId"], "device");
        assert_eq!(value["exchangePublic"], "exchange");
        assert_eq!(value["createdAt"], 42);
        assert!(value.get("device_id").is_none());
    }
}
